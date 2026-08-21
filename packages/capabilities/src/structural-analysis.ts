import { posix } from "node:path";

import type { StructuralFileAnalysis } from "./contracts.js";
import { analyzeTypeScriptSource } from "./typescript-structural-analysis.js";

export const MAX_STRUCTURAL_SYMBOLS_PER_FILE = 1_000;
export const MAX_STRUCTURAL_REFERENCES_PER_FILE = 2_000;
export const MAX_STRUCTURAL_RELATIONSHIPS_PER_FILE = 1_000;

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export function analyzeStructuralFile(input: {
  path: string;
  contents: string;
}): StructuralFileAnalysis | undefined {
  const extension = posix.extname(input.path).toLowerCase();

  if (TYPESCRIPT_EXTENSIONS.has(extension)) {
    return boundAnalysis(analyzeTypeScriptSource(input));
  }

  if (extension === ".rs") {
    return {
      path: input.path,
      language: "rust",
      precision: "heuristic",
      symbols: [],
      references: [],
      relationships: [],
      warnings: ["STRUCTURAL_FALLBACK_HEURISTIC"]
    };
  }

  return undefined;
}

function boundAnalysis(analysis: StructuralFileAnalysis): StructuralFileAnalysis {
  const warnings = new Set(analysis.warnings);
  if (analysis.symbols.length > MAX_STRUCTURAL_SYMBOLS_PER_FILE) {
    warnings.add("STRUCTURAL_SYMBOL_LIMIT_REACHED");
  }
  if (analysis.references.length > MAX_STRUCTURAL_REFERENCES_PER_FILE) {
    warnings.add("STRUCTURAL_REFERENCE_LIMIT_REACHED");
  }
  if (analysis.relationships.length > MAX_STRUCTURAL_RELATIONSHIPS_PER_FILE) {
    warnings.add("STRUCTURAL_RELATIONSHIP_LIMIT_REACHED");
  }

  return {
    ...analysis,
    symbols: analysis.symbols.slice(0, MAX_STRUCTURAL_SYMBOLS_PER_FILE),
    references: analysis.references.slice(0, MAX_STRUCTURAL_REFERENCES_PER_FILE),
    relationships: analysis.relationships.slice(0, MAX_STRUCTURAL_RELATIONSHIPS_PER_FILE),
    warnings: [...warnings].sort(compareText)
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
