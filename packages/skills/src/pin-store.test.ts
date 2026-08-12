import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SKILL_STATE_SCHEMA_VERSION,
  SkillPinStore,
  fingerprintSkillBundle,
  fingerprintSkillDescriptor,
  type SkillPinInput
} from "./index.js";
import { createSkillTestStateRoot, removeSkillTestStateRoot } from "./test-support.js";

const roots: string[] = [];
const SOURCE_ID = `ss_${"a".repeat(32)}`;
const SKILL_ID = `sk_${"b".repeat(64)}`;
const PINNED_AT = "2026-08-12T07:30:00.000Z";

function bytes(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

function modeBits(mode: number): number {
  return mode & 0o777;
}

function pinInput(body = "instructions\n", guide = "guide\n"): SkillPinInput {
  const skillDocument = bytes(`---\nname: portable\ndescription: Portable skill\n---\n${body}`);
  const resourceBytes = bytes(guide);
  const descriptorFingerprint = fingerprintSkillDescriptor(skillDocument);
  const resourceSha256 = fingerprintSkillDescriptor(resourceBytes);
  const fingerprint = fingerprintSkillBundle([
    { path: "SKILL.md", bytes: skillDocument.byteLength, sha256: descriptorFingerprint },
    { path: "references/guide.md", bytes: resourceBytes.byteLength, sha256: resourceSha256 }
  ]);
  return {
    descriptor: {
      skillId: SKILL_ID,
      name: "portable",
      description: "Portable skill",
      sourceId: SOURCE_ID,
      sourceKind: "agent-skills",
      descriptorFingerprint,
      nameCollision: false,
      compatibility: {
        classification: "NATIVE",
        requiredCapabilities: [],
        missingCapabilities: [],
        requiredProviders: [],
        reasons: ["NATIVE_REQUIREMENTS_SATISFIED"],
        analysisBasis: "static"
      },
      unknownMetadataKeys: []
    },
    fingerprint,
    sourceRelativePath: "portable",
    skillDocument,
    resources: [
      {
        path: "references/guide.md",
        bytes: resourceBytes,
        sha256: resourceSha256
      }
    ]
  };
}

afterEach(async () => {
  while (roots.length > 0) {
    await removeSkillTestStateRoot(roots.pop()!);
  }
});

describe("SkillPinStore", () => {
  async function store(): Promise<{ stateRoot: string; store: SkillPinStore }> {
    const stateRoot = await createSkillTestStateRoot("pins");
    roots.push(stateRoot);
    return {
      stateRoot,
      store: new SkillPinStore(stateRoot, { now: () => new Date(PINNED_AT) })
    };
  }

  it("creates an immutable private fingerprint snapshot without persisting an absolute source path", async () => {
    const { stateRoot, store: pins } = await store();
    const input = pinInput();

    const manifest = await pins.pin(input);

    expect(manifest).toMatchObject({
      schemaVersion: SKILL_STATE_SCHEMA_VERSION,
      skillId: SKILL_ID,
      name: "portable",
      description: "Portable skill",
      fingerprint: input.fingerprint,
      provenance: {
        sourceId: SOURCE_ID,
        sourceKind: "agent-skills",
        sourceRelativePath: "portable",
        pinnedAt: PINNED_AT
      }
    });
    expect(manifest.files.map((file) => file.path)).toEqual(["SKILL.md", "references/guide.md"]);

    const snapshotRoot = join(stateRoot, "skills", "pinned", SKILL_ID, input.fingerprint);
    expect(modeBits((await stat(join(stateRoot, "skills", "pinned"))).mode)).toBe(0o700);
    expect(modeBits((await stat(join(stateRoot, "skills", "pinned", SKILL_ID))).mode)).toBe(0o700);
    expect(modeBits((await stat(snapshotRoot)).mode)).toBe(0o700);
    expect(modeBits((await stat(join(snapshotRoot, "manifest.json"))).mode)).toBe(0o600);
    expect(modeBits((await stat(join(snapshotRoot, "SKILL.md"))).mode)).toBe(0o600);
    expect(modeBits((await stat(join(snapshotRoot, "resources", "references"))).mode)).toBe(0o700);
    expect(modeBits((await stat(join(snapshotRoot, "resources", "references", "guide.md"))).mode)).toBe(
      0o600
    );

    const serialized = await readFile(join(snapshotRoot, "manifest.json"), "utf8");
    expect(serialized).not.toContain("/home/");
    expect(serialized).not.toContain("/private/");
    expect(serialized).not.toContain("canonicalRoot");
  });

  it("treats the same fingerprint as idempotent and refuses to replace a corrupted existing snapshot", async () => {
    const { stateRoot, store: pins } = await store();
    const input = pinInput();
    const first = await pins.pin(input);
    const second = await pins.pin(input);
    expect(second).toEqual(first);
    expect(await pins.list()).toHaveLength(1);

    const manifestPath = join(
      stateRoot,
      "skills",
      "pinned",
      SKILL_ID,
      input.fingerprint,
      "manifest.json"
    );
    const corrupted = { ...first, fingerprint: "f".repeat(64) };
    await chmod(manifestPath, 0o600);
    await writeFile(manifestPath, `${JSON.stringify(corrupted)}\n`, "utf8");

    await expect(pins.pin(input)).rejects.toMatchObject({ code: "SKILL_PIN_INVALID" });
  });

  it("loads a pinned snapshot without any live source dependency", async () => {
    const { store: pins } = await store();
    const input = pinInput();
    await pins.pin(input);

    const loaded = await pins.load(SKILL_ID, input.fingerprint);

    expect(Buffer.from(loaded.skillDocument).toString("utf8")).toContain("instructions");
    expect(loaded.resources.map((resource) => resource.path)).toEqual(["references/guide.md"]);
    expect(Buffer.from(loaded.resources[0]!.bytes).toString("utf8")).toBe("guide\n");
    expect(loaded.manifest.fingerprint).toBe(input.fingerprint);
  });

  it("keeps multiple immutable fingerprints for the same skill and unpins only the selected one", async () => {
    const { store: pins } = await store();
    const oldInput = pinInput("old\n", "old guide\n");
    const newInput = pinInput("new\n", "new guide\n");
    await pins.pin(oldInput);
    await pins.pin(newInput);

    expect((await pins.list()).map((manifest) => manifest.fingerprint).sort()).toEqual(
      [oldInput.fingerprint, newInput.fingerprint].sort()
    );
    expect(await pins.unpin(SKILL_ID, oldInput.fingerprint)).toBe(true);
    expect(await pins.unpin(SKILL_ID, oldInput.fingerprint)).toBe(false);
    expect((await pins.list()).map((manifest) => manifest.fingerprint)).toEqual([newInput.fingerprint]);
    await expect(pins.load(SKILL_ID, oldInput.fingerprint)).rejects.toMatchObject({
      code: "SKILL_NOT_FOUND"
    });
    expect((await pins.load(SKILL_ID, newInput.fingerprint)).manifest.fingerprint).toBe(
      newInput.fingerprint
    );
  });

  it("rejects unsupported future manifest schema versions", async () => {
    const { stateRoot, store: pins } = await store();
    const input = pinInput();
    const snapshotRoot = join(stateRoot, "skills", "pinned", SKILL_ID, input.fingerprint);
    await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
    await writeFile(
      join(snapshotRoot, "manifest.json"),
      `${JSON.stringify({ schemaVersion: 2 })}\n`,
      { mode: 0o600 }
    );

    await expect(pins.load(SKILL_ID, input.fingerprint)).rejects.toMatchObject({
      code: "SKILL_PIN_SCHEMA_UNSUPPORTED"
    });
  });

  it("rejects pin inputs whose declared bundle fingerprint does not match the exact bytes", async () => {
    const { store: pins } = await store();
    const input = pinInput();
    input.fingerprint = "0".repeat(64);

    await expect(pins.pin(input)).rejects.toMatchObject({ code: "SKILL_PIN_INVALID" });
    expect(await pins.list()).toEqual([]);
  });
});
