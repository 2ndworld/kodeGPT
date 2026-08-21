import { Buffer } from "node:buffer";

import { normalizeDiscoveryQuery } from "@kodegpt/capabilities";

import type { SkillCatalogEntry, SkillCompatibility } from "./contracts.js";

export interface SkillSearchMatch {
  readonly skill: SkillCatalogEntry;
  readonly score: number;
  readonly matchReasons: readonly string[];
}

export interface SkillSearchOptions {
  readonly workspaceSourceIds?: ReadonlySet<string>;
}

const SCORE = Object.freeze({
  NAME_EXACT: 10_000,
  ALL_NAME_TOKENS: 7_000,
  NAME_TOKEN: 900,
  DESCRIPTION_TOKEN: 300,
  QUERY_COVERAGE_TOKEN: 500,
  WORKSPACE_SOURCE: 120,
  COMPATIBILITY_NATIVE: 80,
  COMPATIBILITY_PARTIAL: 50,
  COMPATIBILITY_PROVIDER_REQUIRED: 20,
  COMPATIBILITY_UNSUPPORTED: 0
});

const MAX_MATCH_REASONS = 8;
const QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "this",
  "to",
  "with",
  "dan",
  "dengan",
  "ini",
  "itu",
  "lalu",
  "untuk",
  "yang"
]);

export function rankSkillsForQuery(
  skills: readonly SkillCatalogEntry[],
  query: string,
  options: SkillSearchOptions = {}
): readonly SkillSearchMatch[] {
  const normalized = normalizeDiscoveryQuery(query);
  const terms = normalized.tokens.filter((item) => !QUERY_STOPWORDS.has(item));
  if (terms.length === 0) return Object.freeze([]);

  const matches: SkillSearchMatch[] = [];
  for (const skill of skills) {
    const name = normalizeDiscoveryQuery(skill.name);
    const description = normalizeDiscoveryQuery(skill.description);
    const nameTokens = new Set(name.tokens);
    const descriptionTokens = new Set(description.tokens);
    let score = 0;
    const reasons: string[] = [];

    if (name.normalized === normalized.normalized) {
      score += SCORE.NAME_EXACT;
      reasons.push("NAME_EXACT");
    }

    const nameMatches = terms.filter((token) => nameTokens.has(token)).length;
    const descriptionMatches = terms.filter((token) => descriptionTokens.has(token)).length;
    const coverageMatches = terms.filter(
      (token) => nameTokens.has(token) || descriptionTokens.has(token)
    ).length;
    const textMatched = coverageMatches > 0;
    if (!textMatched) continue;

    if (terms.every((token) => nameTokens.has(token))) {
      score += SCORE.ALL_NAME_TOKENS;
      reasons.push("ALL_NAME_TOKENS");
    }
    if (nameMatches > 0) {
      score += nameMatches * SCORE.NAME_TOKEN;
      reasons.push(`NAME_TOKEN:${nameMatches}`);
    }
    if (descriptionMatches > 0) {
      score += descriptionMatches * SCORE.DESCRIPTION_TOKEN;
      reasons.push(`DESCRIPTION_TOKEN:${descriptionMatches}`);
    }
    if (coverageMatches > 0) {
      score += coverageMatches * SCORE.QUERY_COVERAGE_TOKEN;
      reasons.push(`QUERY_COVERAGE:${coverageMatches}`);
    }

    const compatibilityBonus = compatibilityScore(skill.compatibility.classification);
    if (compatibilityBonus > 0) {
      score += compatibilityBonus;
      reasons.push(`COMPATIBILITY:${skill.compatibility.classification}`);
    }
    if (options.workspaceSourceIds?.has(skill.sourceId)) {
      score += SCORE.WORKSPACE_SOURCE;
      reasons.push("WORKSPACE_SOURCE");
    }

    matches.push(
      Object.freeze({
        skill,
        score,
        matchReasons: Object.freeze(reasons.slice(0, MAX_MATCH_REASONS))
      })
    );
  }

  matches.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    const nameOrder = compareUtf8(left.skill.name, right.skill.name);
    if (nameOrder !== 0) return nameOrder;
    const sourceOrder = compareUtf8(left.skill.sourceId, right.skill.sourceId);
    if (sourceOrder !== 0) return sourceOrder;
    return compareUtf8(left.skill.skillId, right.skill.skillId);
  });

  return Object.freeze(matches);
}

function compatibilityScore(classification: SkillCompatibility): number {
  switch (classification) {
    case "NATIVE":
      return SCORE.COMPATIBILITY_NATIVE;
    case "PARTIAL":
      return SCORE.COMPATIBILITY_PARTIAL;
    case "PROVIDER_REQUIRED":
      return SCORE.COMPATIBILITY_PROVIDER_REQUIRED;
    case "UNSUPPORTED":
      return SCORE.COMPATIBILITY_UNSUPPORTED;
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
