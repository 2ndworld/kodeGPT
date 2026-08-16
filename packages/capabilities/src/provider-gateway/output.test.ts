import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  decodeProviderUtf8,
  fitProviderSemanticResult,
  normalizeProviderValue,
  parseProviderSemanticOutput
} from "./output.js";

describe("provider output normalization", () => {
  it("rejects invalid UTF-8 and NUL before structural parsing", () => {
    expect(() => decodeProviderUtf8(Uint8Array.from([0xc3, 0x28])))
      .toThrowError(expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID" }));
    expect(() => decodeProviderUtf8(Buffer.from("before\0after", "utf8")))
      .toThrowError(expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID" }));
  });

  it("normalizes Unicode and all newline forms without general trimming", () => {
    expect(normalizeProviderValue({ text: "  e\u0301\r\nnext\rlast  " })).toEqual({
      text: "  é\nnext\nlast  "
    });
  });

  it("rejects cycles, binary values, excess depth, and more than 1000 elements", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => normalizeProviderValue(cycle)).toThrowError(/cycle/i);
    expect(() => normalizeProviderValue(Buffer.from("raw"))).toThrowError(/binary|plain JSON/i);

    let deep: unknown = "leaf";
    for (let index = 0; index < 17; index += 1) deep = { child: deep };
    expect(() => normalizeProviderValue(deep)).toThrowError(/depth/i);
    expect(() => normalizeProviderValue(Array.from({ length: 1001 }, (_, index) => index)))
      .toThrowError(/1000/i);
  });

  it("strictly parses normalized JSON through the reviewed mapping schema", () => {
    const schema = z.object({
      id: z.string().regex(/^[A-Za-z0-9._-]+$/),
      label: z.string()
    }).strict();
    const good = Buffer.from(JSON.stringify({ id: "record_42", label: "e\u0301\r\nnext" }), "utf8");
    expect(parseProviderSemanticOutput(good, schema)).toEqual({ id: "record_42", label: "é\nnext" });

    expect(() => parseProviderSemanticOutput(Buffer.from(JSON.stringify({ id: "récord", label: "x" })), schema))
      .toThrowError(expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID" }));
    expect(() => parseProviderSemanticOutput(Buffer.from(JSON.stringify({ id: "ok", label: "x", extra: true })), schema))
      .toThrowError(expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID" }));
    expect(() => parseProviderSemanticOutput(Buffer.from("not-json"), schema))
      .toThrowError(expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID" }));
  });

  it("returns an intact semantic result under 512 KiB and refuses unsafe generic truncation", () => {
    expect(fitProviderSemanticResult({ records: [{ id: "1" }] })).toEqual({
      value: { records: [{ id: "1" }] },
      truncated: false,
      truncationReasons: []
    });
    expect(() => fitProviderSemanticResult({ text: "x".repeat(513 * 1024) }))
      .toThrowError(expect.objectContaining({ code: "PROVIDER_OUTPUT_LIMIT_EXCEEDED" }));
  });

  it("rejects non-JSON semantic result values instead of exposing raw provider objects", () => {
    expect(() => fitProviderSemanticResult(Buffer.from("raw-provider-body")))
      .toThrowError(expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID" }));
    expect(() => normalizeProviderValue({ x: Number.NaN }))
      .toThrowError(expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID" }));
  });
});
