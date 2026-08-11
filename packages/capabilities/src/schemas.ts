import { z } from "zod";

import {
  MAX_INSPECT_MAX_ENTRIES,
  MAX_SEARCH_MAX_RESULTS,
  type CodeSearchInput,
  type CodeSearchResult,
  type GitChangesInput,
  type GitChangesResult,
  type WorkspaceInspectInput,
  type WorkspaceInspectResult
} from "./contracts.js";

const workspaceInspectAreaKindSchema = z.enum([
  "app",
  "package",
  "crate",
  "test",
  "config",
  "docs",
  "other"
]);

export const WorkspaceInspectInputSchema: z.ZodType<WorkspaceInspectInput> = z
  .object({
    workspaceId: z.string().min(1),
    path: z.string().min(1).optional(),
    maxEntries: z.number().int().positive().max(MAX_INSPECT_MAX_ENTRIES).safe().optional()
  })
  .strict();

export const WorkspaceInspectResultSchema: z.ZodType<WorkspaceInspectResult> = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.string().min(1),
    root: z.string().min(1),
    projectTypes: z.array(z.string()),
    languages: z.array(
      z
        .object({
          name: z.string().min(1),
          fileCount: z.number().int().nonnegative().safe()
        })
        .strict()
    ),
    entrypoints: z.array(
      z
        .object({
          path: z.string().min(1),
          kind: z.string().min(1)
        })
        .strict()
    ),
    areas: z.array(
      z
        .object({
          path: z.string().min(1),
          kind: workspaceInspectAreaKindSchema
        })
        .strict()
    ),
    manifests: z.array(
      z
        .object({
          path: z.string().min(1),
          kind: z.string().min(1)
        })
        .strict()
    ),
    warnings: z.array(z.string()),
    truncated: z.boolean()
  })
  .strict();

const codeSearchModeSchema = z.enum(["text", "path", "symbol", "definition", "reference"]);
const codeSearchPrecisionSchema = z.enum(["exact", "lexical", "heuristic"]);

export const CodeSearchInputSchema: z.ZodType<CodeSearchInput> = z
  .object({
    workspaceId: z.string().min(1),
    query: z.string().min(1).max(512),
    mode: codeSearchModeSchema.optional(),
    path: z.string().min(1).optional(),
    maxResults: z.number().int().positive().max(MAX_SEARCH_MAX_RESULTS).safe().optional()
  })
  .strict();

export const CodeSearchResultSchema: z.ZodType<CodeSearchResult> = z
  .object({
    schemaVersion: z.literal(1),
    mode: codeSearchModeSchema,
    precision: codeSearchPrecisionSchema,
    matches: z.array(
      z
        .object({
          path: z.string().min(1),
          line: z.number().int().positive().safe().optional(),
          column: z.number().int().positive().safe().optional(),
          kind: codeSearchModeSchema,
          preview: z.string().optional()
        })
        .strict()
    ),
    truncated: z.boolean()
  })
  .strict();

export const GitChangesInputSchema: z.ZodType<GitChangesInput> = z
  .object({
    workspaceId: z.string().min(1),
    includePatch: z.boolean().optional()
  })
  .strict();

export const GitChangesResultSchema: z.ZodType<GitChangesResult> = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.string().min(1),
    clean: z.boolean(),
    changedPaths: z.array(
      z
        .object({
          path: z.string().min(1),
          indexStatus: z.string().length(1).optional(),
          worktreeStatus: z.string().length(1).optional()
        })
        .strict()
    ),
    summary: z
      .object({
        changedFiles: z.number().int().nonnegative().safe(),
        insertions: z.number().int().nonnegative().safe().optional(),
        deletions: z.number().int().nonnegative().safe().optional()
      })
      .strict(),
    patchPreview: z.string().optional(),
    patchArtifact: z
      .object({
        uri: z.string().startsWith("artifact://"),
        bytes: z.number().int().nonnegative().safe()
      })
      .strict()
      .optional(),
    truncated: z.boolean(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
