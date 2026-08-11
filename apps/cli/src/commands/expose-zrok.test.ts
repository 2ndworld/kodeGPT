import { EventEmitter } from "node:events";

import { MCP_SURFACE_VERSION } from "@kodegpt/mcp-server";
import { describe, expect, it, vi } from "vitest";

import {
  exposeZrok,
  formatExposeZrokStatus,
  parseExposeZrokArguments,
  resolveZrokReservedName,
  type ExposeZrokDependencies,
  type SpawnedZrokProcess
} from "./expose-zrok.js";

const TEST_ISSUED_VALUE = "[REDACTED_SECRET]";
const RAW_FIELD_MARKER = "raw-zrok-field-marker";

class FakeZrokChild extends EventEmitter implements SpawnedZrokProcess {
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
    createdAt: "2026-08-11T00:00:00.000Z",
    rotatedAt: "2026-08-11T00:00:00.000Z"
  };
}

function issuedCredential() {
  return {
    token: TEST_ISSUED_VALUE,
    status: configuredStatus()
  };
}

function namesJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify([
    {
      name: "kodegpt-dev",
      namespaceName: "shares.example.test",
      namespaceToken: "public",
      reserved: true,
      ...overrides
    }
  ]);
}

function readySharesJson(options: {
  target?: string;
  shareMode?: string;
  backendMode?: string;
  frontendEndpoints?: string[];
} = {}) {
  return JSON.stringify({
    shares: [
      {
        target: options.target ?? "http://127.0.0.1:43121",
        shareMode: options.shareMode ?? "public",
        backendMode: options.backendMode ?? "proxy",
        frontendEndpoints: options.frontendEndpoints ?? ["kodegpt-dev.shares.example.test"],
        extraField: RAW_FIELD_MARKER
      }
    ]
  });
}

function makeDependencies(options: {
  configured?: boolean;
  startFailure?: Error;
  spawnFailure?: Error;
  rotateFailure?: Error;
  readinessResponses?: Array<string | Error>;
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
    zrokJson: [] as string[][],
    close: 0
  };
  const child = new FakeZrokChild();
  let readinessIndex = 0;
  const readinessResponses = options.readinessResponses ?? [readySharesJson()];

  const dependencies: ExposeZrokDependencies = {
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
          surfaceVersion: MCP_SURFACE_VERSION,
          runtimeVersion: "0.1.0",
          auditHealthy: true,
          filesystemBoundaryAvailable: true
        },
        close: async () => {
          calls.close += 1;
        }
      };
    },
    runZrokJson: async (args) => {
      calls.zrokJson.push([...args]);
      if (args[0] === "list" && args[1] === "names") {
        calls.order.push("list-names");
        return namesJson();
      }
      if (args[0] === "list" && args[1] === "shares") {
        calls.order.push("list-shares");
        const response = readinessResponses[Math.min(readinessIndex, readinessResponses.length - 1)];
        readinessIndex += 1;
        if (response instanceof Error) throw response;
        return response ?? JSON.stringify({ shares: [] });
      }
      throw new Error("unexpected zrok invocation");
    },
    spawnZrok: (command, args, spawnOptions) => {
      calls.order.push("spawn");
      if (options.spawnFailure !== undefined) throw options.spawnFailure;
      calls.spawn.push({ command, args, options: spawnOptions });
      return child;
    },
    delay: options.delay ?? (async () => undefined)
  };

  return { calls, child, dependencies };
}

describe("kodegpt expose zrok", () => {
  it("parses a reserved name selection and validates options", () => {
    expect(
      parseExposeZrokArguments([
        "--runtime",
        "/runtime",
        "--name",
        "public:kodegpt-dev",
        "--port",
        "43121",
        "--state-root",
        "/state"
      ])
    ).toEqual({
      runtimePath: "/runtime",
      name: "public:kodegpt-dev",
      port: 43121,
      stateRoot: "/state"
    });

    for (const args of [
      ["--runtime", "/runtime"],
      ["--name", "public:kodegpt-dev"],
      ["--runtime", "/runtime", "--name", "public"],
      ["--runtime", "/runtime", "--name", ":kodegpt-dev"],
      ["--runtime", "/runtime", "--name", "public:"],
      ["--runtime", "/runtime", "--name", "public:a:b"],
      ["--runtime", "/runtime", "--name", "https://example.test"],
      ["--runtime", "/runtime", "--name", "public:kodegpt dev"],
      ["--runtime", "/runtime", "--name", "public:kodegpt-dev/path"],
      ["--runtime", "/runtime", "--name", "public:kodegpt-dev?x=1"],
      ["--runtime", "/runtime", "--name", "public:kodegpt-dev#x"],
      ["--runtime", "/runtime", "--name", "public:user@host"],
      ["--runtime", "/runtime", "--name", "public:kodegpt-dev", "--port", "0"],
      ["--runtime", "/runtime", "--name", "public:kodegpt-dev", "--port", "65536"],
      ["--runtime", "/runtime", "--name", "public:kodegpt-dev", "--unknown", "x"],
      ["--runtime", "/runtime", "--name", "public:kodegpt-dev", "--name", "public:other"]
    ]) {
      expect(() => parseExposeZrokArguments(args)).toThrow();
    }
  });

  it("resolves exactly one reserved name and derives metadata fail-closed", () => {
    expect(resolveZrokReservedName("public:kodegpt-dev", namesJson())).toEqual({
      namespace: "public",
      name: "kodegpt-dev",
      namespaceName: "shares.example.test",
      reserved: true
    });

    for (const raw of [
      "not-json",
      JSON.stringify({ names: [] }),
      JSON.stringify([]),
      JSON.stringify([{ name: "kodegpt-dev", namespaceName: "shares.example.test", namespaceToken: "public", reserved: false }]),
      JSON.stringify([{ name: "kodegpt-dev", namespaceName: "", namespaceToken: "public", reserved: true }]),
      JSON.stringify([{ name: "kodegpt-dev", namespaceName: "bad host", namespaceToken: "public", reserved: true }]),
      JSON.stringify([
        { name: "kodegpt-dev", namespaceName: "shares.example.test", namespaceToken: "public", reserved: true },
        { name: "kodegpt-dev", namespaceName: "shares.example.test", namespaceToken: "public", reserved: true }
      ])
    ]) {
      expect(() => resolveZrokReservedName("public:kodegpt-dev", raw)).toThrow();
    }
  });

  it("starts exact loopback KodeGPT and zrok share before issuing first-run credential", async () => {
    const { calls, dependencies } = makeDependencies({
      configured: false,
      readinessResponses: [JSON.stringify({ shares: [] }), readySharesJson()]
    });
    const exposed = await exposeZrok(
      { runtimePath: "/runtime", stateRoot: "/state", name: "public:kodegpt-dev", port: 43121 },
      dependencies
    );

    expect(calls.order.slice(0, 7)).toEqual([
      "list-names", "status", "start", "spawn", "list-shares", "list-shares", "rotate"
    ]);
    expect(calls.start).toEqual([{
      runtimePath: "/runtime",
      stateRoot: "/state",
      port: 43121,
      publicUrl: "https://kodegpt-dev.shares.example.test/mcp",
      queryCredentialCompatibility: true,
      allowMissingConnectorCredential: true
    }]);
    expect(calls.spawn).toEqual([{
      command: "zrok2",
      args: [
        "share", "public", "http://127.0.0.1:43121", "--headless", "--force-local",
        "--backend-mode", "proxy", "-n", "public:kodegpt-dev"
      ],
      options: { shell: false, stdio: "inherit" }
    }]);
    expect(calls.zrokJson).toContainEqual(["list", "names", "-n", "public", "--json"]);
    expect(calls.zrokJson).toContainEqual([
      "list", "shares", "--target", "http://127.0.0.1:43121", "--share-mode", "public",
      "--backend-mode", "proxy", "--json"
    ]);
    expect(calls.rotate).toBe(1);
    const onboarding = new URL(exposed.status.chatgptServerUrl!);
    expect(onboarding.origin).toBe("https://kodegpt-dev.shares.example.test");
    expect(onboarding.pathname).toBe("/mcp");
    expect(onboarding.searchParams.get("kodegpt_token")).toBe(TEST_ISSUED_VALUE);
    await exposed.close();
  });

  it("warns that a newly issued ChatGPT Server URL is private", () => {
    const output = formatExposeZrokStatus({
      local: {
        host: "127.0.0.1",
        port: 43121,
        protocolVersion: "2026-07-28",
        surfaceVersion: MCP_SURFACE_VERSION,
        runtimeVersion: "0.1.0",
        auditHealthy: true,
        filesystemBoundaryAvailable: true
      },
      publicUrl: "https://kodegpt-dev.shares.example.test/mcp",
      chatgptServerUrl: "https://kodegpt-dev.shares.example.test/mcp?credential=[REDACTED_SECRET]",
      credentialCreated: true
    });
    expect(output).toContain("Keep this URL private");
    expect(output).toContain("shown only when newly issued");
  });

  it("reuses an existing connector verifier without revealing a token", async () => {
    const { calls, dependencies } = makeDependencies({ configured: true });
    const exposed = await exposeZrok(
      { runtimePath: "/runtime", stateRoot: "/state", name: "public:kodegpt-dev", port: 43121 },
      dependencies
    );
    expect(calls.rotate).toBe(0);
    expect(calls.start[0]?.allowMissingConnectorCredential).toBe(false);
    expect(exposed.status.credentialCreated).toBe(false);
    expect(exposed.status.chatgptServerUrl).toBeUndefined();
    const output = formatExposeZrokStatus(exposed.status);
    expect(output).toContain("existing connector credential");
    expect(output).not.toContain(TEST_ISSUED_VALUE);
    expect(output).not.toContain(RAW_FIELD_MARKER);
    await exposed.close();
  });

  it("never starts zrok or creates a credential when local startup fails", async () => {
    const { calls, dependencies } = makeDependencies({ configured: false, startFailure: new Error("local failed") });
    await expect(exposeZrok(
      { runtimePath: "/runtime", name: "public:kodegpt-dev", port: 43121 }, dependencies
    )).rejects.toThrow("local failed");
    expect(calls.spawn).toHaveLength(0);
    expect(calls.rotate).toBe(0);
  });

  it("closes KodeGPT without issuing a credential when zrok spawn fails", async () => {
    const { calls, dependencies } = makeDependencies({
      configured: false,
      spawnFailure: new Error("spawn failed")
    });
    await expect(exposeZrok(
      { runtimePath: "/runtime", name: "public:kodegpt-dev", port: 43121 }, dependencies
    )).rejects.toThrow(/zrok/i);
    expect(calls.rotate).toBe(0);
    expect(calls.close).toBe(1);
  });

  it("closes KodeGPT without issuing a credential when zrok exits before readiness", async () => {
    let releaseDelay!: () => void;
    const delay = () => new Promise<void>((resolve) => (releaseDelay = resolve));
    const { calls, child, dependencies } = makeDependencies({
      configured: false,
      readinessResponses: [JSON.stringify({ shares: [] })],
      delay
    });
    const pending = exposeZrok(
      { runtimePath: "/runtime", name: "public:kodegpt-dev", port: 43121 }, dependencies
    );
    await vi.waitFor(() => expect(calls.spawn).toHaveLength(1));
    child.emit("exit", 1, null);
    await expect(pending).rejects.toThrow(/zrok/i);
    expect(calls.rotate).toBe(0);
    expect(calls.close).toBe(1);
    releaseDelay();
  });

  it("closes KodeGPT without issuing a credential when zrok emits an error before readiness", async () => {
    let releaseDelay!: () => void;
    const delay = () => new Promise<void>((resolve) => (releaseDelay = resolve));
    const { calls, child, dependencies } = makeDependencies({
      configured: false,
      readinessResponses: [JSON.stringify({ shares: [] })],
      delay
    });
    const pending = exposeZrok(
      { runtimePath: "/runtime", name: "public:kodegpt-dev", port: 43121 }, dependencies
    );
    await vi.waitFor(() => expect(calls.spawn).toHaveLength(1));
    child.emit("error", new Error("raw child details"));
    await expect(pending).rejects.toThrow(/zrok/i);
    expect(calls.rotate).toBe(0);
    expect(calls.close).toBe(1);
    releaseDelay();
  });

  it("fails readiness without leaking raw zrok JSON and without issuing a credential", async () => {
    const { calls, child, dependencies } = makeDependencies({
      configured: false,
      readinessResponses: [readySharesJson({ frontendEndpoints: ["wrong.example.test"] })]
    });
    let caught: unknown;
    try {
      await exposeZrok(
        { runtimePath: "/runtime", name: "public:kodegpt-dev", port: 43121 }, dependencies
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/readiness/i);
    expect((caught as Error).message).not.toContain(RAW_FIELD_MARKER);
    expect(calls.rotate).toBe(0);
    expect(calls.close).toBe(1);
    expect(child.killedWith).toEqual(["SIGTERM"]);
  });

  it("closes zrok and KodeGPT if credential creation fails after readiness", async () => {
    const { calls, child, dependencies } = makeDependencies({
      configured: false,
      rotateFailure: new Error("credential failed")
    });
    await expect(exposeZrok(
      { runtimePath: "/runtime", name: "public:kodegpt-dev", port: 43121 }, dependencies
    )).rejects.toThrow("credential failed");
    expect(child.killedWith).toEqual(["SIGTERM"]);
    expect(calls.close).toBe(1);
  });

  it("surfaces unexpected zrok exit and closes idempotently", async () => {
    const { calls, child, dependencies } = makeDependencies();
    const exposed = await exposeZrok(
      { runtimePath: "/runtime", name: "public:kodegpt-dev", port: 43121 }, dependencies
    );
    child.emit("exit", 2, null);
    await expect(exposed.termination).rejects.toThrow(/zrok/i);
    await exposed.close();
    await exposed.close();
    expect(child.killedWith).toEqual(["SIGTERM"]);
    expect(calls.close).toBe(1);
  });
});
