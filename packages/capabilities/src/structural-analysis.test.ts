import { describe, expect, it } from "vitest";

import * as schemas from "./schemas.js";

type RuntimeSchema = {
  parse(value: unknown): unknown;
};

function schema(name: string): RuntimeSchema {
  const candidate = (schemas as Record<string, unknown>)[name];
  expect(candidate, `${name} must be exported from schemas.ts`).toBeDefined();
  return candidate as RuntimeSchema;
}

describe("structural repository evidence contracts", () => {
  it("accepts only positive ordered source regions", () => {
    const sourceRegion = schema("SourceRegionSchema");

    expect(sourceRegion.parse({ startLine: 4, endLine: 12 })).toEqual({ startLine: 4, endLine: 12 });
    expect(() => sourceRegion.parse({ startLine: 0, endLine: 12 })).toThrow();
    expect(() => sourceRegion.parse({ startLine: 12, endLine: 4 })).toThrow();
  });

  it("parses bounded structural file evidence with explicit precision", () => {
    const structuralFile = schema("StructuralFileAnalysisSchema");
    const value = {
      path: "src/invoice.ts",
      language: "typescript",
      precision: "structural",
      symbols: [
        {
          name: "calculateInvoice",
          kind: "function",
          path: "src/invoice.ts",
          line: 4,
          exported: true,
          region: { startLine: 4, endLine: 12 }
        }
      ],
      references: [
        {
          name: "buildInvoice",
          path: "src/invoice.ts",
          line: 9,
          column: 10,
          kind: "reference",
          region: { startLine: 9, endLine: 9 }
        }
      ],
      relationships: [
        {
          from: "src/invoice.ts",
          to: "src/money.ts",
          kind: "imports",
          precision: "structural"
        }
      ],
      warnings: []
    } as const;

    expect(structuralFile.parse(value)).toEqual(value);
    expect(() => structuralFile.parse({ ...value, precision: "exact" })).toThrow();
    expect(() =>
      structuralFile.parse({
        ...value,
        references: [{ ...value.references[0], line: 0 }]
      })
    ).toThrow();
  });
});
