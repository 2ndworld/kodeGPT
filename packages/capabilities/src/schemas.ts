import { z } from "zod";

import {
  MAX_CONTEXT_MAX_BYTES,
  MAX_INSPECT_MAX_ENTRIES,
  MAX_PATCH_BYTES,
  MAX_SEARCH_MAX_RESULTS,
  MAX_IMPACT_MAX_RESULTS,
  MAX_GIT_LOG_LIMIT,
  MAX_GIT_RANGE_LIMIT,
  MAX_GIT_PATCH_BYTES,
  MAX_GIT_HISTORY_PATHS,
  MAX_GIT_STAGE_PATHS,
  MAX_GIT_MUTATION_TEXT,
  MAX_GIT_BRANCH_NAME,
  MAX_GIT_WORKTREE_NAME,
  MAX_GIT_REMOTE_NAME,
  type CodeSearchInput,
  type CodeSearchResult,
  type CodeImpactInput,
  type CodeImpactResult,
  type ContextBuildInput,
  type ContextBuildResult,
  type FilePatchInput,
  type FilePatchResult,
  type GitChangesInput,
  type GitChangesResult,
  type GitStageInput,
  type GitCommitInput,
  type GitBranchInput,
  type GitLocalMutationResult,
  type GitWorktreeCreateInput,
  type GitWorktreeCreateResult,
  type GitWorktreeRemoveInput,
  type GitWorktreeRemoveResult,
  type GitRemoteInput,
  type GitRemoteMutationResult,
  type GitLogInput,
  type GitLogResult,
  type GitShowInput,
  type GitShowResult,
  type GitRangeInput,
  type GitRangeResult,
  type GitDiffHistoryInput,
  type GitDiffHistoryResult,
  type SourceRegion,
  type StructuralFileAnalysis,
  type StructuralReferenceEvidence,
  type StructuralRelationshipEvidence,
  type StructuralSymbolEvidence,
  type VerificationRecipe,
  type VerifyListInput,
  type VerifyListResult,
  type VerifyRunInput,
  type VerifyRunResult,
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
const workspaceInspectSymbolKindSchema = z.enum([
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "variable",
  "struct",
  "trait",
  "module"
]);
const workspaceInspectRelationshipKindSchema = z.enum(["imports", "tests", "module"]);
const workspaceInspectRelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."));

const structuralPrecisionSchema = z.enum(["structural", "heuristic"]);
const structuralLanguageSchema = z.enum(["typescript", "javascript", "rust"]);

export const SourceRegionSchema: z.ZodType<SourceRegion> = z
  .object({
    startLine: z.number().int().positive().safe(),
    endLine: z.number().int().positive().safe()
  })
  .strict()
  .refine((value) => value.endLine >= value.startLine, {
    message: "Source region endLine must be greater than or equal to startLine"
  });

const structuralSymbolEvidenceSchema: z.ZodType<StructuralSymbolEvidence> = z
  .object({
    name: z.string().min(1),
    kind: workspaceInspectSymbolKindSchema,
    path: workspaceInspectRelativePathSchema,
    line: z.number().int().positive().safe(),
    exported: z.boolean(),
    region: SourceRegionSchema.optional()
  })
  .strict();

const structuralReferenceEvidenceSchema: z.ZodType<StructuralReferenceEvidence> = z
  .object({
    name: z.string().min(1),
    path: workspaceInspectRelativePathSchema,
    line: z.number().int().positive().safe(),
    column: z.number().int().positive().safe(),
    kind: z.enum(["definition", "reference"]),
    region: SourceRegionSchema.optional()
  })
  .strict();

const structuralRelationshipEvidenceSchema: z.ZodType<StructuralRelationshipEvidence> = z
  .object({
    from: workspaceInspectRelativePathSchema,
    to: workspaceInspectRelativePathSchema,
    kind: workspaceInspectRelationshipKindSchema,
    precision: structuralPrecisionSchema
  })
  .strict();

export const StructuralFileAnalysisSchema: z.ZodType<StructuralFileAnalysis> = z
  .object({
    path: workspaceInspectRelativePathSchema,
    language: structuralLanguageSchema,
    precision: structuralPrecisionSchema,
    symbols: z.array(structuralSymbolEvidenceSchema),
    references: z.array(structuralReferenceEvidenceSchema),
    relationships: z.array(structuralRelationshipEvidenceSchema),
    warnings: z.array(z.string())
  })
  .strict();

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
    symbols: z.array(
      z
        .object({
          name: z.string().min(1),
          kind: workspaceInspectSymbolKindSchema,
          path: workspaceInspectRelativePathSchema,
          line: z.number().int().positive().safe(),
          exported: z.boolean()
        })
        .strict()
    ),
    relationships: z.array(
      z
        .object({
          from: workspaceInspectRelativePathSchema,
          to: workspaceInspectRelativePathSchema,
          kind: workspaceInspectRelationshipKindSchema
        })
        .strict()
    ),
    warnings: z.array(z.string()),
    truncated: z.boolean()
  })
  .strict();

const codeSearchModeSchema = z.enum(["text", "path", "symbol", "definition", "reference"]);
const codeSearchPrecisionSchema = z.enum(["exact", "lexical", "heuristic"]);
const codeSearchTruncationReasonSchema = z.enum([
  "TREE_LIMIT",
  "FILE_SIZE_LIMIT",
  "SCAN_BYTE_LIMIT",
  "MATCH_LIMIT",
  "SNIPPET_BYTE_LIMIT"
]);

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
    truncated: z.boolean(),
    truncationReasons: z.array(codeSearchTruncationReasonSchema)
  })
  .strict();

const codeImpactTargetKindSchema = z.enum(["file", "symbol", "auto"]);
const codeImpactRelationshipSchema = z.enum(["imports", "module", "reference"]);
const codeImpactTruncationReasonSchema = z.enum([
  "TARGET_LIMIT",
  "DEPENDENT_LIMIT",
  "TEST_LIMIT",
  "AREA_LIMIT",
  "SEARCH_LIMIT"
]);

export const CodeImpactInputSchema: z.ZodType<CodeImpactInput> = z
  .object({
    workspaceId: z.string().min(1),
    target: z.string().min(1).max(512),
    kind: codeImpactTargetKindSchema.optional(),
    path: workspaceInspectRelativePathSchema.optional(),
    maxResults: z.number().int().positive().max(MAX_IMPACT_MAX_RESULTS).safe().optional()
  })
  .strict();

export const CodeImpactResultSchema: z.ZodType<CodeImpactResult> = z
  .object({
    schemaVersion: z.literal(1),
    target: z
      .object({
        kind: z.enum(["file", "symbol"]),
        value: z.string().min(1).max(512),
        resolvedPaths: z.array(workspaceInspectRelativePathSchema).max(MAX_IMPACT_MAX_RESULTS)
      })
      .strict(),
    dependents: z
      .array(
        z
          .object({
            path: workspaceInspectRelativePathSchema,
            relationship: codeImpactRelationshipSchema,
            line: z.number().int().positive().safe().optional()
          })
          .strict()
      )
      .max(MAX_IMPACT_MAX_RESULTS),
    relatedTests: z.array(workspaceInspectRelativePathSchema).max(MAX_IMPACT_MAX_RESULTS),
    affectedAreas: z.array(workspaceInspectRelativePathSchema).max(MAX_IMPACT_MAX_RESULTS),
    truncated: z.boolean(),
    truncationReasons: z.array(codeImpactTruncationReasonSchema)
  })
  .strict()
  .refine((value) => value.truncated === (value.truncationReasons.length > 0));

export const FilePatchInputSchema: z.ZodType<FilePatchInput> = z
  .object({
    workspaceId: z.string().min(1),
    patch: z.string().min(1).max(MAX_PATCH_BYTES),
    mode: z.enum(["check", "apply"]).optional()
  })
  .strict();

export const FilePatchResultSchema: z.ZodType<FilePatchResult> = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.string().min(1),
    mode: z.enum(["check", "apply"]),
    files: z.array(
      z
        .object({
          path: z.string().min(1),
          action: z.enum(["create", "update", "delete"]),
          expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
          resultingSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
          bytes: z.number().int().nonnegative().safe(),
          committed: z.boolean()
        })
        .strict()
    ),
    committedPaths: z.array(z.string().min(1))
  })
  .strict();

const gitOidSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const GitSafeRefNameSchema = z.string().min(1).max(128).refine((value) =>
  !value.includes("..") && !value.includes("@{") &&
  value.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && !part.endsWith(".lock") && !part.endsWith("."))
);
export const GitRevisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("head") }).strict(),
  z.object({ kind: z.literal("oid"), oid: gitOidSchema }).strict(),
  z.object({ kind: z.literal("branch"), name: GitSafeRefNameSchema }).strict(),
  z.object({ kind: z.literal("tag"), name: GitSafeRefNameSchema }).strict()
]);
const gitPathSchema = z.string().min(1).refine((value) =>
  Buffer.byteLength(value, "utf8") <= 4096 &&
  !value.startsWith("/") && !value.startsWith(":") && !/[\u0000-\u001f\u007f]/.test(value) &&
  value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
);
const gitTruncationReasonSchema = z.enum(["COMMIT_LIMIT", "MESSAGE_LIMIT", "PATCH_LIMIT", "PATH_LIMIT", "RESPONSE_LIMIT"]);
const gitCommitSchema = z.object({
  oid: gitOidSchema,
  shortOid: z.string().length(12).regex(/^[0-9a-f]+$/),
  parents: z.array(gitOidSchema),
  authorName: z.string(),
  authorTime: z.number().int().safe(),
  committerTime: z.number().int().safe(),
  subject: z.string(),
  encodingLossy: z.boolean()
}).strict().refine((value) => value.shortOid === value.oid.slice(0, 12));
const gitChangedPathSchema = z.object({
  path: gitPathSchema,
  status: z.enum(["added", "modified", "deleted", "typeChanged"]),
  insertions: z.number().int().nonnegative().safe().nullable(),
  deletions: z.number().int().nonnegative().safe().nullable(),
  binary: z.boolean()
}).strict();
const gitStatSummarySchema = z.object({
  filesChanged: z.number().int().nonnegative().safe(),
  insertions: z.number().int().nonnegative().safe(),
  deletions: z.number().int().nonnegative().safe(),
  binaryFiles: z.number().int().nonnegative().safe()
}).strict();

export const GitLogInputSchema: z.ZodType<GitLogInput> = z.object({
  workspaceId: z.string().min(1), revision: GitRevisionSchema.optional(), path: gitPathSchema.optional(),
  limit: z.number().int().positive().max(MAX_GIT_LOG_LIMIT).safe().optional()
}).strict();
export const GitShowInputSchema: z.ZodType<GitShowInput> = z.object({
  workspaceId: z.string().min(1), revision: GitRevisionSchema.optional(), path: gitPathSchema.optional(),
  includePatch: z.boolean().optional(), maxPatchBytes: z.number().int().positive().max(MAX_GIT_PATCH_BYTES).safe().optional()
}).strict();
export const GitRangeInputSchema: z.ZodType<GitRangeInput> = z.object({
  workspaceId: z.string().min(1), baseRevision: GitRevisionSchema, headRevision: GitRevisionSchema,
  mode: z.enum(["direct", "symmetric"]).optional(), limit: z.number().int().positive().max(MAX_GIT_RANGE_LIMIT).safe().optional()
}).strict();
export const GitDiffHistoryInputSchema: z.ZodType<GitDiffHistoryInput> = z.object({
  workspaceId: z.string().min(1), baseRevision: GitRevisionSchema, headRevision: GitRevisionSchema,
  path: gitPathSchema.optional(), maxPatchBytes: z.number().int().positive().max(MAX_GIT_PATCH_BYTES).safe().optional()
}).strict();

export const GitLogResultSchema: z.ZodType<GitLogResult> = z.object({
  schemaVersion: z.literal(1), resolvedOid: gitOidSchema, commits: z.array(gitCommitSchema).max(MAX_GIT_LOG_LIMIT),
  returnedCount: z.number().int().nonnegative().max(MAX_GIT_LOG_LIMIT).safe(), truncated: z.boolean(), truncationReasons: z.array(gitTruncationReasonSchema)
}).strict().refine((v) => v.returnedCount === v.commits.length && v.truncated === (v.truncationReasons.length > 0));
const gitCommitDetailSchema = gitCommitSchema.safeExtend({ body: z.string(), messageTruncated: z.boolean() });
export const GitShowResultSchema: z.ZodType<GitShowResult> = z.object({
  schemaVersion: z.literal(1), commit: gitCommitDetailSchema, changedPaths: z.array(gitChangedPathSchema).max(MAX_GIT_HISTORY_PATHS),
  summary: gitStatSummarySchema, patch: z.string().nullable(), truncated: z.boolean(), truncationReasons: z.array(gitTruncationReasonSchema)
}).strict().refine((v) => v.truncated === (v.truncationReasons.length > 0));
const gitRangeCommitSchema = gitCommitSchema.safeExtend({ side: z.enum(["base", "head"]).optional() });
export const GitRangeResultSchema: z.ZodType<GitRangeResult> = z.object({
  schemaVersion: z.literal(1), baseOid: gitOidSchema, headOid: gitOidSchema, isAncestor: z.boolean(), mergeBaseOid: gitOidSchema.nullable(),
  ahead: z.object({ value: z.number().int().nonnegative().max(10000).safe(), exact: z.boolean() }).strict(),
  behind: z.object({ value: z.number().int().nonnegative().max(10000).safe(), exact: z.boolean() }).strict(),
  commits: z.array(gitRangeCommitSchema).max(MAX_GIT_RANGE_LIMIT), returnedCount: z.number().int().nonnegative().max(MAX_GIT_RANGE_LIMIT).safe(),
  truncated: z.boolean(), truncationReasons: z.array(gitTruncationReasonSchema)
}).strict().refine((v) => v.returnedCount === v.commits.length && v.truncated === (v.truncationReasons.length > 0));
export const GitDiffHistoryResultSchema: z.ZodType<GitDiffHistoryResult> = z.object({
  schemaVersion: z.literal(1), baseOid: gitOidSchema, headOid: gitOidSchema, changedPaths: z.array(gitChangedPathSchema).max(MAX_GIT_HISTORY_PATHS),
  summary: gitStatSummarySchema, patch: z.string(), truncated: z.boolean(), truncationReasons: z.array(gitTruncationReasonSchema)
}).strict().refine((v) => v.truncated === (v.truncationReasons.length > 0));

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
    patchCoverage: z
      .object({
        staged: z.literal(true),
        worktree: z.literal(true),
        untracked: z.literal(false)
      })
      .strict()
      .optional(),
    truncated: z.boolean(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();

const gitMutationPathSchema = z
  .string()
  .min(1)
  .max(MAX_GIT_MUTATION_TEXT)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value !== "." &&
      value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "Git stage paths must be bounded relative workspace paths"
  );

const gitBranchNameSchema = z
  .string()
  .min(1)
  .max(MAX_GIT_BRANCH_NAME)
  .refine(
    (name) =>
      name !== "@" &&
      !name.startsWith("-") &&
      !name.startsWith(".") &&
      !name.startsWith("/") &&
      !name.endsWith(".") &&
      !name.endsWith("/") &&
      !name.includes("..") &&
      !name.includes("//") &&
      !name.includes("@{") &&
      !name.includes("\\") &&
      !/[\u0000-\u0020\u007f~^:?*[\]]/.test(name) &&
      name.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock")),
    "Git branch name is invalid"
  );

export const GitStageInputSchema: z.ZodType<GitStageInput> = z
  .object({
    workspaceId: z.string().min(1),
    paths: z.array(gitMutationPathSchema).min(1).max(MAX_GIT_STAGE_PATHS)
  })
  .strict();

export const GitCommitInputSchema: z.ZodType<GitCommitInput> = z
  .object({
    workspaceId: z.string().min(1),
    message: z.string().min(1).max(MAX_GIT_MUTATION_TEXT).refine((value) => !value.includes("\0"))
  })
  .strict();

export const GitBranchInputSchema: z.ZodType<GitBranchInput> = z
  .object({
    workspaceId: z.string().min(1),
    name: gitBranchNameSchema
  })
  .strict();

export const GitLocalMutationResultSchema: z.ZodType<GitLocalMutationResult> = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.enum(["stage", "commit", "branch_create", "branch_switch", "branch_delete"]),
    exitCode: z.number().int().safe(),
    stdoutPreview: z.string(),
    stderrPreview: z.string(),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
    sourceTruncated: z.boolean(),
    bytesSpooled: z.number().int().nonnegative().safe(),
    artifact: z
      .object({
        schemaVersion: z.literal(1),
        uri: z.string().regex(/^artifact:\/\/.+$/) as z.ZodType<`artifact://${string}`>,
        mediaType: z.string().min(1),
        sizeBytes: z.number().int().nonnegative().safe(),
        sourceTruncated: z.boolean()
      })
      .strict()
  })
  .strict();

const gitWorktreeNameSchema = z
  .string()
  .min(1)
  .max(MAX_GIT_WORKTREE_NAME)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Git worktree name is invalid")
  .refine((value) => value !== "." && value !== "..", "Git worktree name is invalid");

export const GitWorktreeCreateInputSchema: z.ZodType<GitWorktreeCreateInput> = z
  .object({
    workspaceId: z.string().min(1),
    name: gitWorktreeNameSchema,
    branch: gitBranchNameSchema
  })
  .strict();

export const GitWorktreeRemoveInputSchema: z.ZodType<GitWorktreeRemoveInput> = z
  .object({
    workspaceId: z.string().min(1),
    name: gitWorktreeNameSchema
  })
  .strict();

export const GitWorktreeCreateResultSchema: z.ZodType<GitWorktreeCreateResult> = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.literal("create"),
    name: gitWorktreeNameSchema,
    relativePath: z.string(),
    branch: gitBranchNameSchema,
    headOid: z.string().regex(/^[0-9a-f]{40}$/)
  })
  .strict()
  .refine((value) => value.relativePath === `.worktrees/${value.name}`, "Git worktree relative path is invalid") as z.ZodType<GitWorktreeCreateResult>;

export const GitWorktreeRemoveResultSchema: z.ZodType<GitWorktreeRemoveResult> = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.literal("remove"),
    name: gitWorktreeNameSchema,
    relativePath: z.string(),
    removed: z.literal(true)
  })
  .strict()
  .refine((value) => value.relativePath === `.worktrees/${value.name}`, "Git worktree relative path is invalid") as z.ZodType<GitWorktreeRemoveResult>;

const gitRemoteNameSchema = z
  .string()
  .min(1)
  .max(MAX_GIT_REMOTE_NAME)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Git remote name is invalid");

export const GitRemoteInputSchema: z.ZodType<GitRemoteInput> = z
  .object({
    workspaceId: z.string().min(1),
    remote: gitRemoteNameSchema.optional(),
    ref: gitBranchNameSchema
  })
  .strict();

export const GitRemoteMutationResultSchema: z.ZodType<GitRemoteMutationResult> = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.enum(["fetch", "pull", "push"]),
    exitCode: z.number().int().safe(),
    stdoutPreview: z.string(),
    stderrPreview: z.string(),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
    sourceTruncated: z.boolean(),
    bytesSpooled: z.number().int().nonnegative().safe(),
    artifact: z
      .object({
        schemaVersion: z.literal(1),
        uri: z.string().regex(/^artifact:\/\/.+$/) as z.ZodType<`artifact://${string}`>,
        mediaType: z.string().min(1),
        sizeBytes: z.number().int().nonnegative().safe(),
        sourceTruncated: z.boolean()
      })
      .strict()
  })
  .strict();

const verificationRecipeSchema: z.ZodType<VerificationRecipe> = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    category: z.enum(["test", "lint", "typecheck", "build", "format-check", "custom"]),
    logicalExecutable: z.string().min(1).optional(),
    argv: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    source: z.enum(["package-script", "cargo", "kodegpt-config"]),
    allowed: z.boolean(),
    blockedReason: z.string().min(1).optional()
  })
  .strict()
  .superRefine((recipe, context) => {
    const launchComplete =
      recipe.logicalExecutable !== undefined && recipe.argv !== undefined && recipe.cwd !== undefined;
    if (recipe.allowed && (!launchComplete || recipe.blockedReason !== undefined)) {
      context.addIssue({ code: "custom", message: "allowed recipe requires a complete launch tuple" });
    }
    if (!recipe.allowed && recipe.blockedReason === undefined) {
      context.addIssue({ code: "custom", message: "blocked recipe requires blockedReason" });
    }
    if (
      (recipe.blockedReason === "PACKAGE_MANAGER_UNKNOWN" ||
        recipe.blockedReason === "PACKAGE_MANAGER_CONFLICT") &&
      (recipe.logicalExecutable !== undefined || recipe.argv !== undefined || recipe.cwd !== undefined)
    ) {
      context.addIssue({ code: "custom", message: "unresolved package manager must omit launch tuple" });
    }
  });

const verificationOperationSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: z.string().startsWith("op_"),
    state: z.enum(["running", "completed", "failed", "cancelled"]),
    exitCode: z.number().int().safe().optional(),
    stdoutPreview: z.string(),
    stderrPreview: z.string(),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
    sourceTruncated: z.boolean(),
    bytesSpooled: z.number().int().nonnegative().safe(),
    artifact: z
      .object({
        schemaVersion: z.literal(1),
        uri: z.templateLiteral(["artifact://", z.string()]),
        mediaType: z.string().min(1),
        sizeBytes: z.number().int().nonnegative().safe(),
        sourceTruncated: z.boolean()
      })
      .strict()
  })
  .strict();

export const VerifyListInputSchema: z.ZodType<VerifyListInput> = z
  .object({
    workspaceId: z.string().min(1),
    target: z.string().min(1).optional()
  })
  .strict();

export const VerifyListResultSchema: z.ZodType<VerifyListResult> = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.string().min(1),
    recipes: z.array(verificationRecipeSchema)
  })
  .strict();

export const VerifyRunInputSchema: z.ZodType<VerifyRunInput> = z
  .object({
    workspaceId: z.string().min(1),
    recipeId: z.string().min(1),
    background: z.boolean().optional()
  })
  .strict();

export const VerifyRunResultSchema: z.ZodType<VerifyRunResult> = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.string().min(1),
    recipe: verificationRecipeSchema,
    operation: verificationOperationSchema
  })
  .strict();

export const ContextBuildInputSchema: z.ZodType<ContextBuildInput> = z
  .object({
    workspaceId: z.string().min(1),
    intent: z.enum(["understand", "implement", "debug", "review", "verify"]),
    target: z.string().min(1).optional(),
    maxBytes: z.number().int().positive().max(MAX_CONTEXT_MAX_BYTES).safe().optional()
  })
  .strict();

const contextEvidenceStateSchema = z.enum(["available", "incomplete", "unavailable"]);
const contextWorkspaceSummarySchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.string().min(1),
    root: z.string().min(1),
    scope: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("workspace") }).strict(),
      z.object({ kind: z.literal("target"), area: z.string().min(1) }).strict()
    ]),
    projectTypes: z.array(z.string()),
    languages: z.array(
      z.object({ name: z.string().min(1), fileCount: z.number().int().nonnegative().safe() }).strict()
    ),
    entrypoints: z.array(
      z.object({ path: z.string().min(1), kind: z.string().min(1) }).strict()
    ),
    areas: z.array(
      z.object({ path: z.string().min(1), kind: workspaceInspectAreaKindSchema }).strict()
    ),
    manifests: z.array(
      z.object({ path: z.string().min(1), kind: z.string().min(1) }).strict()
    ),
    warnings: z.array(z.string()),
    truncated: z.boolean()
  })
  .strict();

export const ContextBuildResultSchema: z.ZodType<ContextBuildResult> = z
  .object({
    schemaVersion: z.literal(1),
    intent: z.enum(["understand", "implement", "debug", "review", "verify"]),
    target: z.string().min(1).optional(),
    evidenceStatus: z
      .object({
        workspace: contextEvidenceStateSchema,
        git: contextEvidenceStateSchema,
        search: contextEvidenceStateSchema,
        verification: contextEvidenceStateSchema
      })
      .strict(),
    workspace: contextWorkspaceSummarySchema,
    git: GitChangesResultSchema.optional(),
    selectedFiles: z.array(
      z
        .object({
          path: z.string().min(1),
          reason: z.string().min(1),
          content: z.string().optional(),
          truncated: z.boolean()
        })
        .strict()
    ),
    relevantMatches: z.array(
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
    verifications: z.array(verificationRecipeSchema),
    warnings: z.array(z.string()),
    totalBytes: z.number().int().nonnegative().max(MAX_CONTEXT_MAX_BYTES).safe(),
    truncated: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    const expectedWorkspaceState = value.workspace.truncated ? "incomplete" : "available";
    if (value.evidenceStatus.workspace !== expectedWorkspaceState) {
      context.addIssue({
        code: "custom",
        path: ["evidenceStatus", "workspace"],
        message: "Workspace evidence status must match the foundational workspace result"
      });
    }

    if (value.evidenceStatus.git === "unavailable" && value.git !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["git"],
        message: "Unavailable Git evidence must be omitted"
      });
    }
    if (value.evidenceStatus.git !== "unavailable" && value.git === undefined) {
      context.addIssue({
        code: "custom",
        path: ["git"],
        message: "Available or incomplete Git evidence must be present"
      });
    }
    if (value.git !== undefined && value.evidenceStatus.git !== "unavailable") {
      const expectedGitState = value.git.truncated ? "incomplete" : "available";
      if (value.evidenceStatus.git !== expectedGitState) {
        context.addIssue({
          code: "custom",
          path: ["evidenceStatus", "git"],
          message: "Git evidence status must match the Git evidence result"
        });
      }
    }

    const hasPartialEvidence =
      value.evidenceStatus.workspace !== "available" ||
      value.evidenceStatus.git !== "available" ||
      value.evidenceStatus.search !== "available" ||
      value.evidenceStatus.verification !== "available";
    if (hasPartialEvidence && !value.truncated) {
      context.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "Partial evidence must mark the aggregate context as truncated"
      });
    }
    if (value.evidenceStatus.search === "unavailable" && value.relevantMatches.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["relevantMatches"],
        message: "Unavailable search evidence cannot contribute relevant matches"
      });
    }
    if (value.evidenceStatus.verification === "unavailable" && value.verifications.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["verifications"],
        message: "Unavailable verification evidence cannot contribute recipes"
      });
    }
  });
