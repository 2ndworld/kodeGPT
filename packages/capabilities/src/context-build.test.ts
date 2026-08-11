import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTEXT_MAX_BYTES,
  type CodeSearchResult,
  type GitChangesResult,
  type VerifyListResult,
  type WorkspaceInspectResult
} from "./contracts.js";
import { buildContext, INTENT_WEIGHTS } from "./context-build.js";

function sources(contents: Record<string, string>) {
  const workspace: WorkspaceInspectResult = {
    schemaVersion: 1,
    workspaceId: "ws_1",
    root: ".",
    projectTypes: ["node-pnpm"],
    languages: [{ name: "TypeScript", fileCount: 8 }],
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
    warnings: [],
    truncated: false
  };
  const git: GitChangesResult = {
    schemaVersion: 1,
    workspaceId: "ws_1",
    clean: false,
    changedPaths: [
      { path: "packages/core/src/helper.ts", worktreeStatus: "M" },
      { path: "packages/other/src/unrelated.ts", worktreeStatus: "M" }
    ],
    summary: { changedFiles: 2 },
    truncated: false,
    fingerprint: "a".repeat(64)
  };
  const search: CodeSearchResult = {
    schemaVersion: 1,
    mode: "path",
    precision: "lexical",
    matches: [
      { path: "packages/core/src/workspace-manager.ts", kind: "path" },
      { path: "packages/core/src/workspace-manager-helper.ts", kind: "path" },
      { path: "packages/core/src/workspace-manager.test.ts", kind: "path" }
    ],
    truncated: false,
    truncationReasons: []
  };
  const verify: VerifyListResult = {
    schemaVersion: 1,
    workspaceId: "ws_1",
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
  const readCalls: string[] = [];
  return {
    adapter: {
      inspect: async () => workspace,
      git: async () => git,
      search: async () => search,
      verify: async () => verify,
      readFile: async (_workspaceId: string, path: string, options?: { maxBytes?: number }) => {
        readCalls.push(path);
        const value = contents[path];
        if (value === undefined) throw new Error("missing");
        const maxBytes = options?.maxBytes ?? DEFAULT_CONTEXT_MAX_BYTES;
        const bytes = Buffer.from(value, "utf8");
        if (bytes.length <= maxBytes) return { contents: value, bytesRead: bytes.length, eof: true };
        return {
          contents: bytes.subarray(0, maxBytes).toString("utf8"),
          bytesRead: maxBytes,
          eof: false
        };
      }
    },
    readCalls
  };
}

const TARGET = "packages/core/src/workspace-manager.ts";

describe("context.build", () => {
  it("selects deterministic priority tiers with lexical ties and reuses existing capability evidence", async () => {
    const fixture = sources({
      [TARGET]: "target\n",
      "packages/core/src/helper.ts": "changed\n",
      "package.json": "root-manifest\n",
      "packages/core/package.json": "core-manifest\n",
      "packages/core/src/workspace-manager-helper.ts": "search-hit\n",
      "packages/core/src/workspace-manager.test.ts": "test-hit\n"
    });

    const result = await buildContext(fixture.adapter, {
      workspaceId: "ws_1",
      intent: "implement",
      target: TARGET,
      maxBytes: 1024
    });

    expect(result.selectedFiles.map(({ path, reason }) => ({ path, reason }))).toEqual([
      { path: TARGET, reason: "exact-target" },
      { path: "packages/core/src/helper.ts", reason: "changed-same-area" },
      { path: "package.json", reason: "governing-manifest" },
      { path: "packages/core/package.json", reason: "governing-manifest" },
      { path: "packages/core/src/workspace-manager-helper.ts", reason: "exact-search-hit" },
      { path: "packages/core/src/workspace-manager.test.ts", reason: "nearby-test" }
    ]);
    expect(fixture.readCalls).toEqual(result.selectedFiles.map((file) => file.path));
    expect(result.relevantMatches).toEqual([
      { path: "packages/core/src/workspace-manager-helper.ts", kind: "path" },
      { path: "packages/core/src/workspace-manager.test.ts", kind: "path" },
      { path: TARGET, kind: "path" }
    ]);
    expect(result.verifications.map((recipe) => recipe.id)).toEqual(["package:test"]);
    expect(result.truncated).toBe(false);
    expect(result.totalBytes).toBe(
      result.selectedFiles.reduce((sum, file) => sum + Buffer.byteLength(file.content ?? ""), 0)
    );
  });

  it("never exceeds the byte budget and omits later candidates deterministically", async () => {
    const fixture = sources({
      [TARGET]: "1234567890",
      "packages/core/src/helper.ts": "abcdefghij",
      "package.json": "manifest",
      "packages/core/package.json": "core",
      "packages/core/src/workspace-manager-helper.ts": "search",
      "packages/core/src/workspace-manager.test.ts": "test"
    });

    const result = await buildContext(fixture.adapter, {
      workspaceId: "ws_1",
      intent: "review",
      target: TARGET,
      maxBytes: 20
    });

    expect(result.totalBytes).toBeLessThanOrEqual(20);
    expect(result.selectedFiles.map((file) => file.path)).toEqual([
      TARGET,
      "packages/core/src/helper.ts"
    ]);
    expect(result.truncated).toBe(true);
    expect(fixture.readCalls).toEqual([TARGET, "packages/core/src/helper.ts"]);
  });

  it("uses explicit intent weights while preserving hard priority tiers", () => {
    expect(INTENT_WEIGHTS.understand).toMatchObject({ target: 100, changed: 40, tests: 20, config: 50 });
    expect(INTENT_WEIGHTS.implement.tests).toBe(70);
    expect(INTENT_WEIGHTS.debug.changed).toBe(80);
    expect(INTENT_WEIGHTS.review.changed).toBe(100);
    expect(INTENT_WEIGHTS.verify.tests).toBe(100);
  });

  it("rejects unsafe targets and invalid runtime intents before reading workspace content", async () => {
    const fixture = sources({});
    await expect(
      buildContext(fixture.adapter, {
        workspaceId: "ws_1",
        intent: "understand",
        target: "../escape.ts"
      })
    ).rejects.toMatchObject({ code: "CAPABILITY_INPUT_INVALID" });
    await expect(
      buildContext(fixture.adapter, {
        workspaceId: "ws_1",
        intent: "unsafe" as "understand"
      })
    ).rejects.toMatchObject({ code: "CAPABILITY_INPUT_INVALID" });
    expect(fixture.readCalls).toEqual([]);
  });
});
