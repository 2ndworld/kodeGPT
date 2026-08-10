import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  KernelClient,
  RuntimeUnavailableError
} from "../../packages/core/src/kernel-client.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TARGET = join(REPOSITORY_ROOT, "target", "task22-security");
const RUNTIME = join(TARGET, "debug", "kodegpt-runtime");
const temporaryRoots: string[] = [];

function buildRuntime(): void {
  const result = spawnSync(
    "cargo",
    ["build", "-p", "kodegpt-runtime", "--target-dir", TARGET],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitUntilDead(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`runtime pid ${pid} did not exit`);
}

beforeAll(() => buildRuntime(), 60_000);

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("full security acceptance invariants", () => {
  it("blocks new file.read and process.run requests after the kernel dies", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "kodegpt-task22-kernel-death-"));
    temporaryRoots.push(stateRoot);
    const wrapper = join(stateRoot, "runtime-wrapper.sh");
    const pidFile = join(stateRoot, "runtime.pid");
    await writeFile(
      wrapper,
      `#!/bin/sh\nprintf '%s\\n' "$$" > ${shellQuote(pidFile)}\nexec ${shellQuote(RUNTIME)}\n`,
      { mode: 0o755 }
    );
    await chmod(wrapper, 0o755);

    const client = await KernelClient.start({ runtimePath: wrapper, stateRoot });
    try {
      await expect(client.hello()).resolves.toMatchObject({ testMethods: false });
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
      process.kill(pid, "SIGKILL");
      await waitUntilDead(pid);

      for (const [method, params, requestId] of [
        ["file.read", { capabilityId: "kc_dead", path: "README.md", offset: 0, maxBytes: 1 }, "req_dead_file"],
        [
          "process.run",
          {
            capabilityId: "kc_dead",
            logicalExecutable: "python3",
            argv: [],
            cwd: ".",
            env: {},
            background: false
          },
          "req_dead_process"
        ]
      ] as const) {
        await expect(client.request(method, params, requestId)).rejects.toBeInstanceOf(
          RuntimeUnavailableError
        );
        await expect(client.request(method, params, `${requestId}_again`)).rejects.toMatchObject({
          code: "RUNTIME_UNAVAILABLE"
        });
      }
    } finally {
      await client.stop();
    }
  }, 15_000);

  it("has no TypeScript filesystem or user-process fallback behind workspace/process facades", async () => {
    const [workspaceManager, executionManager] = await Promise.all([
      readFile(join(REPOSITORY_ROOT, "packages/core/src/workspace-manager.ts"), "utf8"),
      readFile(join(REPOSITORY_ROOT, "packages/core/src/execution-manager.ts"), "utf8")
    ]);
    const facadeSource = `${workspaceManager}\n${executionManager}`;

    expect(facadeSource).not.toContain('from "node:fs');
    expect(facadeSource).not.toContain('from "node:child_process');
    expect(facadeSource).not.toMatch(/\b(?:spawn|exec|execFile|fork)\s*\(/);
    expect(facadeSource).toContain("kernel.request");
  });
});
