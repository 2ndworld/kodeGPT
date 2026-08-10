import { describe, expect, it } from "vitest";

import {
  DEFAULT_ITERATIONS,
  DEFAULT_WARMUPS,
  summarizeDurations
} from "./baseline.mjs";

describe("performance baseline statistics", () => {
  it("locks the release baseline iteration contract", () => {
    expect(DEFAULT_WARMUPS).toBe(5);
    expect(DEFAULT_ITERATIONS).toBe(30);
  });

  it("reports deterministic median/p95/iteration metadata without a pass threshold", () => {
    expect(summarizeDurations([1, 2, 3, 4])).toEqual({
      iterations: 4,
      medianMs: 2.5,
      p95Ms: 4,
      minMs: 1,
      maxMs: 4
    });
  });
});
