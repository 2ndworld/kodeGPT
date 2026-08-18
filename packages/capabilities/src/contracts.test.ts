import { describe, expect, it } from "vitest";

import {
  CAPABILITY_SCHEMA_VERSION,
  DEFAULT_CONTEXT_MAX_BYTES,
  DEFAULT_INSPECT_MAX_ENTRIES,
  DEFAULT_SEARCH_MAX_RESULTS,
  MAX_CONTEXT_MAX_BYTES,
  MAX_INSPECT_MAX_ENTRIES,
  MAX_PATCH_BYTES,
  MAX_PATCH_FILES,
  MAX_PATCH_HUNKS,
  MAX_SEARCH_MAX_RESULTS,
  NATIVE_CAPABILITY_IDS,
  DEFAULT_GIT_LOG_LIMIT,
  MAX_GIT_LOG_LIMIT,
  DEFAULT_GIT_RANGE_LIMIT,
  MAX_GIT_RANGE_LIMIT,
  DEFAULT_GIT_PATCH_BYTES,
  MAX_GIT_PATCH_BYTES,
  MAX_GIT_HISTORY_RESPONSE_BYTES,
  MAX_GIT_HISTORY_PATHS
} from "./contracts.js";
import { CapabilityError, toPublicCapabilityError } from "./errors.js";
import { CapabilityNotImplementedError } from "./native-capability-service.js";
import {
  CodeSearchInputSchema,
  CodeSearchResultSchema,
  ContextBuildResultSchema,
  GitChangesInputSchema,
  GitChangesResultSchema,
  VerifyListInputSchema,
  VerifyListResultSchema,
  VerifyRunInputSchema,
  VerifyRunResultSchema,
  WorkspaceInspectInputSchema,
  WorkspaceInspectResultSchema
} from "./schemas.js";

describe("capability contracts", () => {
  it("maps known capability errors and redacts unknown host errors", () => {
    expect(
      toPublicCapabilityError(
        new CapabilityError("CAPABILITY_LIMIT_EXCEEDED", "Search limit exceeded")
      )
    ).toEqual({ code: "CAPABILITY_LIMIT_EXCEEDED", message: "Search limit exceeded" });

    expect(toPublicCapabilityError(new Error("ENOENT /home/sauron/private-secret"))).toEqual({
      code: "CAPABILITY_INTERNAL",
      message: "Native capability failed"
    });
    expect(
      toPublicCapabilityError(
        new CapabilityError("PATCH_COMMIT_INCOMPLETE", "partial", {
          committedPaths: ["safe.txt"],
          failedPath: "/home/sauron/private-secret"
        })
      )
    ).toEqual({ code: "PATCH_COMMIT_INCOMPLETE", message: "partial" });
  });

  it("pins public schema and bounded defaults", () => {
    expect(CAPABILITY_SCHEMA_VERSION).toBe(1);
    expect(DEFAULT_CONTEXT_MAX_BYTES).toBe(256 * 1024);
    expect(MAX_CONTEXT_MAX_BYTES).toBe(1024 * 1024);
    expect(DEFAULT_INSPECT_MAX_ENTRIES).toBe(2_000);
    expect(MAX_INSPECT_MAX_ENTRIES).toBe(10_000);
    expect(DEFAULT_SEARCH_MAX_RESULTS).toBe(100);
    expect(MAX_SEARCH_MAX_RESULTS).toBe(500);
    expect(MAX_PATCH_BYTES).toBe(1024 * 1024);
    expect(MAX_PATCH_FILES).toBe(64);
    expect(MAX_PATCH_HUNKS).toBe(256);
    expect(DEFAULT_GIT_LOG_LIMIT).toBe(20);
    expect(MAX_GIT_LOG_LIMIT).toBe(100);
    expect(DEFAULT_GIT_RANGE_LIMIT).toBe(50);
    expect(MAX_GIT_RANGE_LIMIT).toBe(100);
    expect(DEFAULT_GIT_PATCH_BYTES).toBe(64 * 1024);
    expect(MAX_GIT_PATCH_BYTES).toBe(256 * 1024);
    expect(MAX_GIT_HISTORY_RESPONSE_BYTES).toBe(512 * 1024);
    expect(MAX_GIT_HISTORY_PATHS).toBe(500);
    expect(NATIVE_CAPABILITY_IDS).toEqual([
      "workspace.inspect",
      "code.search",
      "code.impact",
      "file.read",
      "file.write",
      "file.edit",
      "file.patch",
      "git.status",
      "git.diff",
      "git.changes",
      "git.stage",
      "git.commit",
      "git.branchCreate",
      "git.branchSwitch",
      "git.branchDelete",
      "git.fetch",
      "git.pull",
      "git.push",
      "git.log",
      "git.show",
      "git.range",
      "git.diffHistory",
      "ci.repository",
      "ci.status",
      "ci.runs",
      "ci.run",
      "ci.failure",
      "ci.rerun",
      "ci.cancel",
      "ci.dispatch",
      "process.run",
      "verify.list",
      "verify.run",
      "context.build"
    ]);
    expect(Object.isFrozen(NATIVE_CAPABILITY_IDS)).toBe(true);
  });

  it("validates workspace.inspect inputs and structured results at runtime", () => {
    expect(
      WorkspaceInspectInputSchema.parse({ workspaceId: "ws_1", path: ".", maxEntries: 10_000 })
    ).toEqual({ workspaceId: "ws_1", path: ".", maxEntries: 10_000 });
    expect(() =>
      WorkspaceInspectInputSchema.parse({ workspaceId: "ws_1", maxEntries: 10_001 })
    ).toThrow();

    const validResult = {
      schemaVersion: 1 as const,
      workspaceId: "ws_1",
      root: ".",
      projectTypes: ["node-pnpm"],
      languages: [{ name: "TypeScript", fileCount: 2 }],
      entrypoints: [{ path: "package.json", kind: "node-manifest" }],
      areas: [{ path: "packages/core", kind: "package" as const }],
      manifests: [{ path: "package.json", kind: "package-json" }],
      symbols: [
        {
          name: "inspectWorkspace",
          kind: "function" as const,
          path: "src/workspace-inspect.ts",
          line: 23,
          exported: true
        }
      ],
      relationships: [
        {
          from: "src/workspace-inspect.test.ts",
          to: "src/workspace-inspect.ts",
          kind: "tests" as const
        }
      ],
      warnings: [],
      truncated: false
    };
    expect(WorkspaceInspectResultSchema.parse(validResult)).toEqual(validResult);
    expect(() => WorkspaceInspectResultSchema.parse({ ...validResult, truncated: "no" })).toThrow();
    expect(() =>
      WorkspaceInspectResultSchema.parse({
        ...validResult,
        symbols: [{ ...validResult.symbols[0], kind: "method" }]
      })
    ).toThrow();
    expect(() =>
      WorkspaceInspectResultSchema.parse({
        ...validResult,
        symbols: [{ ...validResult.symbols[0], line: 0 }]
      })
    ).toThrow();
    expect(() =>
      WorkspaceInspectResultSchema.parse({
        ...validResult,
        relationships: [{ ...validResult.relationships[0], kind: "calls" }]
      })
    ).toThrow();
  });

  it("validates code.search inputs and structured results at runtime", () => {
    expect(
      CodeSearchInputSchema.parse({
        workspaceId: "ws_1",
        query: "needle",
        mode: "definition",
        path: "src",
        maxResults: 500
      })
    ).toEqual({
      workspaceId: "ws_1",
      query: "needle",
      mode: "definition",
      path: "src",
      maxResults: 500
    });
    expect(() =>
      CodeSearchInputSchema.parse({ workspaceId: "ws_1", query: "x".repeat(513) })
    ).toThrow();

    const validResult = {
      schemaVersion: 1 as const,
      mode: "definition" as const,
      precision: "heuristic" as const,
      matches: [
        {
          path: "src/main.ts",
          line: 1,
          column: 10,
          kind: "definition" as const,
          preview: "function needle() {}"
        }
      ],
      truncated: false,
      truncationReasons: []
    };
    expect(CodeSearchResultSchema.parse(validResult)).toEqual(validResult);
    expect(() => CodeSearchResultSchema.parse({ ...validResult, precision: "exact-ish" })).toThrow();
  });

  it("validates git.changes inputs and structured results at runtime", () => {
    expect(GitChangesInputSchema.parse({ workspaceId: "ws_1", includePatch: true })).toEqual({
      workspaceId: "ws_1",
      includePatch: true
    });

    const validResult = {
      schemaVersion: 1 as const,
      workspaceId: "ws_1",
      clean: false,
      changedPaths: [{ path: "src/main.ts", worktreeStatus: "M" }],
      summary: { changedFiles: 1 },
      patchPreview: "diff --git a/src/main.ts b/src/main.ts\n",
      patchArtifact: { uri: "artifact://ka_diff", bytes: 42 },
      truncated: false,
      fingerprint: "a".repeat(64)
    };
    expect(GitChangesResultSchema.parse(validResult)).toEqual(validResult);
    expect(() => GitChangesResultSchema.parse({ ...validResult, fingerprint: "not-a-sha" })).toThrow();
  });

  it("validates context.build evidence status and truthful unavailable Git results", () => {
    const partialResult = {
      schemaVersion: 1 as const,
      intent: "debug" as const,
      evidenceStatus: {
        workspace: "available" as const,
        git: "unavailable" as const,
        search: "available" as const,
        verification: "available" as const
      },
      workspace: {
        schemaVersion: 1 as const,
        workspaceId: "ws_1",
        root: ".",
        projectTypes: [],
        languages: [],
        entrypoints: [],
        areas: [],
        manifests: [],
        symbols: [],
        relationships: [],
        warnings: [],
        truncated: false
      },
      selectedFiles: [],
      relevantMatches: [],
      verifications: [],
      warnings: ["git-evidence-unavailable"],
      totalBytes: 0,
      truncated: true
    };

    expect(ContextBuildResultSchema.parse(partialResult)).toEqual(partialResult);
    expect(() =>
      ContextBuildResultSchema.parse({
        ...partialResult,
        evidenceStatus: { ...partialResult.evidenceStatus, git: "missing" }
      })
    ).toThrow();
    expect(() =>
      ContextBuildResultSchema.parse({
        ...partialResult,
        evidenceStatus: { ...partialResult.evidenceStatus, provider: "available" }
      })
    ).toThrow();
    expect(() =>
      ContextBuildResultSchema.parse({
        ...partialResult,
        evidenceStatus: { ...partialResult.evidenceStatus, git: "available" }
      })
    ).toThrow();
    expect(() =>
      ContextBuildResultSchema.parse({
        ...partialResult,
        git: {
          schemaVersion: 1,
          workspaceId: "ws_1",
          clean: true,
          changedPaths: [],
          summary: { changedFiles: 0 },
          truncated: false,
          fingerprint: "a".repeat(64)
        }
      })
    ).toThrow();
    expect(() =>
      ContextBuildResultSchema.parse({
        ...partialResult,
        evidenceStatus: { ...partialResult.evidenceStatus, workspace: "unavailable" }
      })
    ).toThrow();
    expect(() =>
      ContextBuildResultSchema.parse({
        ...partialResult,
        evidenceStatus: { ...partialResult.evidenceStatus, workspace: "incomplete" }
      })
    ).toThrow();

    const completeGit = {
      schemaVersion: 1 as const,
      workspaceId: "ws_1",
      clean: false,
      changedPaths: [{ path: "src/main.ts", worktreeStatus: "M" }],
      summary: { changedFiles: 1 },
      truncated: false,
      fingerprint: "b".repeat(64)
    };
    expect(
      ContextBuildResultSchema.parse({
        ...partialResult,
        evidenceStatus: { ...partialResult.evidenceStatus, git: "available" },
        git: completeGit
      })
    ).toMatchObject({ evidenceStatus: { git: "available" }, git: { truncated: false } });
    expect(() =>
      ContextBuildResultSchema.parse({
        ...partialResult,
        evidenceStatus: { ...partialResult.evidenceStatus, git: "incomplete" },
        git: completeGit
      })
    ).toThrow();
    expect(() =>
      ContextBuildResultSchema.parse({
        ...partialResult,
        evidenceStatus: { ...partialResult.evidenceStatus, git: "available" },
        git: { ...completeGit, truncated: true }
      })
    ).toThrow();
    expect(() => ContextBuildResultSchema.parse({ ...partialResult, truncated: false })).toThrow();
    expect(() =>
      ContextBuildResultSchema.parse({
        ...partialResult,
        evidenceStatus: { ...partialResult.evidenceStatus, search: "unavailable" },
        relevantMatches: [{ path: "src/main.ts", kind: "path" }]
      })
    ).toThrow();
    expect(() =>
      ContextBuildResultSchema.parse({
        ...partialResult,
        evidenceStatus: { ...partialResult.evidenceStatus, verification: "unavailable" },
        verifications: [
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
      })
    ).toThrow();
  });

  it("validates verify.list and verify.run contracts at runtime", () => {
    expect(VerifyListInputSchema.parse({ workspaceId: "ws_1" })).toEqual({ workspaceId: "ws_1" });
    expect(VerifyRunInputSchema.parse({ workspaceId: "ws_1", recipeId: "package:test", background: true })).toEqual({
      workspaceId: "ws_1",
      recipeId: "package:test",
      background: true
    });

    const recipe = {
      id: "package:test",
      label: "Package test",
      category: "test" as const,
      logicalExecutable: "pnpm",
      argv: ["run", "test"],
      cwd: ".",
      source: "package-script" as const,
      allowed: true
    };
    expect(
      VerifyListResultSchema.parse({ schemaVersion: 1, workspaceId: "ws_1", recipes: [recipe] })
    ).toEqual({ schemaVersion: 1, workspaceId: "ws_1", recipes: [recipe] });
    const unresolvedRecipe = {
      id: "package:test",
      label: "Package test",
      category: "test" as const,
      source: "package-script" as const,
      allowed: false,
      blockedReason: "PACKAGE_MANAGER_UNKNOWN"
    };
    expect(
      VerifyListResultSchema.parse({
        schemaVersion: 1,
        workspaceId: "ws_1",
        recipes: [unresolvedRecipe]
      })
    ).toEqual({ schemaVersion: 1, workspaceId: "ws_1", recipes: [unresolvedRecipe] });
    expect(() =>
      VerifyListResultSchema.parse({
        schemaVersion: 1,
        workspaceId: "ws_1",
        recipes: [{ ...recipe, logicalExecutable: undefined }]
      })
    ).toThrow();

    const operation = {
      schemaVersion: 1 as const,
      operationId: "op_verify",
      state: "completed" as const,
      exitCode: 0,
      stdoutPreview: "ok\n",
      stderrPreview: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      sourceTruncated: false,
      bytesSpooled: 3,
      artifact: {
        schemaVersion: 1 as const,
        uri: "artifact://ka_verify" as const,
        mediaType: "text/plain",
        sizeBytes: 3,
        sourceTruncated: false
      }
    };
    expect(
      VerifyRunResultSchema.parse({
        schemaVersion: 1,
        workspaceId: "ws_1",
        recipe,
        operation
      })
    ).toMatchObject({ workspaceId: "ws_1", recipe: { id: "package:test" }, operation: { operationId: "op_verify" } });
  });

  it("retains the explicit not-implemented error type for compatibility", () => {
    const error = new CapabilityNotImplementedError("context.build");
    expect(error).toEqual(
      expect.objectContaining<Partial<CapabilityNotImplementedError>>({
        name: "CapabilityNotImplementedError",
        code: "CAPABILITY_NOT_IMPLEMENTED",
        capability: "context.build"
      })
    );
  });
});
