import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupServiceReleases,
  materializeServiceRelease,
  verifyServiceRelease,
  type MaterializeServiceReleaseInput
} from "./release.js";

const roots: string[] = [];
const TEST_SOURCE_REVISION = "7ea156e76abf46bc078d183f8748206c1ce15052";

async function fixture(): Promise<MaterializeServiceReleaseInput> {
  const root = await mkdtemp(join(tmpdir(), "kodegpt-service-release-"));
  roots.push(root);
  const source = join(root, "source");
  const runtimePackageRoot = join(source, "runtime");
  const yamlPackageRoot = join(source, "yaml");
  const playwrightCorePackageRoot = join(source, "playwright-core");
  const serviceDataRoot = join(root, "service-data");
  const cliPath = join(source, "kodegpt.mjs");
  await mkdir(join(runtimePackageRoot, "bin"), { recursive: true });
  await mkdir(yamlPackageRoot, { recursive: true });
  await mkdir(playwrightCorePackageRoot, { recursive: true });
  await writeFile(cliPath, "#!/usr/bin/env node\nconsole.log('release-a');\n", { mode: 0o755 });
  await writeFile(
    join(runtimePackageRoot, "package.json"),
    JSON.stringify({ name: "@kodegpt/runtime-linux-x64", version: "0.1.0" }),
    "utf8"
  );
  await writeFile(join(runtimePackageRoot, "bin", "kodegpt-runtime"), "runtime-a", { mode: 0o755 });
  await writeFile(join(yamlPackageRoot, "package.json"), JSON.stringify({ name: "yaml", version: "2.9.0" }), "utf8");
  await writeFile(join(yamlPackageRoot, "index.js"), "export default {};\n", "utf8");
  await writeFile(
    join(playwrightCorePackageRoot, "package.json"),
    JSON.stringify({ name: "playwright-core", version: "1.62.1" }),
    "utf8"
  );
  await writeFile(join(playwrightCorePackageRoot, "index.js"), "module.exports = {};\n", "utf8");
  const input: MaterializeServiceReleaseInput = {
    serviceDataRoot,
    cliPath,
    runtimePackageRoot,
    yamlPackageRoot,
    playwrightCorePackageRoot,
    nodePath: "/opt/node/bin/node",
    zrokPath: "/opt/zrok/bin/zrok2",
    reservedName: "public:kodegpt-dev",
    port: 43_121,
    packageVersion: "0.1.0"
  };
  await refreshProvenance(input);
  return input;
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
    await access(join(first.releaseRoot, "bin", "kodegpt.provenance.json"));
    await access(join(first.releaseRoot, "node_modules", "@kodegpt", "runtime-linux-x64", "provenance.json"));
    await access(join(first.releaseRoot, "node_modules", "yaml", "package.json"));
    await access(join(first.releaseRoot, "node_modules", "playwright-core", "package.json"));
  });

  it("fails verification when the staged Playwright package identity changes", async () => {
    const input = await fixture();
    const release = await materializeServiceRelease(input);
    await writeFile(
      join(release.releaseRoot, "node_modules", "playwright-core", "package.json"),
      JSON.stringify({ name: "playwright-core", version: "0.0.0" }),
      "utf8"
    );

    await expect(verifyServiceRelease(release)).rejects.toThrow(/package identity mismatch.*playwright-core/i);
  });

  it("changes release identity when CLI or runtime bytes change", async () => {
    const input = await fixture();
    const first = await materializeServiceRelease(input);

    await writeFile(input.cliPath, "#!/usr/bin/env node\nconsole.log('release-b');\n", { mode: 0o755 });
    await refreshProvenance(input);
    const cliChanged = await materializeServiceRelease(input);
    expect(cliChanged.releaseId).not.toBe(first.releaseId);

    await writeFile(join(input.runtimePackageRoot, "bin", "kodegpt-runtime"), "runtime-b", { mode: 0o755 });
    await refreshProvenance(input);
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

  it("removes only obsolete service releases while preserving active, staged, and rollback", async () => {
    const input = await fixture();
    const releaseA = await materializeServiceRelease(input);
    await writeFile(input.cliPath, "#!/usr/bin/env node\nconsole.log('release-b');\n", { mode: 0o755 });
    await refreshProvenance(input);
    const releaseB = await materializeServiceRelease(input);
    await writeFile(input.cliPath, "#!/usr/bin/env node\nconsole.log('release-c');\n", { mode: 0o755 });
    await refreshProvenance(input);
    const releaseC = await materializeServiceRelease(input);
    await writeFile(input.cliPath, "#!/usr/bin/env node\nconsole.log('release-d');\n", { mode: 0o755 });
    await refreshProvenance(input);
    const releaseD = await materializeServiceRelease(input);

    await cleanupServiceReleases(input.serviceDataRoot, {
      schemaVersion: 1,
      unitName: "kodegpt.service",
      activeReleaseId: releaseA.releaseId,
      stagedReleaseId: releaseB.releaseId,
      rollbackReleaseId: releaseC.releaseId,
      releases: {
        [releaseA.releaseId]: releaseA,
        [releaseB.releaseId]: releaseB,
        [releaseC.releaseId]: releaseC,
        [releaseD.releaseId]: releaseD
      }
    });

    await expect(access(releaseA.releaseRoot)).resolves.toBeUndefined();
    await expect(access(releaseB.releaseRoot)).resolves.toBeUndefined();
    await expect(access(releaseC.releaseRoot)).resolves.toBeUndefined();
    await expect(access(releaseD.releaseRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects cleanup when retained metadata points outside the owned releases root", async () => {
    const input = await fixture();
    const release = await materializeServiceRelease(input);
    const escaped = { ...release, releaseRoot: join(input.serviceDataRoot, "..", "escaped") };

    await expect(
      cleanupServiceReleases(input.serviceDataRoot, {
        schemaVersion: 1,
        unitName: "kodegpt.service",
        activeReleaseId: escaped.releaseId,
        releases: { [escaped.releaseId]: escaped }
      })
    ).rejects.toThrow(/release root escapes service-owned directory/);
  });
});

async function refreshProvenance(input: MaterializeServiceReleaseInput): Promise<void> {
  const cliBytes = await readFile(input.cliPath);
  const runtimeBytes = await readFile(join(input.runtimePackageRoot, "bin", "kodegpt-runtime"));
  const cliSha256 = sha256(cliBytes);
  const runtimeSha256 = sha256(runtimeBytes);
  const provenance = {
    schemaVersion: 1,
    pairId: pairId(cliSha256, runtimeSha256),
    sourceRevision: TEST_SOURCE_REVISION,
    sourceDirty: false,
    runtimePackage: "@kodegpt/runtime-linux-x64",
    cliSha256,
    runtimeSha256
  };
  const text = `${JSON.stringify(provenance, null, 2)}\n`;
  await writeFile(join(dirname(input.cliPath), "kodegpt.provenance.json"), text, "utf8");
  await writeFile(join(input.runtimePackageRoot, "provenance.json"), text, "utf8");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function pairId(cliSha256: string, runtimeSha256: string): string {
  return `pair_${createHash("sha256")
    .update(cliSha256)
    .update("\0")
    .update(runtimeSha256)
    .digest("hex")
    .slice(0, 32)}`;
}
