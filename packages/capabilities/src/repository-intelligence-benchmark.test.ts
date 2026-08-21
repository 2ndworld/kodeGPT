import { describe, expect, it } from "vitest";

import type {
  CapabilitySearchMatch,
  CapabilityTreeEntry,
  CodeSearchAdapter,
  WorkspaceInspectionAdapter
} from "./adapters.js";
import type {
  CodeSearchInput,
  GitChangesResult,
  VerifyListInput,
  VerifyListResult,
  WorkspaceInspectInput
} from "./contracts.js";
import { buildContext, type ContextBuildAdapter } from "./context-build.js";
import { searchCode } from "./code-search.js";
import { inspectWorkspace } from "./workspace-inspect.js";

const TARGET = "packages/billing/src/invoice.ts";
const TEST = "packages/billing/src/invoice.test.ts";
const APP = "packages/app/src/use.ts";
const REEXPORT = "packages/app/src/reexport.ts";
const BROKEN = "packages/billing/src/broken.ts";

function benchmarkFixture() {
  const targetLines = Array.from({ length: 260 }, (_, index) => `// unrelated invoice line ${index + 1}`);
  targetLines[10] = "export interface InvoiceInput { subtotal: number }";
  targetLines[20] = "export type Invoice = { total: number };";
  targetLines[179] = "export function calculateInvoice(";
  targetLines[180] = "  input: InvoiceInput";
  targetLines[181] = "): Invoice {";
  targetLines[182] = "  function normalizeSubtotal(value: number) {";
  targetLines[183] = "    return Math.max(0, value);";
  targetLines[184] = "  }";
  for (let line = 186; line < 220; line += 1) {
    targetLines[line - 1] = `  const step${line} = normalizeSubtotal(input.subtotal) + ${line};`;
  }
  targetLines[218] = "  return { total: step218 };";
  targetLines[219] = "}";

  const files: Record<string, string> = {
    "package.json": '{"private":true,"workspaces":["packages/*"]}\n',
    "packages/billing/package.json": '{"name":"@bench/billing"}\n',
    "packages/app/package.json": '{"name":"@bench/app"}\n',
    [TARGET]: targetLines.join("\n"),
    [TEST]: [
      'import { calculateInvoice } from "./invoice.js";',
      "test(\"invoice\", () => calculateInvoice({ subtotal: 1 }));"
    ].join("\n"),
    [APP]: [
      'import { calculateInvoice } from "../../billing/src/invoice.js";',
      'import { calculateInvoice as calc } from "../../billing/src/invoice.js";',
      'const note = "calculateInvoice should not count";',
      "// calculateInvoice should not count either",
      "const metadata = { calculateInvoice: true };",
      "export function run(input: InvoiceInput) {",
      "  return calculateInvoice(input).total + calc(input).total;",
      "}"
    ].join("\n"),
    [REEXPORT]: 'export { calculateInvoice } from "../../billing/src/invoice.js";\n',
    [BROKEN]: "export function broken( { return 1; }\n"
  };

  const directories = new Set<string>();
  for (const path of Object.keys(files)) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  const entries: CapabilityTreeEntry[] = [
    ...[...directories].sort().map((path) => ({ path, kind: "directory" as const })),
    ...Object.keys(files)
      .sort()
      .map((path) => ({ path, kind: "file" as const }))
  ];

  const workspace: WorkspaceInspectionAdapter = {
    async readFile(_workspaceId, path, options) {
      const contents = files[path];
      if (contents === undefined) throw new Error(`missing ${path}`);
      const bytes = Buffer.from(contents, "utf8");
      const maxBytes = options?.maxBytes ?? Number.MAX_SAFE_INTEGER;
      const retained = bytes.subarray(0, maxBytes).toString("utf8");
      return {
        contents: retained,
        bytesRead: Buffer.byteLength(retained, "utf8"),
        eof: bytes.byteLength <= maxBytes
      };
    },
    async tree(_workspaceId, path, maxEntries) {
      const scopePath = path ?? ".";
      const prefix = scopePath === "." ? "" : `${scopePath.replace(/\/$/, "")}/`;
      const scoped = entries.filter(
        (entry) => scopePath === "." || entry.path === scopePath || entry.path.startsWith(prefix)
      );
      return { entries: scoped.slice(0, maxEntries), truncated: scoped.length > maxEntries };
    }
  };

  const lexicalSearch: CodeSearchAdapter = {
    async search(_workspaceId, query, path, maxMatches) {
      const matches: CapabilitySearchMatch[] = [];
      for (const [filePath, contents] of Object.entries(files).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      )) {
        if (path !== undefined && filePath !== path && !filePath.startsWith(`${path}/`)) continue;
        contents.split(/\r?\n/).forEach((lineText, index) => {
          if (lineText.includes(query)) matches.push({ path: filePath, line: index + 1, lineText });
        });
      }
      return {
        matches: matches.slice(0, maxMatches),
        truncated: matches.length > maxMatches,
        truncationReasons: matches.length > maxMatches ? ["MATCH_LIMIT"] : []
      };
    }
  };

  const context: ContextBuildAdapter = {
    inspect: (input: WorkspaceInspectInput) => inspectWorkspace(workspace, input),
    git: async (): Promise<GitChangesResult> => ({
      schemaVersion: 1,
      workspaceId: "ws_benchmark",
      clean: true,
      changedPaths: [],
      summary: { changedFiles: 0 },
      truncated: false,
      fingerprint: "b".repeat(64),
      sourceState: {
        headOid: "2".repeat(40),
        changesFingerprint: "b".repeat(64)
      }
    }),
    search: (input: CodeSearchInput) => searchCode(workspace, lexicalSearch, input),
    verify: async (_input: VerifyListInput): Promise<VerifyListResult> => ({
      schemaVersion: 1,
      workspaceId: "ws_benchmark",
      recipes: []
    }),
    readFile: workspace.readFile
  };

  return { files, workspace, lexicalSearch, context };
}

function ratio(actual: Set<string>, expected: Set<string>): { precision: number; recall: number } {
  const truePositive = [...actual].filter((value) => expected.has(value)).length;
  return {
    precision: actual.size === 0 ? 1 : truePositive / actual.size,
    recall: expected.size === 0 ? 1 : truePositive / expected.size
  };
}

describe("semantic repository intelligence benchmark", () => {
  it("meets deterministic definition, reference, relationship, and parser-isolation gates", async () => {
    const fixture = benchmarkFixture();
    const inspection = await inspectWorkspace(fixture.workspace, {
      workspaceId: "ws_benchmark",
      maxEntries: 1_000
    });

    const definitions = await searchCode(fixture.workspace, fixture.lexicalSearch, {
      workspaceId: "ws_benchmark",
      query: "calculateInvoice",
      mode: "definition",
      maxResults: 100
    });
    const references = await searchCode(fixture.workspace, fixture.lexicalSearch, {
      workspaceId: "ws_benchmark",
      query: "calculateInvoice",
      mode: "reference",
      maxResults: 100
    });
    const repeatedReferences = await searchCode(fixture.workspace, fixture.lexicalSearch, {
      workspaceId: "ws_benchmark",
      query: "calculateInvoice",
      mode: "reference",
      maxResults: 100
    });

    expect(definitions.precision).toBe("structural");
    expect(definitions.matches).toEqual([
      expect.objectContaining({ path: TARGET, line: 180, kind: "definition" })
    ]);

    const expectedReferences = new Set([`${APP}:7`, `${TEST}:2`]);
    const actualReferences = new Set(references.matches.map((match) => `${match.path}:${match.line}`));
    const quality = ratio(actualReferences, expectedReferences);
    expect(quality.precision).toBeGreaterThanOrEqual(0.95);
    expect(quality.recall).toBeGreaterThanOrEqual(0.95);
    expect(actualReferences).not.toContain(`${APP}:3`);
    expect(actualReferences).not.toContain(`${APP}:4`);
    expect(actualReferences).not.toContain(`${APP}:5`);
    expect(repeatedReferences).toEqual(references);

    const expectedRelationships = new Set([
      `${APP}->${TARGET}:imports`,
      `${REEXPORT}->${TARGET}:imports`,
      `${TEST}->${TARGET}:imports`,
      `${TEST}->${TARGET}:tests`
    ]);
    const actualRelationships = new Set(
      inspection.relationships.map((relationship) =>
        `${relationship.from}->${relationship.to}:${relationship.kind}`
      )
    );
    for (const relationship of expectedRelationships) expect(actualRelationships).toContain(relationship);
    expect(inspection.warnings).toContain("STRUCTURAL_PARSE_FAILED");
    expect(inspection.symbols).toContainEqual(
      expect.objectContaining({
        name: "normalizeSubtotal",
        path: TARGET,
        line: 183,
        region: { startLine: 183, endLine: 185 }
      })
    );
  });

  it("keeps structurally focused context materially below whole-file baseline", async () => {
    const fixture = benchmarkFixture();
    const result = await buildContext(fixture.context, {
      workspaceId: "ws_benchmark",
      intent: "implement",
      target: TARGET,
      focus: "calculateInvoice",
      maxBytes: 32 * 1024
    });

    const target = result.selectedFiles.find((file) => file.path === TARGET);
    const relatedTest = result.selectedFiles.find((file) => file.path === TEST);
    const wholeFileBaseline = Buffer.byteLength(fixture.files[TARGET]!, "utf8");

    expect(target).toMatchObject({
      path: TARGET,
      region: { startLine: 180, endLine: 220 },
      truncated: false
    });
    expect(target?.content).toContain("export function calculateInvoice(");
    expect(target?.content).not.toContain("unrelated invoice line 1");
    expect(relatedTest?.content).toContain("calculateInvoice");
    expect(Buffer.byteLength(target?.content ?? "", "utf8")).toBeLessThan(wholeFileBaseline * 0.5);
    expect(result.totalBytes).toBeLessThan(wholeFileBaseline);
  });
});
