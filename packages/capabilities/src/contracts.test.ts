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
  MAX_SEARCH_MAX_RESULTS
} from "./contracts.js";
import { CapabilityError, toPublicCapabilityError } from "./errors.js";
import { CapabilityNotImplementedError, NativeCapabilityService } from "./native-capability-service.js";
import { createTestCapabilityDependencies } from "./test-support.js";
import {
  CodeSearchInputSchema,
  CodeSearchResultSchema,
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
      warnings: [],
      truncated: false
    };
    expect(WorkspaceInspectResultSchema.parse(validResult)).toEqual(validResult);
    expect(() => WorkspaceInspectResultSchema.parse({ ...validResult, truncated: "no" })).toThrow();
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
      truncated: false
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

  it("keeps remaining unimplemented capability methods explicit and stable", async () => {
    const service = new NativeCapabilityService(createTestCapabilityDependencies());

    await expect(service.patchFile({ workspaceId: "ws_1", patch: "" })).rejects.toEqual(
      expect.objectContaining<Partial<CapabilityNotImplementedError>>({
        name: "CapabilityNotImplementedError",
        code: "CAPABILITY_NOT_IMPLEMENTED",
        capability: "file.patch"
      })
    );
  });
});
