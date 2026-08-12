import { describe, expect, it } from "vitest";

import {
  MAX_DESCRIPTION_BYTES,
  MAX_SKILL_NAME_BYTES,
  SKILL_DESCRIPTOR_MAX_BYTES,
  SKILL_MD_MAX_BYTES,
  SkillError,
  parseSkillDocument
} from "./index.js";

function bytes(text: string): Uint8Array {
  return Buffer.from(text, "utf8");
}

function skill(frontmatter: string, body = "Follow these instructions.\n"): Uint8Array {
  return bytes(`---\n${frontmatter}\n---\n${body}`);
}

function expectBundleInvalid(run: () => unknown): void {
  expect(run).toThrowError(SkillError);
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ code: "SKILL_BUNDLE_INVALID" });
    expect(String(error)).not.toContain("/home/");
  }
}

describe("parseSkillDocument", () => {
  it("parses the minimal valid Agent Skill and preserves the Markdown body opaquely", () => {
    const body = "Use `rm -rf /` only as literal documentation text.\n\n```bash\necho inert\n```\n";
    const parsed = parseSkillDocument(
      skill("name: code-review\ndescription: Review code safely", body),
      "code-review"
    );

    expect(parsed).toEqual({
      name: "code-review",
      description: "Review code safely",
      unknownMetadataKeys: [],
      instructions: body
    });
  });

  it("parses bounded optional standard fields without interpreting them as authority", () => {
    const parsed = parseSkillDocument(
      skill(`name: deploy-helper
description: Deployment guidance
license: Apache-2.0
compatibility: Requires git
metadata:
  owner: platform
  nested:
    safe: true
allowed-tools: "git status git diff"`),
      "deploy-helper"
    );

    expect(parsed).toEqual({
      name: "deploy-helper",
      description: "Deployment guidance",
      license: "Apache-2.0",
      compatibility: "Requires git",
      metadata: { owner: "platform", nested: { safe: true } },
      allowedTools: "git status git diff",
      unknownMetadataKeys: [],
      instructions: "Follow these instructions.\n"
    });
  });

  it("surfaces unknown top-level metadata keys deterministically but never promotes them", () => {
    const parsed = parseSkillDocument(
      skill(`name: metadata-demo
description: Metadata demo
zeta-permission: root
alpha-network: unrestricted`),
      "metadata-demo"
    );

    expect(parsed.unknownMetadataKeys).toEqual(["alpha-network", "zeta-permission"]);
    expect(parsed).not.toHaveProperty("zeta-permission");
    expect(parsed).not.toHaveProperty("alpha-network");
  });

  it("preserves Unicode instructions exactly after UTF-8 validation", () => {
    const body = "Instruksi Indonesia 🙂\n日本語の手順\n";
    expect(
      parseSkillDocument(skill("name: unicode-skill\ndescription: Unicode body", body), "unicode-skill")
        .instructions
    ).toBe(body);
  });

  it("rejects malformed YAML, duplicate keys, non-object frontmatter, custom tags, and aliases", () => {
    const invalidDocuments = [
      skill("name: malformed\ndescription: [unterminated"),
      skill("name: duplicate\nname: duplicate\ndescription: duplicate key"),
      skill("- name\n- description"),
      skill("name: tagged\ndescription: !dangerous payload"),
      skill("name: alias-skill\ndescription: &desc shared\nmetadata:\n  copy: *desc")
    ];

    for (const document of invalidDocuments) {
      expectBundleInvalid(() => parseSkillDocument(document, "malformed"));
    }
  });

  it("rejects missing or invalid required fields and invalid optional field types", () => {
    for (const [directoryName, frontmatter] of [
      ["missing-name", "description: Missing name"],
      ["missing-description", "name: missing-description"],
      ["empty-description", "name: empty-description\ndescription: ''"],
      ["bad-license", "name: bad-license\ndescription: ok\nlicense: 42"],
      ["bad-compatibility", "name: bad-compatibility\ndescription: ok\ncompatibility: [git]"],
      ["bad-metadata", "name: bad-metadata\ndescription: ok\nmetadata: string"],
      ["bad-tools", "name: bad-tools\ndescription: ok\nallowed-tools:\n  key: value"]
    ] as const) {
      expectBundleInvalid(() => parseSkillDocument(skill(frontmatter), directoryName));
    }
  });

  it("enforces the Agent Skills name grammar and exact parent-directory name match", () => {
    for (const name of [
      "Uppercase",
      "leading-",
      "-trailing",
      "two--hyphens",
      "has space",
      "has_underscore",
      "éclair",
      ""
    ]) {
      expectBundleInvalid(() =>
        parseSkillDocument(skill(`name: ${JSON.stringify(name)}\ndescription: invalid name`), name || "empty")
      );
    }

    expectBundleInvalid(() =>
      parseSkillDocument(skill("name: valid-name\ndescription: mismatch"), "different-directory")
    );
  });

  it("enforces official character bounds plus KodeGPT UTF-8 byte ceilings", () => {
    const name64 = "a".repeat(64);
    expect(parseSkillDocument(skill(`name: ${name64}\ndescription: ok`), name64).name).toBe(name64);
    expectBundleInvalid(() => {
      const name65 = "a".repeat(65);
      return parseSkillDocument(skill(`name: ${name65}\ndescription: too long`), name65);
    });

    expect(MAX_SKILL_NAME_BYTES).toBe(128);
    expect(MAX_DESCRIPTION_BYTES).toBe(4 * 1024);
    expectBundleInvalid(() =>
      parseSkillDocument(
        skill(`name: long-description\ndescription: ${"a".repeat(1025)}`),
        "long-description"
      )
    );
    expectBundleInvalid(() =>
      parseSkillDocument(
        skill(`name: long-compatibility\ndescription: ok\ncompatibility: ${"a".repeat(501)}`),
        "long-compatibility"
      )
    );
  });

  it("enforces descriptor/frontmatter and whole SKILL.md byte ceilings before parsing", () => {
    expect(SKILL_DESCRIPTOR_MAX_BYTES).toBe(64 * 1024);
    expect(SKILL_MD_MAX_BYTES).toBe(256 * 1024);

    const hugeFrontmatter = skill(
      `name: huge-frontmatter\ndescription: ok\nunknown: ${"a".repeat(SKILL_DESCRIPTOR_MAX_BYTES)}`
    );
    expectBundleInvalid(() => parseSkillDocument(hugeFrontmatter, "huge-frontmatter"));

    const hugeDocument = skill(
      "name: huge-document\ndescription: ok",
      "x".repeat(SKILL_MD_MAX_BYTES)
    );
    expectBundleInvalid(() => parseSkillDocument(hugeDocument, "huge-document"));
  });

  it("rejects invalid UTF-8 instead of replacement-decoding", () => {
    const prefix = Buffer.from("---\nname: utf8\ndescription: invalid body\n---\n", "utf8");
    const document = Buffer.concat([prefix, Buffer.from([0xff, 0xfe])]);
    expectBundleInvalid(() => parseSkillDocument(document, "utf8"));
  });
});
