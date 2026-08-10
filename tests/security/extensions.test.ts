import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ExtensionManifestError,
  ExtensionRegistry,
  ExtensionRegistryError,
  loadExtensionManifest,
  parseExtensionManifest
} from "../../packages/extensions/src/index.js";

const roots: string[] = [];
const safeManifest = {
  schemaVersion: 1,
  id: "docs.security-fixture",
  name: "Security Fixture",
  version: "1.0.0",
  capabilities: {
    documentation: { summary: "Documentation only" },
    profileRestrictions: { denyNetwork: true }
  }
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("declarative extension security boundary", () => {
  it("rejects executable source fields and never executes sibling JavaScript", async () => {
    for (const field of ["main", "module", "script", "command", "html", "javascript", "entrypoint"]) {
      expect(() => parseExtensionManifest({ ...safeManifest, [field]: "./payload.js" })).toThrow(
        ExtensionManifestError
      );
    }

    const root = await mkdtemp(join(tmpdir(), "kodegpt-extension-security-"));
    roots.push(root);
    const marker = join(root, "side-effect.marker");
    await writeFile(join(root, "extension.json"), JSON.stringify(safeManifest));
    await writeFile(
      join(root, "payload.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");`
    );
    await loadExtensionManifest(join(root, "extension.json"));
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps registry versioned, bounded, and path-free", async () => {
    const root = await mkdtemp(join(tmpdir(), "kodegpt-extension-registry-"));
    roots.push(root);
    const registry = await ExtensionRegistry.open(root);
    await registry.enable(parseExtensionManifest(safeManifest));
    const listed = registry.listEnabled(10_000);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(root);

    await writeFile(
      join(root, "extensions", "registry.json"),
      JSON.stringify({ schemaVersion: 2, extensions: [] })
    );
    await expect(ExtensionRegistry.open(root)).rejects.toBeInstanceOf(ExtensionRegistryError);
  });
});
