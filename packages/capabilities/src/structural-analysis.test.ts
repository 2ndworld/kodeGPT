import { describe, expect, it } from "vitest";

import * as schemas from "./schemas.js";

type StructuralAnalyzerModule = typeof import("./structural-analysis.js");

async function structuralAnalyzer(): Promise<StructuralAnalyzerModule> {
  return import("./structural-analysis.js");
}

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

describe("bounded structural analysis dispatch", () => {
  it("routes TypeScript structurally and Rust to explicit heuristic fallback", async () => {
    const { analyzeStructuralFile } = await structuralAnalyzer();

    const typescript = analyzeStructuralFile({
      path: "src/invoice.ts",
      contents: "export function calculateInvoice() { return 1; }"
    });
    const rust = analyzeStructuralFile({
      path: "src/lib.rs",
      contents: "pub fn calculate_invoice() -> i32 { 1 }"
    });

    expect(typescript).toMatchObject({
      language: "typescript",
      precision: "structural",
      warnings: []
    });
    expect(rust).toMatchObject({
      language: "rust",
      precision: "heuristic",
      warnings: ["STRUCTURAL_FALLBACK_HEURISTIC"]
    });
    expect(analyzeStructuralFile({ path: "src/tool.py", contents: "def tool(): pass" })).toBeUndefined();
  });

  it("marks parser-diagnostic TypeScript as incomplete instead of claiming clean structural precision", async () => {
    const { analyzeStructuralFile } = await structuralAnalyzer();
    const result = analyzeStructuralFile({
      path: "src/broken.ts",
      contents: "export function broken( { return 1; }"
    });

    expect(result).toBeDefined();
    expect(result?.precision).toBe("heuristic");
    expect(result?.warnings).toContain("STRUCTURAL_PARSE_FAILED");
  });

  it("bounds structural records and keeps deterministic ordering", async () => {
    const { analyzeStructuralFile, MAX_STRUCTURAL_SYMBOLS_PER_FILE } = await structuralAnalyzer();
    const contents = Array.from({ length: MAX_STRUCTURAL_SYMBOLS_PER_FILE + 20 }, (_, index) =>
      `export const value${String(index).padStart(4, "0")} = ${index};`
    ).join("\n");

    const first = analyzeStructuralFile({ path: "src/generated.ts", contents });
    const second = analyzeStructuralFile({ path: "src/generated.ts", contents });

    expect(first?.symbols).toHaveLength(MAX_STRUCTURAL_SYMBOLS_PER_FILE);
    expect(first?.warnings).toContain("STRUCTURAL_SYMBOL_LIMIT_REACHED");
    expect(second).toEqual(first);
  });
});
