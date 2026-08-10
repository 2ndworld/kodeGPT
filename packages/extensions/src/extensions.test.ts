import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ExtensionManifestError,
  loadExtensionManifest,
  parseExtensionManifest
} from "./manifest-schema.js";
import { ExtensionRegistry, ExtensionRegistryError } from "./registry.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kodegpt-extensions-"));
  roots.push(root);
  return root;
}

function manifest(id = "docs.fixture") {
  return {
    schemaVersion: 1,
    id,
    name: "Docs Fixture",
    version: "1.0.0",
    description: "Documentation and policy-only extension.",
    capabilities: {
      documentation: { summary: "Safe documentation" },
      profileRestrictions: { maxProfile: "develop", denyNetwork: true }
    }
  } as const;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("extension manifest schema", () => {
  it("accepts only documentation/profile restriction manifests and rejects executable or unknown fields", () => {
    expect(parseExtensionManifest(manifest())).toMatchObject({ id: "docs.fixture", schemaVersion: 1 });
    for (const field of ["main", "module", "script", "command", "html", "javascript", "entrypoint"]) {
      expect(() => parseExtensionManifest({ ...manifest(), [field]: "./payload.js" })).toThrow(
        ExtensionManifestError
      );
    }
    expect(() => parseExtensionManifest({ ...manifest(), unknownCapability: true })).toThrow(
      ExtensionManifestError
    );
  });

  it("loads JSON without importing or executing adjacent JavaScript", async () => {
    const root = await tempRoot();
    const marker = join(root, "executed.marker");
    await writeFile(join(root, "extension.json"), JSON.stringify(manifest()));
    await writeFile(
      join(root, "payload.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");`
    );

    const loaded = await loadExtensionManifest(join(root, "extension.json"));
    expect(loaded.id).toBe("docs.fixture");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("ExtensionRegistry", () => {
  it("persists schemaVersion 1 and returns bounded public metadata without host paths", async () => {
    const root = await tempRoot();
    const registry = await ExtensionRegistry.open(root);
    await registry.enable(parseExtensionManifest(manifest()));

    const listed = registry.listEnabled(500);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: "docs.fixture", enabled: true, schemaVersion: 1 });
    expect(JSON.stringify(listed)).not.toContain(root);

    const persisted = JSON.parse(await readFile(join(root, "extensions", "registry.json"), "utf8"));
    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.extensions).toHaveLength(1);
  });

  it("rejects future registry schema versions", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "extensions"), { recursive: true });
    await writeFile(
      join(root, "extensions", "registry.json"),
      JSON.stringify({ schemaVersion: 2, extensions: [] })
    );
    await expect(ExtensionRegistry.open(root)).rejects.toBeInstanceOf(ExtensionRegistryError);
  });
});
