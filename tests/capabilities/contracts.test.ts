import { describe, expect, it } from "vitest";

import {
  CAPABILITY_SCHEMA_VERSION,
  CodeSearchInputSchema,
  CodeSearchResultSchema,
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
  it("exports the Task 1–6 service and runtime contracts from the package entrypoint", () => {
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
        truncated: false
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
        truncated: false,
        fingerprint: "a".repeat(64)
      })
    ).toMatchObject({ workspaceId: "ws_public", clean: true, truncated: false });
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
