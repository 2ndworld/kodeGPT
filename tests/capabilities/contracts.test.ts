import { describe, expect, it } from "vitest";

import {
  CAPABILITY_SCHEMA_VERSION,
  CodeSearchInputSchema,
  CodeSearchResultSchema,
  ContextBuildInputSchema,
  ContextBuildResultSchema,
  FilePatchInputSchema,
  FilePatchResultSchema,
  GitChangesInputSchema,
  GitChangesResultSchema,
  NativeCapabilityService,
  VerifyListInputSchema,
  VerifyListResultSchema,
  VerifyRunInputSchema,
  VerifyRunResultSchema,
  WorkspaceInspectInputSchema,
  WorkspaceInspectResultSchema
} from "../../packages/capabilities/src/index.js";

describe("native capability public package boundary", () => {
  it("exports the Task 1–9 service and runtime contracts from the package entrypoint", () => {
    expect(CAPABILITY_SCHEMA_VERSION).toBe(1);
    expect(typeof NativeCapabilityService).toBe("function");
    expect(
      WorkspaceInspectInputSchema.parse({ workspaceId: "ws_public", maxEntries: 2_000 })
    ).toEqual({ workspaceId: "ws_public", maxEntries: 2_000 });
    expect(
      WorkspaceInspectResultSchema.parse({
        schemaVersion: 1,
        workspaceId: "ws_public",
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
      })
    ).toMatchObject({ workspaceId: "ws_public", truncated: false });
    expect(CodeSearchInputSchema.parse({ workspaceId: "ws_public", query: "needle" })).toEqual({
      workspaceId: "ws_public",
      query: "needle"
    });
    expect(
      CodeSearchResultSchema.parse({
        schemaVersion: 1,
        mode: "text",
        precision: "exact",
        matches: [],
        truncated: false,
        truncationReasons: []
      })
    ).toMatchObject({ mode: "text", precision: "exact", truncated: false });
    expect(GitChangesInputSchema.parse({ workspaceId: "ws_public" })).toEqual({
      workspaceId: "ws_public"
    });
    expect(
      GitChangesResultSchema.parse({
        schemaVersion: 1,
        workspaceId: "ws_public",
        clean: true,
        changedPaths: [],
        summary: { changedFiles: 0 },
        patchCoverage: { staged: true, worktree: true, untracked: false },
        truncated: false,
        fingerprint: "a".repeat(64)
      })
    ).toMatchObject({
      workspaceId: "ws_public",
      clean: true,
      patchCoverage: { staged: true, worktree: true, untracked: false },
      truncated: false
    });
    expect(
      FilePatchInputSchema.parse({
        workspaceId: "ws_public",
        patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n"
      })
    ).toMatchObject({ workspaceId: "ws_public" });
    expect(
      FilePatchResultSchema.parse({
        schemaVersion: 1,
        workspaceId: "ws_public",
        mode: "check",
        files: [
          {
            path: "a.txt",
            action: "update",
            expectedSha256: "a".repeat(64),
            resultingSha256: "b".repeat(64),
            bytes: 4,
            committed: false
          }
        ],
        committedPaths: []
      })
    ).toMatchObject({ workspaceId: "ws_public", mode: "check", committedPaths: [] });
    expect(
      ContextBuildInputSchema.parse({
        workspaceId: "ws_public",
        intent: "review",
        target: "src/main.ts",
        maxBytes: 1024
      })
    ).toEqual({
      workspaceId: "ws_public",
      intent: "review",
      target: "src/main.ts",
      maxBytes: 1024
    });
    expect(
      ContextBuildResultSchema.parse({
        schemaVersion: 1,
        intent: "review",
        target: "src/main.ts",
        evidenceStatus: {
          workspace: "available",
          git: "available",
          search: "available",
          verification: "available"
        },
        workspace: {
          schemaVersion: 1,
          workspaceId: "ws_public",
          root: ".",
          scope: { kind: "target", area: "src" },
          projectTypes: [],
          languages: [],
          entrypoints: [],
          areas: [],
          manifests: [],
          warnings: [],
          truncated: false
        },
        git: {
          schemaVersion: 1,
          workspaceId: "ws_public",
          clean: true,
          changedPaths: [],
          summary: { changedFiles: 0 },
          patchCoverage: { staged: true, worktree: true, untracked: false },
          truncated: false,
          fingerprint: "a".repeat(64)
        },
        selectedFiles: [],
        relevantMatches: [],
        verifications: [],
        warnings: [],
        totalBytes: 0,
        truncated: false
      })
    ).toMatchObject({ intent: "review", target: "src/main.ts", totalBytes: 0, truncated: false });
    expect(VerifyListInputSchema.parse({ workspaceId: "ws_public" })).toEqual({
      workspaceId: "ws_public"
    });
    expect(
      VerifyListResultSchema.parse({ schemaVersion: 1, workspaceId: "ws_public", recipes: [] })
    ).toEqual({ schemaVersion: 1, workspaceId: "ws_public", recipes: [] });
    expect(
      VerifyRunInputSchema.parse({ workspaceId: "ws_public", recipeId: "package:test" })
    ).toEqual({ workspaceId: "ws_public", recipeId: "package:test" });
    expect(typeof VerifyRunResultSchema.parse).toBe("function");
  });
});
