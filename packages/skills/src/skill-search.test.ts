import { describe, expect, it } from "vitest";

import type { SkillCatalogEntry } from "./contracts.js";
import { rankSkillsForQuery } from "./skill-search.js";

const compatibility = {
  classification: "NATIVE" as const,
  requiredCapabilities: [],
  missingCapabilities: [],
  requiredProviders: [],
  reasons: ["NATIVE_REQUIREMENTS_SATISFIED"],
  analysisBasis: "static" as const
};

function entry(overrides: Partial<SkillCatalogEntry> = {}): SkillCatalogEntry {
  return {
    skillId: `sk_${"a".repeat(64)}`,
    name: "portable-workflow",
    description: "Portable workflow",
    sourceId: `ss_${"b".repeat(32)}`,
    sourceKind: "agent-skills",
    fingerprint: "c".repeat(64),
    descriptorFingerprint: "d".repeat(64),
    nameCollision: false,
    compatibility,
    availability: "live",
    pinned: false,
    ...overrides
  };
}

describe("rankSkillsForQuery", () => {
  it("ranks exact names above token and description matches", () => {
    const skills = [
      entry({ name: "application-development", description: "Generic app helper", skillId: `sk_${"1".repeat(64)}` }),
      entry({ name: "kodegpt-application-development-workflow", description: "Application development workflow", skillId: `sk_${"2".repeat(64)}` }),
      entry({ name: "other", description: "kodegpt application development workflow", skillId: `sk_${"3".repeat(64)}` })
    ];

    expect(rankSkillsForQuery(skills, "kodegpt-application-development-workflow")[0]?.skill.name).toBe(
      "kodegpt-application-development-workflow"
    );
    expect(rankSkillsForQuery(skills, "application development")[0]?.skill.name).toBe(
      "kodegpt-application-development-workflow"
    );
  });

  it("returns bounded match reasons and no unrelated fallback", () => {
    const matches = rankSkillsForQuery([entry()], "portable workflow");
    expect(matches[0]?.matchReasons.length).toBeGreaterThan(0);
    expect(matches[0]?.matchReasons.length).toBeLessThanOrEqual(8);
    expect(rankSkillsForQuery([entry()], "zxqv unrelated tokens")).toEqual([]);
  });

  it("uses compatibility only as a relevance bonus after a textual match", () => {
    const native = entry({ name: "review-helper", skillId: `sk_${"4".repeat(64)}` });
    const partial = entry({
      name: "review-helper",
      skillId: `sk_${"5".repeat(64)}`,
      compatibility: { ...compatibility, classification: "PARTIAL" }
    });
    expect(rankSkillsForQuery([partial, native], "review helper")[0]?.skill.skillId).toBe(native.skillId);
  });

  it("prefers a matching workspace-local source only as a tie-breaking relevance bonus", () => {
    const global = entry({ skillId: `sk_${"6".repeat(64)}`, sourceId: `ss_${"1".repeat(32)}` });
    const local = entry({ skillId: `sk_${"7".repeat(64)}`, sourceId: `ss_${"2".repeat(32)}` });
    const matches = rankSkillsForQuery([global, local], "portable workflow", {
      workspaceSourceIds: new Set([local.sourceId])
    });
    expect(matches[0]?.skill.skillId).toBe(local.skillId);
  });

  it("is stable by UTF-8 skill identity when scores tie", () => {
    const left = entry({ skillId: `sk_${"8".repeat(64)}`, sourceId: `ss_${"a".repeat(32)}` });
    const right = entry({ skillId: `sk_${"9".repeat(64)}`, sourceId: `ss_${"b".repeat(32)}` });
    const first = rankSkillsForQuery([right, left], "portable workflow").map((match) => match.skill.skillId);
    const second = rankSkillsForQuery([left, right], "portable workflow").map((match) => match.skill.skillId);
    expect(first).toEqual(second);
  });
});
