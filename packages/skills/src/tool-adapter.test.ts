import { describe, expect, it } from "vitest";

import {
  SkillError,
  createSkillCatalogToolAdapter,
  fingerprintSkillDescriptor,
  type SkillCatalogEntry,
  type SkillCompatibilityReport
} from "./index.js";

const SOURCE_ID = `ss_${"a".repeat(32)}`;
const OTHER_SOURCE_ID = `ss_${"b".repeat(32)}`;
const SKILL_ID = `sk_${"c".repeat(64)}`;
const OTHER_SKILL_ID = `sk_${"d".repeat(64)}`;
const FINGERPRINT = "e".repeat(64);

const compatibility: SkillCompatibilityReport = {
  classification: "NATIVE",
  requiredCapabilities: ["file.read"],
  missingCapabilities: [],
  requiredProviders: [],
  reasons: ["NATIVE_REQUIREMENTS_SATISFIED"],
  analysisBasis: "static"
};

function entry(overrides: Partial<SkillCatalogEntry> = {}): SkillCatalogEntry {
  return {
    skillId: SKILL_ID,
    name: "portable",
    description: "Portable skill",
    sourceId: SOURCE_ID,
    sourceKind: "agent-skills",
    fingerprint: FINGERPRINT,
    descriptorFingerprint: "f".repeat(64),
    nameCollision: false,
    compatibility,
    availability: "live+pinned",
    pinned: true,
    ...overrides
  };
}

function skillDocument(body = "Use the safe instructions.\n"): Uint8Array {
  return Buffer.from(
    `---\nname: portable\ndescription: Portable skill\nmetadata:\n  canonicalRoot: /private/skill-source\n---\n${body}`,
    "utf8"
  );
}

describe("SkillCatalogToolAdapter", () => {
  it("filters and caps list output deterministically with explicit result truncation", async () => {
    const adapter = createSkillCatalogToolAdapter({
      list: async () => ({
        skills: [
          entry(),
          entry({
            skillId: OTHER_SKILL_ID,
            name: "other",
            sourceId: OTHER_SOURCE_ID,
            fingerprint: "1".repeat(64),
            pinned: false,
            availability: "live"
          })
        ],
        truncated: false,
        truncationReasons: []
      })
    } as never);

    const pinned = await adapter.list({ pinned: true, limit: 1 });
    expect(pinned).toMatchObject({ schemaVersion: 1, truncated: false, truncationReasons: [] });
    expect(pinned.skills.map((skill) => skill.skillId)).toEqual([SKILL_ID]);

    const capped = await adapter.list({ limit: 1 });
    expect(capped.skills).toHaveLength(1);
    expect(capped.truncated).toBe(true);
    expect(capped.truncationReasons).toContain("RESULT_LIMIT");
  });

  it("returns provenance-safe inspect metadata without raw metadata values or host paths", async () => {
    const adapter = createSkillCatalogToolAdapter({
      inspect: async () => ({
        skill: entry(),
        frontmatter: {
          name: "portable",
          description: "Portable skill",
          license: "MIT",
          compatibility: "KodeGPT",
          metadata: { canonicalRoot: "/private/skill-source" },
          allowedTools: ["Read"],
          unknownMetadataKeys: ["vendor-extra"]
        },
        resources: [
          {
            path: "references/guide.md",
            bytes: 6,
            sha256: "2".repeat(64),
            kind: "text",
            textInlineEligible: true
          }
        ],
        instructionBytes: 27,
        bundleBytes: 128
      })
    } as never);

    const result = await adapter.inspect({ skillId: SKILL_ID, fingerprint: FINGERPRINT });
    expect(result).toMatchObject({
      schemaVersion: 1,
      skill: { skillId: SKILL_ID, sourceId: SOURCE_ID, fingerprint: FINGERPRINT },
      frontmatter: {
        license: "MIT",
        compatibility: "KodeGPT",
        allowedTools: ["Read"],
        unknownMetadataKeys: ["vendor-extra"]
      },
      instructionBytes: 27,
      bundleBytes: 128
    });
    expect(result.frontmatter).not.toHaveProperty("metadata");
    expect(JSON.stringify(result)).not.toContain("/private/skill-source");
  });

  it("loads instructions plus only requested UTF-8 resources within maxBytes", async () => {
    let received: unknown;
    const document = skillDocument();
    const guide = Buffer.from("guide\n", "utf8");
    const adapter = createSkillCatalogToolAdapter({
      loadRaw: async (input: unknown) => {
        received = input;
        return {
          descriptor: {
            ...entry(),
            fingerprint: undefined,
            availability: undefined,
            pinned: undefined
          },
          bundleFingerprint: FINGERPRINT,
          skillDocument: document,
          resources: [
            {
              path: "references/guide.md",
              bytes: guide,
              sha256: fingerprintSkillDescriptor(guide)
            }
          ],
          availability: "live+pinned",
          pinned: true
        };
      }
    } as never);

    const result = await adapter.load({
      skillId: SKILL_ID,
      fingerprint: FINGERPRINT,
      resources: ["references/guide.md"],
      maxBytes: 512 * 1024
    });

    expect(received).toEqual({
      skillId: SKILL_ID,
      fingerprint: FINGERPRINT,
      resources: ["references/guide.md"]
    });
    expect(result).toMatchObject({
      schemaVersion: 1,
      skillId: SKILL_ID,
      fingerprint: FINGERPRINT,
      availability: "live+pinned",
      pinned: true,
      instructions: "Use the safe instructions.\n",
      resources: [{ path: "references/guide.md", contents: "guide\n" }]
    });
    expect(result.totalBytes).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("canonicalRoot");
    expect(JSON.stringify(result)).not.toContain("/private/skill-source");
  });

  it("rejects duplicate or excessive requested resources before reading source content", async () => {
    let calls = 0;
    const adapter = createSkillCatalogToolAdapter({
      loadRaw: async () => {
        calls += 1;
        throw new Error("must not reach source");
      }
    } as never);

    await expect(
      adapter.load({
        skillId: SKILL_ID,
        resources: ["references/guide.md", "references/guide.md"]
      })
    ).rejects.toMatchObject({ code: "SKILL_RESOURCE_UNSUPPORTED" });
    await expect(
      adapter.load({
        skillId: SKILL_ID,
        resources: Array.from({ length: 33 }, (_, index) => `references/${index}.md`)
      })
    ).rejects.toMatchObject({ code: "SKILL_LOAD_LIMIT_EXCEEDED" });
    expect(calls).toBe(0);
  });

  it("rejects binary requested resources and returned payloads over the requested byte ceiling", async () => {
    const document = skillDocument("x".repeat(32));
    const binary = Uint8Array.from([0xff, 0xfe, 0xfd]);
    const catalog = {
      loadRaw: async (input: { resources?: string[] }) => ({
        descriptor: {
          skillId: SKILL_ID,
          name: "portable",
          description: "Portable skill",
          sourceId: SOURCE_ID,
          sourceKind: "agent-skills" as const,
          descriptorFingerprint: "f".repeat(64),
          nameCollision: false,
          compatibility,
          unknownMetadataKeys: []
        },
        bundleFingerprint: FINGERPRINT,
        skillDocument: document,
        resources: input.resources?.includes("assets/binary.bin")
          ? [
              {
                path: "assets/binary.bin",
                bytes: binary,
                sha256: fingerprintSkillDescriptor(binary)
              }
            ]
          : [],
        availability: "live" as const,
        pinned: false
      })
    };
    const adapter = createSkillCatalogToolAdapter(catalog as never);

    await expect(
      adapter.load({ skillId: SKILL_ID, resources: ["assets/binary.bin"], maxBytes: 512 * 1024 })
    ).rejects.toMatchObject({ code: "SKILL_RESOURCE_UNSUPPORTED" });
    await expect(adapter.load({ skillId: SKILL_ID, maxBytes: 8 })).rejects.toMatchObject({
      code: "SKILL_LOAD_LIMIT_EXCEEDED"
    });
  });

  it("preserves safe SkillError codes for expected-fingerprint failures", async () => {
    const adapter = createSkillCatalogToolAdapter({
      loadRaw: async () => {
        throw new SkillError("SKILL_FINGERPRINT_MISMATCH", "Skill fingerprint does not match");
      }
    } as never);

    await expect(
      adapter.load({ skillId: SKILL_ID, fingerprint: "0".repeat(64) })
    ).rejects.toMatchObject({ code: "SKILL_FINGERPRINT_MISMATCH" });
  });

  it("enforces the expected fingerprint even if an internal source returns changed content", async () => {
    const adapter = createSkillCatalogToolAdapter({
      loadRaw: async () => ({
        descriptor: {
          skillId: SKILL_ID,
          name: "portable",
          description: "Portable skill",
          sourceId: SOURCE_ID,
          sourceKind: "agent-skills" as const,
          descriptorFingerprint: "f".repeat(64),
          nameCollision: false,
          compatibility,
          unknownMetadataKeys: []
        },
        bundleFingerprint: FINGERPRINT,
        skillDocument: skillDocument(),
        resources: [],
        availability: "live" as const,
        pinned: false
      })
    } as never);

    await expect(
      adapter.load({ skillId: SKILL_ID, fingerprint: "0".repeat(64) })
    ).rejects.toMatchObject({ code: "SKILL_FINGERPRINT_MISMATCH" });
  });

  it("rejects raw loads for a different skill identity than the caller requested", async () => {
    const adapter = createSkillCatalogToolAdapter({
      loadRaw: async () => ({
        descriptor: {
          skillId: OTHER_SKILL_ID,
          name: "portable",
          description: "Portable skill",
          sourceId: SOURCE_ID,
          sourceKind: "agent-skills" as const,
          descriptorFingerprint: "f".repeat(64),
          nameCollision: false,
          compatibility,
          unknownMetadataKeys: []
        },
        bundleFingerprint: FINGERPRINT,
        skillDocument: skillDocument(),
        resources: [],
        availability: "live" as const,
        pinned: false
      })
    } as never);

    await expect(adapter.load({ skillId: SKILL_ID })).rejects.toMatchObject({
      code: "SKILL_BUNDLE_INVALID"
    });
  });

  it("rejects raw loads whose descriptor disagrees with the returned skill document", async () => {
    const adapter = createSkillCatalogToolAdapter({
      loadRaw: async () => ({
        descriptor: {
          skillId: SKILL_ID,
          name: "portable",
          description: "Different description",
          sourceId: SOURCE_ID,
          sourceKind: "agent-skills" as const,
          descriptorFingerprint: "f".repeat(64),
          nameCollision: false,
          compatibility,
          unknownMetadataKeys: []
        },
        bundleFingerprint: FINGERPRINT,
        skillDocument: skillDocument(),
        resources: [],
        availability: "live" as const,
        pinned: false
      })
    } as never);

    await expect(adapter.load({ skillId: SKILL_ID })).rejects.toMatchObject({
      code: "SKILL_BUNDLE_INVALID"
    });
  });

  it("never returns resource bodies that were not explicitly requested", async () => {
    const guide = Buffer.from("guide\n", "utf8");
    const adapter = createSkillCatalogToolAdapter({
      loadRaw: async () => ({
        descriptor: {
          skillId: SKILL_ID,
          name: "portable",
          description: "Portable skill",
          sourceId: SOURCE_ID,
          sourceKind: "agent-skills" as const,
          descriptorFingerprint: "f".repeat(64),
          nameCollision: false,
          compatibility,
          unknownMetadataKeys: []
        },
        bundleFingerprint: FINGERPRINT,
        skillDocument: skillDocument(),
        resources: [
          {
            path: "references/guide.md",
            bytes: guide,
            sha256: fingerprintSkillDescriptor(guide)
          }
        ],
        availability: "live" as const,
        pinned: false
      })
    } as never);

    await expect(adapter.load({ skillId: SKILL_ID })).rejects.toMatchObject({
      code: "SKILL_BUNDLE_INVALID"
    });
  });
});
