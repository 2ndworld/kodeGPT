import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_SOURCES,
  SKILL_ERROR_CODES,
  SKILL_STATE_SCHEMA_VERSION,
  SkillError,
  SkillSourceStore
} from "./index.js";
import {
  createSkillTestStateRoot,
  removeSkillTestStateRoot,
  testSkillSourceInput
} from "./test-support.js";

const roots: string[] = [];

async function stateRoot(label: string): Promise<string> {
  const root = await createSkillTestStateRoot(label);
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeSkillTestStateRoot));
});

describe("SkillSourceStore", () => {
  it("returns an empty list when the versioned store does not exist", async () => {
    const root = await stateRoot("missing");
    const store = new SkillSourceStore(root);

    expect(await store.list()).toEqual([]);
  });

  it("persists schema version 1 with private directory/file modes and opaque source ids", async () => {
    const root = await stateRoot("persist");
    const store = new SkillSourceStore(root);
    const source = await store.add(testSkillSourceInput(1, "Codex skills"));

    expect(source.sourceId).toMatch(/^ss_[a-f0-9]{32}$/);
    expect(source).toEqual({ sourceId: source.sourceId, ...testSkillSourceInput(1, "Codex skills") });
    expect(await store.list()).toEqual([source]);

    const directory = join(root, "skills");
    const path = join(directory, "sources.json");
    const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(persisted.schemaVersion).toBe(SKILL_STATE_SCHEMA_VERSION);
    expect(persisted.sources).toEqual([source]);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("publishes replacements atomically and leaves no temporary files after success", async () => {
    const root = await stateRoot("atomic");
    const store = new SkillSourceStore(root);
    await store.add(testSkillSourceInput(1));
    const path = join(root, "skills", "sources.json");
    const firstInode = (await stat(path)).ino;

    await store.add(testSkillSourceInput(2));
    const secondInode = (await stat(path)).ino;
    const document = JSON.parse(await readFile(path, "utf8")) as { sources: unknown[] };
    const files = await readdir(join(root, "skills"));

    expect(secondInode).not.toBe(firstInode);
    expect(document.sources).toHaveLength(2);
    expect(files).toEqual(["sources.json"]);
  });

  it("rejects future schema versions and unknown owned-state fields", async () => {
    for (const [label, document] of [
      ["future", { schemaVersion: 2, sources: [] }],
      ["root-extra", { schemaVersion: 1, sources: [], unexpected: true }],
      [
        "source-extra",
        {
          schemaVersion: 1,
          sources: [{ sourceId: "ss_0123456789abcdef0123456789abcdef", ...testSkillSourceInput(1), unexpected: true }]
        }
      ],
      [
        "identity-extra",
        {
          schemaVersion: 1,
          sources: [
            {
              sourceId: "ss_0123456789abcdef0123456789abcdef",
              ...testSkillSourceInput(1),
              identity: { ...testSkillSourceInput(1).identity, unexpected: true }
            }
          ]
        }
      ]
    ] as const) {
      const root = await stateRoot(label);
      await mkdir(join(root, "skills"), { recursive: true });
      await writeFile(join(root, "skills", "sources.json"), `${JSON.stringify(document)}\n`, {
        mode: 0o600
      });
      const store = new SkillSourceStore(root);

      await expect(store.list()).rejects.toMatchObject({
        code: label === "future" ? "SKILL_REGISTRY_SCHEMA_UNSUPPORTED" : "SKILL_REGISTRY_INVALID"
      });
    }
  });

  it("rejects non-canonical persisted roots instead of normalizing owned state silently", async () => {
    const root = await stateRoot("non-canonical-root");
    await mkdir(join(root, "skills"), { recursive: true });
    await writeFile(
      join(root, "skills", "sources.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            sourceId: "ss_0123456789abcdef0123456789abcdef",
            ...testSkillSourceInput(1),
            canonicalRoot: "/tmp/source/../replacement"
          }
        ]
      })}\n`,
      { mode: 0o600 }
    );

    await expect(new SkillSourceStore(root).list()).rejects.toMatchObject({
      code: "SKILL_REGISTRY_INVALID"
    });
  });

  it("rejects duplicate filesystem identity while allowing duplicate labels", async () => {
    const root = await stateRoot("identity");
    const store = new SkillSourceStore(root);
    const first = await store.add(testSkillSourceInput(1, "same label"));
    const second = await store.add(testSkillSourceInput(2, "same label"));

    expect(first.label).toBe(second.label);
    expect(first.sourceId).not.toBe(second.sourceId);
    await expect(
      store.add({
        ...testSkillSourceInput(3, "different label"),
        identity: { ...first.identity }
      })
    ).rejects.toMatchObject({ code: "SKILL_REGISTRY_INVALID" });
    expect(await store.list()).toHaveLength(2);
  });

  it("rejects a seventeenth source at the exported hard limit", async () => {
    const root = await stateRoot("limit");
    const store = new SkillSourceStore(root);
    for (let index = 0; index < MAX_SOURCES; index += 1) {
      await store.add(testSkillSourceInput(index));
    }

    await expect(store.add(testSkillSourceInput(MAX_SOURCES))).rejects.toMatchObject({
      code: "SKILL_SOURCE_LIMIT_EXCEEDED"
    });
    expect(await store.list()).toHaveLength(MAX_SOURCES);
  });

  it("gets and removes sources by persistent id without exposing mutable internal state", async () => {
    const root = await stateRoot("lifecycle");
    const store = new SkillSourceStore(root);
    const added = await store.add(testSkillSourceInput(1));
    const listed = await store.list();
    listed[0]!.identity.inode = "999999";

    expect(await store.get(added.sourceId)).toEqual(added);
    expect(await store.remove(added.sourceId)).toBe(true);
    expect(await store.remove(added.sourceId)).toBe(false);
    expect(await store.get(added.sourceId)).toBeUndefined();
  });
});

describe("skill contracts and errors", () => {
  it("locks the Phase 2 stable error vocabulary and hard source-state constants", () => {
    expect(SKILL_ERROR_CODES).toEqual([
      "SKILL_SOURCE_NOT_FOUND",
      "SKILL_SOURCE_INVALID",
      "SKILL_SOURCE_STATE_OVERLAP",
      "SKILL_SOURCE_IDENTITY_CHANGED",
      "SKILL_SOURCE_UNAVAILABLE",
      "SKILL_SOURCE_BOUNDARY_VIOLATION",
      "SKILL_SOURCE_LIMIT_EXCEEDED",
      "SKILL_REGISTRY_INVALID",
      "SKILL_REGISTRY_SCHEMA_UNSUPPORTED",
      "SKILL_NOT_FOUND",
      "SKILL_BUNDLE_INVALID",
      "SKILL_FINGERPRINT_MISMATCH",
      "SKILL_RESOURCE_UNSUPPORTED",
      "SKILL_LOAD_LIMIT_EXCEEDED",
      "SKILL_PIN_INVALID",
      "SKILL_PIN_SCHEMA_UNSUPPORTED",
      "SKILL_WORKSPACE_REQUIRED",
      "SKILL_WORKSPACE_MISMATCH"
    ]);
    expect(SKILL_STATE_SCHEMA_VERSION).toBe(1);
    expect(MAX_SOURCES).toBe(16);
  });

  it("uses a closed SkillError code without host-sensitive cause serialization", () => {
    const error = new SkillError("SKILL_REGISTRY_INVALID", "Skill registry is invalid");

    expect(error).toMatchObject({
      name: "SkillError",
      code: "SKILL_REGISTRY_INVALID",
      message: "Skill registry is invalid"
    });
    expect(JSON.stringify(error)).not.toContain("/home/");
  });
});
