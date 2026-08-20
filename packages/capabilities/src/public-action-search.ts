import { Buffer } from "node:buffer";

import {
  listPublicActionDescriptors,
  type PublicActionDescriptor
} from "./public-actions.js";

export interface NormalizedDiscoveryQuery {
  readonly normalized: string;
  readonly tokens: readonly string[];
}

export interface PublicActionSearchMatch {
  readonly action: PublicActionDescriptor;
  readonly score: number;
  readonly matchReasons: readonly string[];
}

const SCORE = Object.freeze({
  ACTION_ID_EXACT: 10_000,
  ALIAS_EXACT: 9_000,
  FAMILY_OR_SEGMENT_EXACT: 7_500,
  ALL_TOKENS_ID_OR_ALIAS: 6_000,
  ID_OR_ALIAS_TOKEN: 700,
  PURPOSE_TOKEN: 300,
  TAG_TOKEN: 250,
  COMPOSITE_BROAD_INTENT_BONUS: 150
});

const MAX_QUERY_TOKENS = 64;
const MAX_MATCH_REASONS = 8;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 75;

export function normalizeDiscoveryQuery(value: string): NormalizedDiscoveryQuery {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
  const tokens = Object.freeze(
    (normalized.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_QUERY_TOKENS)
  );
  return Object.freeze({ normalized, tokens });
}

export function searchPublicActions(
  query: string,
  options: { limit?: number } = {}
): readonly PublicActionSearchMatch[] {
  const normalizedQuery = normalizeDiscoveryQuery(query);
  if (normalizedQuery.normalized.length === 0 || normalizedQuery.tokens.length === 0) {
    return Object.freeze([]);
  }

  const requestedLimit = options.limit ?? DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(requestedLimit)));
  const matches: PublicActionSearchMatch[] = [];

  for (const action of listPublicActionDescriptors()) {
    const scored = scoreAction(action, normalizedQuery);
    if (scored.score <= 0) continue;
    matches.push(
      Object.freeze({
        action,
        score: scored.score,
        matchReasons: Object.freeze(scored.matchReasons.slice(0, MAX_MATCH_REASONS))
      })
    );
  }

  matches.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    return compareUtf8(left.action.id, right.action.id);
  });

  return Object.freeze(matches.slice(0, limit));
}

function scoreAction(
  action: PublicActionDescriptor,
  query: NormalizedDiscoveryQuery
): { score: number; matchReasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const id = action.id.toLowerCase();
  const idTokens = tokenSet(id);
  const family = action.family.toLowerCase();
  const segments = new Set(id.split("."));
  const aliasNormalized = action.aliases.map((alias) => normalizeDiscoveryQuery(alias));
  const aliasTokens = new Set(aliasNormalized.flatMap((alias) => [...alias.tokens]));
  const purposeTokens = tokenSet(action.purpose);
  const tagTokens = new Set(action.tags.flatMap((tag) => [...tokenSet(tag)]));
  const idOrAliasTokens = new Set([...idTokens, ...aliasTokens]);

  if (query.normalized === id) {
    score += SCORE.ACTION_ID_EXACT;
    reasons.push("ACTION_ID_EXACT");
  }

  if (aliasNormalized.some((alias) => alias.normalized === query.normalized)) {
    score += SCORE.ALIAS_EXACT;
    reasons.push("ALIAS_EXACT");
  }

  if (query.normalized === family || segments.has(query.normalized)) {
    score += SCORE.FAMILY_OR_SEGMENT_EXACT;
    reasons.push("FAMILY_OR_SEGMENT_EXACT");
  }

  if (query.tokens.every((token) => idOrAliasTokens.has(token))) {
    score += SCORE.ALL_TOKENS_ID_OR_ALIAS;
    reasons.push("ALL_TOKENS_ID_OR_ALIAS");
  }

  let textTokenMatches = 0;
  let purposeMatches = 0;
  let tagMatches = 0;
  for (const token of query.tokens) {
    if (idOrAliasTokens.has(token)) {
      score += SCORE.ID_OR_ALIAS_TOKEN;
      textTokenMatches += 1;
    }
    if (purposeTokens.has(token)) {
      score += SCORE.PURPOSE_TOKEN;
      purposeMatches += 1;
    }
    if (tagTokens.has(token)) {
      score += SCORE.TAG_TOKEN;
      tagMatches += 1;
    }
  }

  if (textTokenMatches > 0) reasons.push(`ID_OR_ALIAS_TOKEN:${textTokenMatches}`);
  if (purposeMatches > 0) reasons.push(`PURPOSE_TOKEN:${purposeMatches}`);
  if (tagMatches > 0) reasons.push(`TAG_TOKEN:${tagMatches}`);

  if (
    action.role === "composite" &&
    query.tokens.length >= 3 &&
    textTokenMatches + purposeMatches + tagMatches >= 2
  ) {
    score += SCORE.COMPOSITE_BROAD_INTENT_BONUS;
    reasons.push("COMPOSITE_BROAD_INTENT_BONUS");
  }

  return { score, matchReasons: reasons };
}

function tokenSet(value: string): Set<string> {
  return new Set(normalizeDiscoveryQuery(value).tokens);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
