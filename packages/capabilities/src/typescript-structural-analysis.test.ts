import { describe, expect, it } from "vitest";

type AnalyzerModule = typeof import("./typescript-structural-analysis.js");

async function analyzer(): Promise<AnalyzerModule> {
  return import("./typescript-structural-analysis.js");
}

describe("TypeScript structural analysis", () => {
  it("extracts multiline and nested declarations with exact source regions", async () => {
    const { analyzeTypeScriptSource } = await analyzer();
    const contents = [
      "export async function calculateInvoice(",
      "  input: InvoiceInput",
      "): Promise<Invoice> {",
      "  function normalizeSubtotal(value: number) {",
      "    return Math.max(0, value);",
      "  }",
      "  return buildInvoice(normalizeSubtotal(input.subtotal));",
      "}",
      "",
      "export class InvoiceService {",
      "  create() {}",
      "}",
      "",
      "export interface InvoiceInput {",
      "  subtotal: number;",
      "}",
      "",
      "export type Invoice = { total: number };",
      "export enum InvoiceKind { Retail, Wholesale }",
      "export const defaultCurrency = \"IDR\";"
    ].join("\n");

    const result = analyzeTypeScriptSource({ path: "src/invoice.ts", contents });

    expect(result.precision).toBe("structural");
    expect(result.language).toBe("typescript");
    expect(result.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "calculateInvoice",
          kind: "function",
          line: 1,
          exported: true,
          region: { startLine: 1, endLine: 8 }
        }),
        expect.objectContaining({
          name: "normalizeSubtotal",
          kind: "function",
          line: 4,
          exported: false,
          region: { startLine: 4, endLine: 6 }
        }),
        expect.objectContaining({
          name: "InvoiceService",
          kind: "class",
          line: 10,
          exported: true,
          region: { startLine: 10, endLine: 12 }
        }),
        expect.objectContaining({
          name: "InvoiceInput",
          kind: "interface",
          line: 14,
          exported: true,
          region: { startLine: 14, endLine: 16 }
        }),
        expect.objectContaining({ name: "Invoice", kind: "type", line: 18, exported: true }),
        expect.objectContaining({ name: "InvoiceKind", kind: "enum", line: 19, exported: true }),
        expect.objectContaining({ name: "defaultCurrency", kind: "variable", line: 20, exported: true })
      ])
    );
    expect(result.warnings).toEqual([]);
  });

  it("uses JavaScript script kind for JavaScript sources", async () => {
    const { analyzeTypeScriptSource } = await analyzer();
    const result = analyzeTypeScriptSource({
      path: "src/checkout.js",
      contents: "export function checkout() { return 1; }"
    });

    expect(result.language).toBe("javascript");
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ name: "checkout", kind: "function", exported: true })
    );
  });

  it("extracts AST-role-aware references and relative module relationships", async () => {
    const { analyzeTypeScriptSource } = await analyzer();
    const contents = [
      'import { money as formatMoney } from "./money.js";',
      'export { taxRate } from "./tax.js";',
      '',
      'const note = "calculateInvoice formatMoney should not count";',
      '// calculateInvoice formatMoney should not count either',
      'const metadata = { calculateInvoice: true };',
      '',
      'export function checkout(total: number) {',
      '  return calculateInvoice(formatMoney(total));',
      '}'
    ].join("\n");

    const result = analyzeTypeScriptSource({ path: "src/checkout.ts", contents });
    const names = result.references.map((reference) => reference.name);

    expect(result.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "calculateInvoice", line: 9, kind: "reference" }),
        expect.objectContaining({ name: "formatMoney", line: 9, kind: "reference" }),
        expect.objectContaining({ name: "total", line: 9, kind: "reference" })
      ])
    );
    expect(names.filter((name) => name === "calculateInvoice")).toHaveLength(1);
    expect(names.filter((name) => name === "formatMoney")).toHaveLength(1);
    expect(result.relationships).toEqual(
      expect.arrayContaining([
        {
          from: "src/checkout.ts",
          to: "src/money.js",
          kind: "imports",
          precision: "structural"
        },
        {
          from: "src/checkout.ts",
          to: "src/tax.js",
          kind: "imports",
          precision: "structural"
        }
      ])
    );
  });
});
