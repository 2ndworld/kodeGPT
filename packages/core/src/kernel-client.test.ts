import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DeveloperEnvironmentStore } from "./developer-environment-store.js";
import {
  KernelClient,
  KernelRpcError,
  RuntimeUnavailableError
} from "./kernel-client.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FEATURE_TARGET = join(REPOSITORY_ROOT, "target", "task3-feature");
const PRODUCTION_TARGET = join(REPOSITORY_ROOT, "target", "task3-production");
const FEATURE_RUNTIME = join(FEATURE_TARGET, "debug", "kodegpt-runtime");
const PRODUCTION_RUNTIME = join(PRODUCTION_TARGET, "debug", "kodegpt-runtime");
const temporaryRoots: string[] = [];

function buildRuntime(targetDir: string, featureEnabled: boolean): void {
  const args = [
    "build",
    "-p",
    "kodegpt-runtime",
    "--target-dir",
    targetDir
  ];
  if (featureEnabled) {
    args.push("--features", "runtime-test-methods");
  }

  const result = spawnSync("cargo", args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

async function stateRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for runtime pid file: ${path}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

beforeAll(() => {
  buildRuntime(FEATURE_TARGET, true);
  buildRuntime(PRODUCTION_TARGET, false);
}, 60_000);

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("KernelClient persistent runtime", () => {
  it("keeps hello responsive while a 500 ms test request is pending", async () => {
    const root = await stateRoot("kodegpt-task3-concurrency-");
    const client = await KernelClient.start({
      runtimePath: FEATURE_RUNTIME,
      stateRoot: root,
      enableTestMethods: true
    });

    try {
      const sleep = client.request<{ sleptMs: number }>(
        "test.sleep",
        { delayMs: 500 },
        "req_sleep_client"
      );
      const started = performance.now();
      const hello = await client.hello();
      const elapsed = performance.now() - started;

      expect(elapsed).toBeLessThan(200);
      expect(hello.runtimeVersion).toBe("0.1");
      expect(hello.testMethods).toBe(true);
      expect(hello.filesystemBoundaryAvailable).toBe(true);
      await expect(sleep).resolves.toEqual({ sleptMs: 500 });
    } finally {
      await client.stop();
    }
  }, 10_000);

  it("correlates out-of-order responses to their original promises", async () => {
    const root = await stateRoot("kodegpt-task3-correlation-");
    const client = await KernelClient.start({
      runtimePath: FEATURE_RUNTIME,
      stateRoot: root,
      enableTestMethods: true
    });

    try {
      const requests = [
        client.request<{ value: string }>("test.echo_after", { value: "A", delayMs: 120 }, "req_a"),
        client.request<{ value: string }>("test.echo_after", { value: "B", delayMs: 10 }, "req_b"),
        client.request<{ value: string }>("test.echo_after", { value: "C", delayMs: 60 }, "req_c")
      ];

      await expect(Promise.all(requests)).resolves.toEqual([
        { value: "A" },
        { value: "B" },
        { value: "C" }
      ]);
    } finally {
      await client.stop();
    }
  }, 10_000);

  it("rejects every pending request deterministically when the runtime dies", async () => {
    const root = await stateRoot("kodegpt-task3-death-");
    const wrapperPath = join(root, "runtime-wrapper.sh");
    const pidPath = join(root, "runtime.pid");
    await writeFile(
      wrapperPath,
      `#!/bin/sh\nprintf '%s\\n' "$$" > "$KODEGPT_STATE_ROOT/runtime.pid"\nexec ${shellQuote(FEATURE_RUNTIME)}\n`,
      { mode: 0o755 }
    );
    await chmod(wrapperPath, 0o755);

    const client = await KernelClient.start({
      runtimePath: wrapperPath,
      stateRoot: root,
      enableTestMethods: true
    });

    const pendingA = client.request("test.sleep", { delayMs: 5_000 }, "req_die_a");
    const pendingB = client.request("test.sleep", { delayMs: 5_000 }, "req_die_b");
    const unexpectedTermination = client.unexpectedTermination;
    const pid = await waitForPid(pidPath);
    process.kill(pid, "SIGKILL");

    for (const pending of [pendingA, pendingB]) {
      await expect(pending).rejects.toBeInstanceOf(RuntimeUnavailableError);
      await expect(pending).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    }
    await expect(unexpectedTermination).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE"
    });

    await client.stop();
  }, 10_000);

  it("bootstraps Node and Rust developer roots without passing resolver-specific env vars", async () => {
    expect(process.platform).toBe("linux");
    expect(process.arch).toBe("x64");
    const root = await stateRoot("kodegpt-developer-bootstrap-");
    const wrapperPath = join(root, "runtime-wrapper.sh");
    const observedPath = join(root, "resolver-env.txt");
    await writeFile(
      wrapperPath,
      `#!/bin/sh\nprintf '%s|%s\\n' "\${KODEGPT_HOST_NODE_ROOT-unset}" "\${KODEGPT_HOST_RUST_TOOLCHAIN_ROOT-unset}" > "$KODEGPT_STATE_ROOT/resolver-env.txt"\nexec ${shellQuote(FEATURE_RUNTIME)}\n`,
      { mode: 0o755 }
    );
    await chmod(wrapperPath, 0o755);

    const client = await KernelClient.start({
      runtimePath: wrapperPath,
      stateRoot: root,
      enableTestMethods: true
    });

    try {
      expect((await client.hello()).testMethods).toBe(true);
      await expect(readFile(observedPath, "utf8")).resolves.toBe("unset|unset\n");
      const entries = await new DeveloperEnvironmentStore(root).list();
      const expectedBootstrap = [
        {
          label: "Node runtime",
          source: "bootstrap",
          canonicalRoot: dirname(dirname(process.execPath)),
          executableDirs: ["bin"]
        }
      ];
      const rustRoot = join(
        homedir(),
        ".rustup",
        "toolchains",
        "stable-x86_64-unknown-linux-gnu"
      );
      if (await stat(rustRoot).then((metadata) => metadata.isDirectory()).catch(() => false)) {
        expectedBootstrap.push({
          label: "Rust stable toolchain",
          source: "bootstrap",
          canonicalRoot: rustRoot,
          executableDirs: ["bin"]
        });
      }
      expect(entries.map(({ label, source, canonicalRoot, executableDirs }) => ({
        label,
        source,
        canonicalRoot,
        executableDirs
      }))).toEqual(expectedBootstrap);
    } finally {
      await client.stop();
    }
  }, 10_000);

  it("keeps test methods unavailable when the feature build is not explicitly enabled", async () => {
    const root = await stateRoot("kodegpt-task3-disabled-");
    const client = await KernelClient.start({
      runtimePath: FEATURE_RUNTIME,
      stateRoot: root,
      enableTestMethods: false
    });

    try {
      expect((await client.hello()).testMethods).toBe(false);
      await expect(client.request("test.echo_after", { value: "x", delayMs: 0 })).rejects.toMatchObject({
        code: -32601,
        message: "METHOD_NOT_FOUND"
      });
    } finally {
      await client.stop();
    }
  }, 10_000);

  it("proves the production runtime does not compile test RPC behavior", async () => {
    const root = await stateRoot("kodegpt-task3-production-");
    const client = await KernelClient.start({
      runtimePath: PRODUCTION_RUNTIME,
      stateRoot: root,
      enableTestMethods: true
    });

    try {
      expect((await client.hello()).testMethods).toBe(false);
      const request = client.request("test.echo_after", { value: "x", delayMs: 0 });
      await expect(request).rejects.toBeInstanceOf(KernelRpcError);
      await expect(request).rejects.toMatchObject({ code: -32601, message: "METHOD_NOT_FOUND" });
    } finally {
      await client.stop();
    }
  }, 10_000);
});
