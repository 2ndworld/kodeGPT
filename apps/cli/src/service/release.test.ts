import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  materializeServiceRelease,
  verifyServiceRelease,
  type MaterializeServiceReleaseInput
} from "./release.js";

const roots: string[] = [];

async function fixture(): Promise<MaterializeServiceReleaseInput> {
  const root = await mkdtemp(join(tmpdir(), "kodegpt-service-release-"));
  roots.push(root);
  const source = join(root, "source");
  const runtimePackageRoot = join(source, "runtime");
  const yamlPackageRoot = join(source, "yaml");
  const serviceDataRoot = join(root, "service-data");
  const cliPath = join(source, "kodegpt.mjs");
  await mkdir(join(runtimePackageRoot, "bin"), { recursive: true });
  await mkdir(yamlPackageRoot, { recursive: true });
  await writeFile(cliPath, "#!/usr/bin/env node\nconsole.log('release-a');\n", { mode: 0o755 });
  await writeFile(
    join(runtimePackageRoot, "package.json"),
    JSON.stringify({ name: "@kodegpt/runtime-linux-x64", version: "0.1.0" }),
    "utf8"
  );
  await writeFile(join(runtimePackageRoot, "bin", "kodegpt-runtime"), "runtime-a", { mode: 0o755 });
  await writeFile(join(yamlPackageRoot, "package.json"), JSON.stringify({ name: "yaml", version: "2.9.0" }), "utf8");
  await writeFile(join(yamlPackageRoot, "index.js"), "export default {};\n", "utf8");
  return {
    serviceDataRoot,
    cliPath,
    runtimePackageRoot,
    yamlPackageRoot,
    nodePath: "/opt/node/bin/node",
    zrokPath: "/opt/zrok/bin/zrok2",
    reservedName: "public:kodegpt-dev",
    port: 43_121,
    packageVersion: "0.1.0"
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("immutable KodeGPT service releases", () => {
  it("derives the same release identity from the same CLI and runtime bytes", async () => {
    const input = await fixture();
    const first = await materializeServiceRelease(input);
    const second = await materializeServiceRelease(input);

    expect(second).toEqual(first);
    expect(first.releaseId).toMatch(/^rel_[a-f0-9]{32}$/);
    expect(first.packageVersion).toBe("0.1.0");
    expect(first.runtimePackage).toBe("@kodegpt/runtime-linux-x64");
    expect(first.cliPath).toBe(join(first.releaseRoot, "bin", "kodegpt.mjs"));
    expect(first.runtimePath).toBe(
      join(first.releaseRoot, "node_modules", "@kodegpt", "runtime-linux-x64", "bin", "kodegpt-runtime")
    );
    expect((await stat(first.cliPath)).mode & 0o111).not.toBe(0);
    expect((await stat(first.runtimePath)).mode & 0o111).not.toBe(0);
    await access(join(first.releaseRoot, "node_modules", "yaml", "package.json"));
  });

  it("changes release identity when CLI or runtime bytes change", async () => {
    const input = await fixture();
    const first = await materializeServiceRelease(input);

    await writeFile(input.cliPath, "#!/usr/bin/env node\nconsole.log('release-b');\n", { mode: 0o755 });
    const cliChanged = await materializeServiceRelease(input);
    expect(cliChanged.releaseId).not.toBe(first.releaseId);

    await writeFile(join(input.runtimePackageRoot, "bin", "kodegpt-runtime"), "runtime-b", { mode: 0o755 });
    const runtimeChanged = await materializeServiceRelease(input);
    expect(runtimeChanged.releaseId).not.toBe(cliChanged.releaseId);
  });

  it("fails closed instead of overwriting a corrupted existing release", async () => {
    const input = await fixture();
    const release = await materializeServiceRelease(input);
    await writeFile(release.runtimePath, "tampered-runtime", { mode: 0o755 });

    await expect(verifyServiceRelease(release)).rejects.toThrow(/runtime digest mismatch/);
    await expect(materializeServiceRelease(input)).rejects.toThrow(/existing service release failed verification/);
    expect(await readFile(release.runtimePath, "utf8")).toBe("tampered-runtime");
  });
});
