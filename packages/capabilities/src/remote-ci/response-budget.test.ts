import { describe, expect, it } from "vitest";

import { MAX_CI_RESPONSE_BYTES } from "./contracts.js";
import { fitCiResult, utf8Prefix } from "./response-budget.js";

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

describe("Remote-CI response budgeting", () => {
  it("clips UTF-8 prefixes without splitting code points", () => {
    expect(utf8Prefix("😀😀x", 4)).toBe("😀");
    expect(utf8Prefix("😀😀x", 8)).toBe("😀😀");
    expect(Buffer.byteLength(utf8Prefix("😀😀x", 5), "utf8")).toBeLessThanOrEqual(5);
  });

  it("deterministically trims optional evidence and records RESPONSE_LIMIT exactly once", () => {
    const candidate = {
      schemaVersion: 1,
      repository: { fullName: "2ndworld/kodeGPT" },
      state: "FAIL",
      logExcerpt: "x".repeat(600 * 1024),
      annotations: Array.from({ length: 100 }, (_, index) => ({ index, message: "a".repeat(2048) })),
      jobs: Array.from({ length: 10 }, (_, index) => ({
        id: String(index + 1),
        steps: Array.from({ length: 100 }, (_, step) => ({ number: step + 1, name: "s".repeat(128) }))
      })),
      failures: [{ runId: "1" }],
      checks: [{ id: "1", state: "FAIL" }],
      runs: [{ id: "1", conclusion: "FAILURE" }],
      truncated: false,
      truncationReasons: [] as string[]
    };

    const first = fitCiResult(candidate);
    const second = fitCiResult(candidate);

    expect(first).toEqual(second);
    expect(serializedBytes(first)).toBeLessThanOrEqual(MAX_CI_RESPONSE_BYTES);
    expect(first.truncated).toBe(true);
    expect(first.truncationReasons.filter((reason) => reason === "RESPONSE_LIMIT")).toHaveLength(1);
    expect(Buffer.byteLength(first.logExcerpt, "utf8")).toBeLessThan(Buffer.byteLength(candidate.logExcerpt, "utf8"));
  });

  it("reduces arrays from the tail when string trimming is insufficient", () => {
    const candidate = {
      mandatory: "kept",
      annotations: Array.from({ length: 100 }, (_, index) => ({
        index,
        message: `${index}:` + "a".repeat(7000)
      })),
      truncated: false,
      truncationReasons: [] as string[]
    };

    const fitted = fitCiResult(candidate);
    expect(serializedBytes(fitted)).toBeLessThanOrEqual(MAX_CI_RESPONSE_BYTES);
    expect(fitted.annotations.length).toBeLessThan(candidate.annotations.length);
    expect(fitted.annotations[0]?.index).toBe(0);
    expect(fitted.truncationReasons).toEqual(["RESPONSE_LIMIT"]);
  });

  it("fails closed when mandatory-only content cannot fit", () => {
    expect(() =>
      fitCiResult({
        mandatory: "x".repeat(MAX_CI_RESPONSE_BYTES + 1024),
        truncated: false,
        truncationReasons: [] as string[]
      })
    ).toThrowError(expect.objectContaining({ code: "CI_RESPONSE_LIMIT_EXCEEDED" }));
  });
});
