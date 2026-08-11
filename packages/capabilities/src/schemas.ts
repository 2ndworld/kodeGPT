import { z } from "zod";

import { MAX_INSPECT_MAX_ENTRIES, type WorkspaceInspectInput, type WorkspaceInspectResult } from "./contracts.js";

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
