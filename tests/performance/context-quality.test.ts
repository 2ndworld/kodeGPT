import { describe, expect, it } from "vitest";

import type {
  CodeSearchResult,
  ContextIntent,
  GitChangesResult,
  VerifyListResult,
  WorkspaceInspectResult
} from "../../packages/capabilities/src/contracts.js";
import { buildContext } from "../../packages/capabilities/src/context-build.js";

type Scenario = {
  name: string;
  intent: ContextIntent;
  target: string;
  criticalPaths: string[];
  relationships: WorkspaceInspectResult["relationships"];
  changedPaths: string[];
  searchPaths: string[];
  forbiddenNoise: string[];
  workspaceTruncated?: boolean;
  workspaceWarnings?: string[];
};

const scenarios: Scenario[] = [
  {
    name: "implementation context prefers direct test/dependency/dependent evidence over lexical noise",
    intent: "implement",
    target: "packages/core/src/session.ts",
    criticalPaths: [
      "packages/core/src/session.test.ts",
      "packages/core/src/session-store.ts",
      "packages/core/src/session-route.ts"
    ],
    relationships: [
      { from: "packages/core/src/session.test.ts", to: "packages/core/src/session.ts", kind: "tests" },
      { from: "packages/core/src/session.ts", to: "packages/core/src/session-store.ts", kind: "imports" },
      { from: "packages/core/src/session-route.ts", to: "packages/core/src/session.ts", kind: "imports" }
    ],
    changedPaths: ["packages/core/src/noisy-change.ts"],
    searchPaths: [
      "packages/core/src/session-view.ts",
      "packages/core/src/session.test.ts",
      "node_modules/pkg/session.ts",
      ".worktrees/old/session.ts"
    ],
    forbiddenNoise: ["node_modules/pkg/session.ts", ".worktrees/old/session.ts"]
  },
  {
    name: "debug context keeps four direct graph relationships inside the first five files",
    intent: "debug",
    target: "packages/core/src/processor.ts",
    criticalPaths: [
      "packages/core/tests/processor.test.ts",
      "packages/core/src/a-input.ts",
      "packages/core/src/b-output.ts",
      "packages/core/src/processor-route.ts"
    ],
    relationships: [
      { from: "packages/core/tests/processor.test.ts", to: "packages/core/src/processor.ts", kind: "tests" },
      { from: "packages/core/src/processor.ts", to: "packages/core/src/a-input.ts", kind: "imports" },
      { from: "packages/core/src/processor.ts", to: "packages/core/src/b-output.ts", kind: "imports" },
      { from: "packages/core/src/processor-route.ts", to: "packages/core/src/processor.ts", kind: "imports" }
    ],
    changedPaths: ["packages/core/src/processor-doc.ts"],
    searchPaths: [
      "packages/core/src/processor-view.ts",
      "packages/core/src/processor-helper.ts",
      "target/generated/processor.ts"
    ],
    forbiddenNoise: ["target/generated/processor.ts"]
  },
  {
    name: "partial workspace evidence retains high-value relationships without admitting excluded noise",
    intent: "review",
    target: "packages/core/src/config-loader.ts",
    criticalPaths: [
      "packages/core/src/config-loader.test.ts",
      "packages/core/src/config-store.ts",
      "packages/core/src/config-defaults.ts"
    ],
    relationships: [
      { from: "packages/core/src/config-loader.test.ts", to: "packages/core/src/config-loader.ts", kind: "tests" },
      { from: "packages/core/src/config-loader.ts", to: "packages/core/src/config-store.ts", kind: "imports" }
    ],
    changedPaths: ["packages/core/src/config-defaults.ts", "packages/other/src/unrelated.ts"],
    searchPaths: [
      "packages/core/src/config-view.ts",
      "node_modules/pkg/config-loader.ts"
    ],
    forbiddenNoise: ["node_modules/pkg/config-loader.ts"],
    workspaceTruncated: true,
    workspaceWarnings: ["INSPECT_SYMBOL_LIMIT_REACHED"]
  }
];

describe("context quality benchmark", () => {
  it("keeps critical implementation evidence inside a bounded top-five quality envelope", async () => {
    let criticalCount = 0;
    let recalledAtFive = 0;
    let rankTotal = 0;
    let maxCriticalRank = 0;
    let duplicateSelections = 0;
    let forbiddenSelections = 0;

    for (const scenario of scenarios) {
      const result = await runScenario(scenario);
      const selectedPaths = result.selectedFiles.map((file) => file.path);
      const uniquePaths = new Set(selectedPaths);
      duplicateSelections += selectedPaths.length - uniquePaths.size;

      for (const noisePath of scenario.forbiddenNoise) {
        if (uniquePaths.has(noisePath)) forbiddenSelections += 1;
      }

      for (const path of scenario.criticalPaths) {
        criticalCount += 1;
        const rank = selectedPaths.indexOf(path) + 1;
        if (rank > 0 && rank <= 5) recalledAtFive += 1;
        if (rank > 0) {
          rankTotal += rank;
          maxCriticalRank = Math.max(maxCriticalRank, rank);
        }
      }

      if (scenario.workspaceTruncated) {
        expect(result.evidenceStatus.workspace, scenario.name).toBe("incomplete");
        expect(result.truncated, scenario.name).toBe(true);
      }
    }

    const criticalRecallAtFive = recalledAtFive / criticalCount;
    const meanCriticalRank = rankTotal / criticalCount;

    expect(criticalRecallAtFive).toBe(1);
    expect(maxCriticalRank).toBeLessThanOrEqual(5);
    expect(meanCriticalRank).toBeLessThanOrEqual(3.5);
    expect(duplicateSelections).toBe(0);
    expect(forbiddenSelections).toBe(0);
  });
});

async function runScenario(scenario: Scenario) {
  const workspace: WorkspaceInspectResult = {
    schemaVersion: 1,
    workspaceId: "ws_benchmark",
    root: ".",
    projectTypes: ["node-pnpm"],
    languages: [{ name: "TypeScript", fileCount: 32 }],
    entrypoints: [],
    areas: [
      { path: "packages/core", kind: "package" },
      { path: "packages/other", kind: "package" }
    ],
    manifests: [
      { path: "package.json", kind: "node-package" },
      { path: "packages/core/package.json", kind: "node-package" },
      { path: "packages/other/package.json", kind: "node-package" }
    ],
    symbols: [],
    relationships: scenario.relationships,
    warnings: scenario.workspaceWarnings ?? [],
    truncated: scenario.workspaceTruncated ?? false
  };

  const git: GitChangesResult = {
    schemaVersion: 1,
    workspaceId: "ws_benchmark",
    clean: scenario.changedPaths.length === 0,
    changedPaths: scenario.changedPaths.map((path) => ({ path, worktreeStatus: "M" })),
    summary: { changedFiles: scenario.changedPaths.length },
    truncated: false,
    fingerprint: "a".repeat(64)
  };

  const search: CodeSearchResult = {
    schemaVersion: 1,
    mode: "path",
    precision: "lexical",
    matches: scenario.searchPaths.map((path) => ({ path, kind: "path" })),
    truncated: false,
    truncationReasons: []
  };

  const verify: VerifyListResult = {
    schemaVersion: 1,
    workspaceId: "ws_benchmark",
    recipes: [
      {
        id: "package:test",
        label: "Package test",
        category: "test",
        logicalExecutable: "pnpm",
        argv: ["run", "test"],
        cwd: ".",
        source: "package-script",
        allowed: true
      }
    ]
  };

  const readablePaths = new Set([
    scenario.target,
    ...scenario.criticalPaths,
    ...scenario.changedPaths,
    ...scenario.searchPaths,
    "package.json",
    "packages/core/package.json",
    "packages/other/package.json"
  ]);

  return buildContext(
    {
      inspect: async () => workspace,
      git: async () => git,
      search: async () => search,
      verify: async () => verify,
      readFile: async (_workspaceId, path, options) => {
        if (!readablePaths.has(path)) throw new Error(`benchmark fixture missing ${path}`);
        const contents = `${path}\n`;
        const maxBytes = options?.maxBytes ?? Buffer.byteLength(contents, "utf8");
        const bytes = Buffer.from(contents, "utf8");
        if (bytes.length <= maxBytes) return { contents, bytesRead: bytes.length, eof: true };
        const bounded = bytes.subarray(0, maxBytes);
        return { contents: bounded.toString("utf8"), bytesRead: bounded.length, eof: false };
      }
    },
    {
      workspaceId: "ws_benchmark",
      intent: scenario.intent,
      target: scenario.target,
      maxBytes: 64 * 1024
    }
  );
}
