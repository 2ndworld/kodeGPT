import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { materializeServiceRelease, type MaterializeServiceReleaseInput } from "./release.js";

const roots: string[] = [];

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function pairId(cliSha256: string, runtimeSha256: string): string {
  return `pair_${createHash("sha256")
    .update(cliSha256)
    .update("\0")
    .update(runtimeSha256)
    .digest("hex")
    .slice(0, 32)}`;
}

async function fixture(): Promise<MaterializeServiceReleaseInput> {
  const root = await mkdtemp(join(tmpdir(), "kodegpt-service-provenance-"));
  roots.push(root);
  const source = join(root, "source");
  const runtimePackageRoot = join(source, "runtime");
  const yamlPackageRoot = join(source, "yaml");
  const playwrightCorePackageRoot = join(source, "playwright-core");
  const serviceDataRoot = join(root, "service-data");
  const cliPath = join(source, "kodegpt.mjs");
  const cliBytes = "#!/usr/bin/env node\nconsole.log('release-a');\n";
  const runtimeBytes = "runtime-a";

  await mkdir(join(runtimePackageRoot, "bin"), { recursive: true });
  await mkdir(yamlPackageRoot, { recursive: true });
  await mkdir(playwrightCorePackageRoot, { recursive: true });
  await writeFile(cliPath, cliBytes, { mode: 0o755 });
  await writeFile(
    join(runtimePackageRoot, "package.json"),
    JSON.stringify({ name: "@kodegpt/runtime-linux-x64", version: "0.1.0" }),
    "utf8"
  );
  await writeFile(join(runtimePackageRoot, "bin", "kodegpt-runtime"), runtimeBytes, { mode: 0o755 });
  await writeFile(join(yamlPackageRoot, "package.json"), JSON.stringify({ name: "yaml", version: "2.9.0" }), "utf8");
  await writeFile(join(yamlPackageRoot, "index.js"), "export default {};\n", "utf8");
  await writeFile(
    join(playwrightCorePackageRoot, "package.json"),
    JSON.stringify({ name: "playwright-core", version: "1.62.1" }),
    "utf8"
  );
  await writeFile(join(playwrightCorePackageRoot, "index.js"), "module.exports = {};\n", "utf8");

  const cliSha256 = sha256(cliBytes);
  const runtimeSha256 = sha256(runtimeBytes);
  const provenance = {
    schemaVersion: 1,
    pairId: pairId(cliSha256, runtimeSha256),
    sourceRevision: "7ea156e76abf46bc078d183f8748206c1ce15052",
    sourceDirty: false,
    runtimePackage: "@kodegpt/runtime-linux-x64",
    cliSha256,
    runtimeSha256
  };
  const provenanceText = `${JSON.stringify(provenance, null, 2)}\n`;
  await writeFile(join(source, "kodegpt.provenance.json"), provenanceText, "utf8");
  await writeFile(join(runtimePackageRoot, "provenance.json"), provenanceText, "utf8");

  return {
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
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("service artifact provenance", () => {
  it("rejects runtime bytes that do not match the CLI/runtime provenance pair before creating release data", async () => {
    const input = await fixture();
    await writeFile(join(input.runtimePackageRoot, "bin", "kodegpt-runtime"), "runtime-b", { mode: 0o755 });

    await expect(materializeServiceRelease(input)).rejects.toThrow(/service artifact provenance/i);
    await expect(access(input.serviceDataRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects missing provenance before creating release data", async () => {
    const input = await fixture();
    await rm(join(dirname(input.cliPath), "kodegpt.provenance.json"));

    await expect(materializeServiceRelease(input)).rejects.toThrow(/service artifact provenance.*missing or invalid/i);
    await expect(access(input.serviceDataRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects valid manifests that disagree about the artifact pair", async () => {
    const input = await fixture();
    const runtimeProvenancePath = join(input.runtimePackageRoot, "provenance.json");
    const runtimeProvenance = JSON.parse(await readFile(runtimeProvenancePath, "utf8")) as Record<string, unknown>;
    runtimeProvenance.sourceDirty = true;
    await writeFile(runtimeProvenancePath, `${JSON.stringify(runtimeProvenance, null, 2)}\n`, "utf8");

    await expect(materializeServiceRelease(input)).rejects.toThrow(/service artifact provenance.*do not match/i);
    await expect(access(input.serviceDataRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects provenance with fields outside the closed schema", async () => {
    const input = await fixture();
    const cliProvenancePath = join(dirname(input.cliPath), "kodegpt.provenance.json");
    const runtimeProvenancePath = join(input.runtimePackageRoot, "provenance.json");
    const provenance = JSON.parse(await readFile(cliProvenancePath, "utf8")) as Record<string, unknown>;
    provenance.unexpected = "field";
    const text = `${JSON.stringify(provenance, null, 2)}\n`;
    await writeFile(cliProvenancePath, text, "utf8");
    await writeFile(runtimeProvenancePath, text, "utf8");

    await expect(materializeServiceRelease(input)).rejects.toThrow(/service artifact provenance.*missing or invalid/i);
    await expect(access(input.serviceDataRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
