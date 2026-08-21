import { describe, expect, it } from "vitest";

import * as capabilities from "./index.js";
import { normalizeDiscoveryQuery, searchPublicActions } from "./public-action-search.js";

describe("public action search", () => {
  it("exports discovery search through the capabilities package entrypoint", () => {
    expect((capabilities as Record<string, unknown>).normalizeDiscoveryQuery).toBe(
      normalizeDiscoveryQuery
    );
    expect((capabilities as Record<string, unknown>).searchPublicActions).toBe(searchPublicActions);
  });

  it("normalizes Unicode discovery queries deterministically", () => {
    expect(normalizeDiscoveryQuery("  CÉK   CI.failure — sekarang  ")).toEqual({
      normalized: "cék ci.failure — sekarang",
      tokens: ["cék", "ci", "failure", "sekarang"]
    });
  });

  it("ranks exact action ids first", () => {
    expect(searchPublicActions("ci.failure", { limit: 5 })[0]?.action.id).toBe("ci.failure");
  });

  it("ranks exact aliases above description-only matches", () => {
    expect(searchPublicActions("why ci failed", { limit: 5 })[0]?.action.id).toBe("ci.failure");
  });

  it("finds visual verification from broad intent", () => {
    expect(
      searchPublicActions("check responsive UI screenshots", { limit: 3 }).map(
        (match) => match.action.id
      )
    ).toContain("visual.captureMatrix");
  });

  it("returns no unrelated fallback for a no-match query", () => {
    expect(searchPublicActions("zxqv completely unrelated tokens", { limit: 8 })).toEqual([]);
  });

  it("can return the complete current public catalog when every action family matches", () => {
    const allFamilies = "artifact browser visual ci code console context file git github process preview profile skill system trust verify workspace";
    expect(searchPublicActions(allFamilies, { limit: 76 })).toHaveLength(76);
  });

  it("returns bounded immutable scoring evidence", () => {
    const matches = searchPublicActions("git status", { limit: 3 });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.length).toBeLessThanOrEqual(3);
    for (const match of matches) {
      expect(Number.isInteger(match.score)).toBe(true);
      expect(match.score).toBeGreaterThanOrEqual(0);
      expect(match.matchReasons.length).toBeGreaterThan(0);
      expect(match.matchReasons.length).toBeLessThanOrEqual(8);
      expect(Object.isFrozen(match)).toBe(true);
      expect(Object.isFrozen(match.matchReasons)).toBe(true);
    }
    expect(Object.isFrozen(matches)).toBe(true);
  });

  it("is byte-for-byte deterministic across repeated calls", () => {
    const first = JSON.stringify(searchPublicActions("continue previous work", { limit: 8 }));
    for (let index = 0; index < 20; index += 1) {
      expect(JSON.stringify(searchPublicActions("continue previous work", { limit: 8 }))).toBe(first);
    }
  });
});
