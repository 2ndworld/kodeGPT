import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { KernelClient, KernelRpcError } from "../../packages/core/src/kernel-client.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const runtimePath = join(root, "packages/runtime-linux-x64/bin/kodegpt-runtime");
const temporaryRoots: string[] = [];

beforeAll(() => {
  const build = spawnSync("cargo", ["build", "--release", "-p", "kodegpt-runtime"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  expect(build.error).toBeUndefined();
  expect(build.status, build.stderr).toBe(0);
  const stage = spawnSync(process.execPath, [join(root, "scripts/stage-runtime.mjs")], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
  expect(stage.error).toBeUndefined();
  expect(stage.status, stage.stderr).toBe(0);
}, 60_000);

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("packaged production runtime", () => {
  it("reports test methods disabled and rejects test.* RPCs", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "kodegpt-production-runtime-"));
    temporaryRoots.push(stateRoot);
    await mkdir(join(stateRoot, "logs/security"), { recursive: true });
    const client = await KernelClient.start({ runtimePath, stateRoot, enableTestMethods: true });
    try {
      const hello = await client.hello();
      expect(hello.testMethods).toBe(false);
      await expect(client.request("test.sleep", { delayMs: 1 })).rejects.toMatchObject<Partial<KernelRpcError>>({
        code: -32601
      });
    } finally {
      await client.stop();
    }
  });
});
