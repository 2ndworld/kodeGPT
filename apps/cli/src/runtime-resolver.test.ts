import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RuntimeResolutionError,
  resolveRuntimePath
} from "./runtime-resolver.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime resolver", () => {
  it("resolves the package-owned Linux x64 runtime and never searches PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "kodegpt-runtime-resolver-"));
    roots.push(root);
    const packageJson = join(root, "node_modules/@kodegpt/runtime-linux-x64/package.json");
    const executable = join(root, "node_modules/@kodegpt/runtime-linux-x64/bin/kodegpt-runtime");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "node_modules/@kodegpt/runtime-linux-x64/bin"), { recursive: true }));
    await writeFile(packageJson, "{}\n");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);

    expect(
      await resolveRuntimePath({
        platform: "linux",
        arch: "x64",
        env: { PATH: "/malicious/path" },
        resolvePackageJson: () => packageJson
      })
    ).toBe(executable);
  });

  it("permits explicit runtime override only for development/tests", async () => {
    const root = await mkdtemp(join(tmpdir(), "kodegpt-runtime-override-"));
    roots.push(root);
    const executable = join(root, "runtime");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);

    await expect(
      resolveRuntimePath({ platform: "linux", arch: "x64", env: { KODEGPT_RUNTIME_PATH: executable } })
    ).rejects.toBeInstanceOf(RuntimeResolutionError);
    expect(
      await resolveRuntimePath({
        platform: "linux",
        arch: "x64",
        env: { KODEGPT_RUNTIME_PATH: executable, NODE_ENV: "test" }
      })
    ).toBe(executable);
  });
});
