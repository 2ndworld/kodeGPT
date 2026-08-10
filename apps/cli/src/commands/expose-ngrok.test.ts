import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  exposeNgrok,
  formatExposeNgrokStatus,
  parseExposeNgrokArguments,
  type ExposeNgrokDependencies,
  type SpawnedNgrokProcess
} from "./expose-ngrok.js";

const TEST_ISSUED_VALUE = "[REDACTED_SECRET]";

class FakeNgrokChild extends EventEmitter implements SpawnedNgrokProcess {
  readonly killedWith: NodeJS.Signals[] = [];

  override once(event: "error", listener: (error: Error) => void): this;
  override once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  override once(event: string, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killedWith.push(signal);
    return true;
  }
}

function configuredStatus() {
  return {
    configured: true as const,
    id: "test-id",
    createdAt: "2026-08-10T00:00:00.000Z",
    rotatedAt: "2026-08-10T00:00:00.000Z"
  };
}

function issuedCredential() {
  return {
    token: TEST_ISSUED_VALUE,
    status: configuredStatus()
  };
}

function makeDependencies(options: {
  configured?: boolean;
  startFailure?: Error;
  rotateFailure?: Error;
  delay?: () => Promise<void>;
} = {}) {
  const calls = {
    status: 0,
    rotate: 0,
    order: [] as string[],
    start: [] as Array<Record<string, unknown>>,
    spawn: [] as Array<{
      command: string;
      args: string[];
      options: { shell: false; stdio: "inherit" };
    }>,
    close: 0
  };
  const child = new FakeNgrokChild();
  const dependencies: ExposeNgrokDependencies = {
    createCredentialStore: () => ({
      status: async () => {
        calls.status += 1;
        calls.order.push("status");
        return options.configured === false ? { configured: false as const } : configuredStatus();
      },
      rotate: async () => {
        calls.rotate += 1;
        calls.order.push("rotate");
        if (options.rotateFailure !== undefined) throw options.rotateFailure;
        return issuedCredential();
      }
    }),
    startKodegpt: async (startOptions) => {
      calls.order.push("start");
      calls.start.push(startOptions as unknown as Record<string, unknown>);
      if (options.startFailure !== undefined) throw options.startFailure;
      return {
        status: {
          host: "127.0.0.1",
          port: startOptions.port ?? 43121,
          protocolVersion: "2026-07-28",
          surfaceVersion: "0.1",
          runtimeVersion: "0.1.0",
          auditHealthy: true,
          filesystemBoundaryAvailable: true
        },
        close: async () => {
          calls.close += 1;
        }
      };
    },
    spawnNgrok: (command, args, spawnOptions) => {
      calls.order.push("spawn");
      calls.spawn.push({ command, args, options: spawnOptions });
      return child;
    },
    delay: options.delay ?? (async () => undefined)
  };
  return { calls, child, dependencies };
}

describe("kodegpt expose ngrok", () => {
  it("parses only a stable hostname and normalizes it", () => {
    expect(
      parseExposeNgrokArguments([
        "--runtime",
        "/runtime",
        "--hostname",
        "My-KodeGPT.Ngrok-Free.Dev",
        "--port",
        "43121",
        "--state-root",
        "/state"
      ])
    ).toEqual({
      runtimePath: "/runtime",
      hostname: "my-kodegpt.ngrok-free.dev",
      port: 43121,
      stateRoot: "/state"
    });

    for (const args of [
      ["--runtime", "/runtime"],
      ["--hostname", "host.example"],
      ["--runtime", "/runtime", "--hostname", "https://host.example"],
      ["--runtime", "/runtime", "--hostname", "host.example/mcp"],
      ["--runtime", "/runtime", "--hostname", "user@host.example"],
      ["--runtime", "/runtime", "--hostname", "host.example?x=1"],
      ["--runtime", "/runtime", "--hostname", "host.example#fragment"],
      ["--runtime", "/runtime", "--hostname", "-host.example"],
      ["--runtime", "/runtime", "--hostname", "host-.example"],
      ["--runtime", "/runtime", "--hostname", "host..example"],
      ["--runtime", "/runtime", "--hostname", "localhost"],
      ["--runtime", "/runtime", "--hostname", "host.example", "--port", "0"],
      ["--runtime", "/runtime", "--hostname", "host.example", "--port", "65536"],
      ["--runtime", "/runtime", "--hostname", "host.example", "--unknown", "x"],
      [
        "--runtime",
        "/runtime",
        "--hostname",
        "host.example",
        "--hostname",
        "other.example"
      ]
    ]) {
      expect(() => parseExposeNgrokArguments(args)).toThrow();
    }
  });

  it("creates a connector credential only on first exposure", async () => {
    const first = makeDependencies({ configured: false });
    const firstExposure = await exposeNgrok(
      {
        runtimePath: "/runtime",
        stateRoot: "/state",
        hostname: "host.example",
        port: 43121
      },
      first.dependencies
    );
    expect(first.calls.status).toBe(1);
    expect(first.calls.rotate).toBe(1);
    expect(first.calls.order.slice(0, 4)).toEqual(["status", "start", "spawn", "rotate"]);
    expect(first.calls.start[0]?.allowMissingConnectorCredential).toBe(true);
    expect(firstExposure.status.credentialCreated).toBe(true);
    const onboarding = new URL(firstExposure.status.chatgptServerUrl!);
    expect(onboarding.origin).toBe("https://host.example");
    expect(onboarding.pathname).toBe("/mcp");
    expect(onboarding.searchParams.get("kodegpt_token")).toBe(TEST_ISSUED_VALUE);
    await firstExposure.close();

    const existing = makeDependencies({ configured: true });
    const laterExposure = await exposeNgrok(
      {
        runtimePath: "/runtime",
        stateRoot: "/state",
        hostname: "host.example",
        port: 43121
      },
      existing.dependencies
    );
    expect(existing.calls.rotate).toBe(0);
    expect(laterExposure.status.credentialCreated).toBe(false);
    expect(laterExposure.status.chatgptServerUrl).toBeUndefined();
    await laterExposure.close();
  });

  it("starts loopback KodeGPT before ngrok with exact public trust and argv", async () => {
    const { calls, dependencies } = makeDependencies();
    const exposed = await exposeNgrok(
      {
        runtimePath: "/runtime",
        stateRoot: "/state",
        hostname: "host.example",
        port: 43121
      },
      dependencies
    );

    expect(calls.start).toEqual([
      {
        runtimePath: "/runtime",
        stateRoot: "/state",
        port: 43121,
        publicUrl: "https://host.example/mcp",
        queryCredentialCompatibility: true,
        allowMissingConnectorCredential: false
      }
    ]);
    expect(calls.spawn).toEqual([
      {
        command: "ngrok",
        args: ["http", "http://127.0.0.1:43121", "--url", "https://host.example"],
        options: { shell: false, stdio: "inherit" }
      }
    ]);
    await exposed.close();
  });

  it("never creates a first-run credential or starts ngrok when local KodeGPT startup fails", async () => {
    const { calls, dependencies } = makeDependencies({
      configured: false,
      startFailure: new Error("local failed")
    });
    await expect(
      exposeNgrok(
        { runtimePath: "/runtime", hostname: "host.example", port: 43121 },
        dependencies
      )
    ).rejects.toThrow("local failed");
    expect(calls.rotate).toBe(0);
    expect(calls.spawn).toHaveLength(0);
  });

  it("closes KodeGPT without persisting a first-run credential when ngrok exits during startup grace", async () => {
    let releaseDelay!: () => void;
    const delay = () => new Promise<void>((resolve) => (releaseDelay = resolve));
    const { calls, child, dependencies } = makeDependencies({ configured: false, delay });
    const pending = exposeNgrok(
      { runtimePath: "/runtime", hostname: "host.example", port: 43121 },
      dependencies
    );
    await vi.waitFor(() => expect(calls.spawn).toHaveLength(1));
    child.emit("exit", 1, null);
    await expect(pending).rejects.toThrow(/ngrok/i);
    expect(calls.rotate).toBe(0);
    expect(calls.close).toBe(1);
    releaseDelay();
  });

  it("closes ngrok and KodeGPT if first-run credential creation fails after startup", async () => {
    const { calls, child, dependencies } = makeDependencies({
      configured: false,
      rotateFailure: new Error("credential failed")
    });
    await expect(
      exposeNgrok(
        { runtimePath: "/runtime", hostname: "host.example", port: 43121 },
        dependencies
      )
    ).rejects.toThrow("credential failed");
    expect(child.killedWith).toEqual(["SIGTERM"]);
    expect(calls.close).toBe(1);
  });

  it("surfaces unexpected ngrok exit and closes idempotently", async () => {
    const { calls, child, dependencies } = makeDependencies();
    const exposed = await exposeNgrok(
      { runtimePath: "/runtime", hostname: "host.example", port: 43121 },
      dependencies
    );

    child.emit("exit", 2, null);
    await expect(exposed.termination).rejects.toThrow(/ngrok/i);
    await exposed.close();
    await exposed.close();
    expect(child.killedWith).toEqual(["SIGTERM"]);
    expect(calls.close).toBe(1);
  });

  it("formats first-run and existing-credential status without unrelated secret fields", async () => {
    const first = makeDependencies({ configured: false });
    const firstExposure = await exposeNgrok(
      { runtimePath: "/runtime", hostname: "host.example", port: 43121 },
      first.dependencies
    );
    const firstOutput = formatExposeNgrokStatus(firstExposure.status);
    expect(firstOutput).toContain("KodeGPT exposure ready");
    expect(firstOutput).toContain("ChatGPT Server URL:");
    expect(firstOutput).not.toMatch(/verifier|ngrok.*credential/i);
    await firstExposure.close();

    const later = makeDependencies({ configured: true });
    const laterExposure = await exposeNgrok(
      { runtimePath: "/runtime", hostname: "host.example", port: 43121 },
      later.dependencies
    );
    const laterOutput = formatExposeNgrokStatus(laterExposure.status);
    expect(laterOutput).toContain("existing connector credential");
    expect(laterOutput).not.toContain(TEST_ISSUED_VALUE);
    await laterExposure.close();
  });
});
