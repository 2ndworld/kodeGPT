import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTEXT_MAX_BYTES,
  type CodeSearchResult,
  type GitChangesResult,
  type VerifyListResult,
  type WorkspaceInspectResult
} from "./contracts.js";
import { buildContext, INTENT_WEIGHTS } from "./context-build.js";
import { CapabilityError } from "./errors.js";

type SourceOptions = {
  extraSearchMatches?: CodeSearchResult["matches"];
  workspaceTruncated?: boolean;
  gitTruncated?: boolean;
  searchTruncated?: boolean;
  inspectFailure?: unknown;
  gitFailure?: unknown;
  searchFailure?: unknown;
  verifyFailure?: unknown;
  unreadablePaths?: string[];
};

function sources(contents: Record<string, string>, options: SourceOptions = {}) {
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
    symbols: [],
    relationships: [],
    warnings: [],
    truncated: options.workspaceTruncated ?? false
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
    truncated: options.gitTruncated ?? false,
    fingerprint: "a".repeat(64)
  };
  const search: CodeSearchResult = {
    schemaVersion: 1,
    mode: "path",
    precision: "lexical",
    matches: [
      { path: "packages/core/src/workspace-manager.ts", kind: "path" },
      { path: "packages/core/src/workspace-manager-helper.ts", kind: "path" },
      { path: "packages/core/src/workspace-manager.test.ts", kind: "path" },
      ...(options.extraSearchMatches ?? [])
    ],
    truncated: options.searchTruncated ?? false,
    truncationReasons: options.searchTruncated ? ["MATCH_LIMIT"] : []
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
      inspect: async () => {
        if (options.inspectFailure !== undefined) throw options.inspectFailure;
        return workspace;
      },
      git: async () => {
        if (options.gitFailure !== undefined) throw options.gitFailure;
        return git;
      },
      search: async () => {
        if (options.searchFailure !== undefined) throw options.searchFailure;
        return search;
      },
      verify: async () => {
        if (options.verifyFailure !== undefined) throw options.verifyFailure;
        return verify;
      },
      readFile: async (_workspaceId: string, path: string, readOptions?: { maxBytes?: number }) => {
        readCalls.push(path);
        if (options.unreadablePaths?.includes(path)) throw new Error("unreadable");
        const value = contents[path];
        if (value === undefined) throw new Error("missing");
        const maxBytes = readOptions?.maxBytes ?? DEFAULT_CONTEXT_MAX_BYTES;
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
    expect(result.evidenceStatus).toEqual({
      workspace: "available",
      git: "available",
      search: "available",
      verification: "available"
    });
    expect(result.truncated).toBe(false);
    expect(result.totalBytes).toBe(
      result.selectedFiles.reduce((sum, file) => sum + Buffer.byteLength(file.content ?? ""), 0)
    );
  });

  it("drops incidental semantic-excluded search evidence before selection and public relevantMatches", async () => {
    const fixture = sources(
      {
        [TARGET]: "target\n",
        "packages/core/src/helper.ts": "changed\n",
        "package.json": "root-manifest\n",
        "packages/core/package.json": "core-manifest\n",
        "packages/core/src/workspace-manager-helper.ts": "search-hit\n",
        "packages/core/src/workspace-manager.test.ts": "test-hit\n",
        "node_modules/pkg/workspace-manager.ts": "dependency-noise\n",
        ".worktrees/old/workspace-manager.ts": "worktree-noise\n",
        "target/generated/workspace-manager.ts": "generated-noise\n"
      },
      {
        extraSearchMatches: [
          { path: "node_modules/pkg/workspace-manager.ts", kind: "path" },
          { path: ".worktrees/old/workspace-manager.ts", kind: "path" },
          { path: "target/generated/workspace-manager.ts", kind: "path" }
        ]
      }
    );

    const result = await buildContext(fixture.adapter, {
      workspaceId: "ws_1",
      intent: "understand",
      target: TARGET,
      maxBytes: 1024
    });

    expect(result.selectedFiles.some(({ path }) => path.includes("node_modules"))).toBe(false);
    expect(result.selectedFiles.some(({ path }) => path.includes(".worktrees"))).toBe(false);
    expect(result.selectedFiles.some(({ path }) => path.startsWith("target/"))).toBe(false);
    expect(result.relevantMatches.some(({ path }) => path.includes("node_modules"))).toBe(false);
    expect(result.relevantMatches.some(({ path }) => path.includes(".worktrees"))).toBe(false);
    expect(result.relevantMatches.some(({ path }) => path.startsWith("target/"))).toBe(false);
    expect(fixture.readCalls.filter((path) => path === TARGET)).toHaveLength(1);
  });

  it("keeps an explicitly requested excluded target eligible for direct read", async () => {
    const explicitTarget = "node_modules/pkg/package.json";
    const fixture = sources({
      [explicitTarget]: "dependency-manifest\n",
      "package.json": "root-manifest\n"
    });

    const result = await buildContext(fixture.adapter, {
      workspaceId: "ws_1",
      intent: "understand",
      target: explicitTarget,
      maxBytes: 1024
    });

    expect(result.selectedFiles[0]).toMatchObject({
      path: explicitTarget,
      reason: "exact-target",
      content: "dependency-manifest\n"
    });
    expect(fixture.readCalls.filter((path) => path === explicitTarget)).toHaveLength(1);
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

  it("returns partial context when Git evidence is unavailable without fabricating clean Git", async () => {
    const fixture = sources(
      {
        [TARGET]: "target\n",
        "package.json": "root-manifest\n",
        "packages/core/package.json": "core-manifest\n",
        "packages/core/src/workspace-manager-helper.ts": "search-hit\n",
        "packages/core/src/workspace-manager.test.ts": "test-hit\n"
      },
      {
        gitFailure: new CapabilityError("GIT_INSPECTION_FAILED", "Git checkpoint inspection failed")
      }
    );

    const result = await buildContext(fixture.adapter, {
      workspaceId: "ws_1",
      intent: "debug",
      target: TARGET,
      maxBytes: 1024
    });

    expect(result.evidenceStatus).toEqual({
      workspace: "available",
      git: "unavailable",
      search: "available",
      verification: "available"
    });
    expect(result.git).toBeUndefined();
    expect(result.warnings).toContain("git-evidence-unavailable");
    expect(result.truncated).toBe(true);
    expect(result.selectedFiles.map((file) => file.path)).toContain(TARGET);
    expect(result.selectedFiles.some((file) => file.reason === "changed-same-area")).toBe(false);
    expect(result.verifications.map((recipe) => recipe.id)).toEqual(["package:test"]);
  });

  it("preserves non-Git evidence when search evidence is unavailable", async () => {
    const fixture = sources(
      {
        [TARGET]: "target\n",
        "packages/core/src/helper.ts": "changed\n",
        "package.json": "root-manifest\n",
        "packages/core/package.json": "core-manifest\n"
      },
      {
        searchFailure: new CapabilityError("CAPABILITY_SOURCE_INCOMPLETE", "Search source incomplete")
      }
    );

    const result = await buildContext(fixture.adapter, {
      workspaceId: "ws_1",
      intent: "understand",
      target: TARGET,
      maxBytes: 1024
    });

    expect(result.evidenceStatus.search).toBe("unavailable");
    expect(result.warnings).toContain("search-evidence-unavailable");
    expect(result.relevantMatches).toEqual([]);
    expect(result.selectedFiles.map((file) => file.path)).toContain(TARGET);
    expect(result.selectedFiles.map((file) => file.path)).toContain("packages/core/src/helper.ts");
    expect(result.truncated).toBe(true);
  });

  it("preserves workspace and source context when verification discovery is unavailable", async () => {
    const fixture = sources(
      {
        [TARGET]: "target\n",
        "packages/core/src/helper.ts": "changed\n",
        "package.json": "root-manifest\n",
        "packages/core/package.json": "core-manifest\n",
        "packages/core/src/workspace-manager-helper.ts": "search-hit\n",
        "packages/core/src/workspace-manager.test.ts": "test-hit\n"
      },
      {
        verifyFailure: new CapabilityError(
          "VERIFICATION_DISCOVERY_INVALID",
          "Verification discovery is invalid"
        )
      }
    );

    const result = await buildContext(fixture.adapter, {
      workspaceId: "ws_1",
      intent: "verify",
      target: TARGET,
      maxBytes: 1024
    });

    expect(result.evidenceStatus.verification).toBe("unavailable");
    expect(result.warnings).toContain("verification-evidence-unavailable");
    expect(result.verifications).toEqual([]);
    expect(result.workspace.workspaceId).toBe("ws_1");
    expect(result.selectedFiles.map((file) => file.path)).toContain(TARGET);
    expect(result.truncated).toBe(true);
  });

  it("marks bounded but truncated evidence as incomplete instead of unavailable", async () => {
    const fixture = sources(
      {
        [TARGET]: "target\n",
        "packages/core/src/helper.ts": "changed\n",
        "package.json": "root-manifest\n",
        "packages/core/package.json": "core-manifest\n",
        "packages/core/src/workspace-manager-helper.ts": "search-hit\n",
        "packages/core/src/workspace-manager.test.ts": "test-hit\n"
      },
      { workspaceTruncated: true, gitTruncated: true, searchTruncated: true }
    );

    const result = await buildContext(fixture.adapter, {
      workspaceId: "ws_1",
      intent: "review",
      target: TARGET,
      maxBytes: 1024
    });

    expect(result.evidenceStatus).toEqual({
      workspace: "incomplete",
      git: "incomplete",
      search: "incomplete",
      verification: "available"
    });
    expect(result.git).toBeDefined();
    expect(result.warnings).toContain("git-change-evidence-truncated");
    expect(result.warnings).toContain("search-evidence-truncated");
    expect(result.truncated).toBe(true);
  });

  it("keeps workspace inspection foundational and propagates its failure", async () => {
    const failure = new CapabilityError("CAPABILITY_SOURCE_INCOMPLETE", "Workspace inspection incomplete");
    const fixture = sources({}, { inspectFailure: failure });

    await expect(
      buildContext(fixture.adapter, {
        workspaceId: "ws_1",
        intent: "understand",
        target: TARGET
      })
    ).rejects.toBe(failure);
  });

  it("does not normalize unknown optional-source programming errors", async () => {
    const failure = new Error("unexpected Git implementation bug");
    const fixture = sources({}, { gitFailure: failure });

    await expect(
      buildContext(fixture.adapter, {
        workspaceId: "ws_1",
        intent: "understand",
        target: TARGET
      })
    ).rejects.toBe(failure);
  });

  it("retains existing unreadable-file semantics in otherwise healthy context", async () => {
    const fixture = sources(
      {
        [TARGET]: "target\n",
        "packages/core/src/helper.ts": "changed\n",
        "package.json": "root-manifest\n",
        "packages/core/package.json": "core-manifest\n",
        "packages/core/src/workspace-manager-helper.ts": "search-hit\n",
        "packages/core/src/workspace-manager.test.ts": "test-hit\n"
      },
      { unreadablePaths: [TARGET] }
    );

    const result = await buildContext(fixture.adapter, {
      workspaceId: "ws_1",
      intent: "understand",
      target: TARGET,
      maxBytes: 1024
    });

    expect(result.selectedFiles[0]).toMatchObject({ path: TARGET, reason: "exact-target", truncated: false });
    expect(result.selectedFiles[0]).not.toHaveProperty("content");
    expect(result.warnings).toContain(`unreadable:${TARGET}`);
    expect(result.truncated).toBe(true);
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
