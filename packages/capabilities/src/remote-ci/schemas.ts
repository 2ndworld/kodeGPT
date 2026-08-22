import { z } from "zod";

import { GitRevisionSchema, GitSafeRefNameSchema } from "../schemas.js";
import {
  CI_LOG_EXCERPT_MAX_BYTES,
  CI_TRUNCATION_REASONS,
  MAX_CI_ANNOTATIONS,
  MAX_CI_DISPATCH_INPUTS,
  MAX_CI_DISPATCH_INPUT_KEY,
  MAX_CI_DISPATCH_INPUT_VALUE,
  MAX_CI_JOB_STEPS,
  MAX_CI_REF,
  MAX_CI_RUN_JOBS,
  MAX_CI_RUNS_LIMIT,
  MAX_CI_STATUS_FAILURE_SUMMARIES,
  MAX_CI_STATUS_SUMMARIES,
  MAX_CI_STATUS_WAIT_MS,
  MAX_CI_WORKFLOW,
  type CiCancelInput,
  type CiDispatchInput,
  type CiFailureInput,
  type CiMutationResult,
  type CiRepositoryInput,
  type CiRerunInput,
  type CiRunInput,
  type CiRunsInput,
  type CiStatusInput
} from "./contracts.js";

export { DEFAULT_CI_RUNS_LIMIT, MAX_CI_RUNS_LIMIT } from "./contracts.js";

export const CiIdSchema = z.string().regex(/^[0-9]+$/);
export const CiOverallStateSchema = z.enum(["PENDING", "PASS", "FAIL", "CANCELLED", "UNKNOWN"]);
export const CiRunStatusSchema = z.enum(["QUEUED", "IN_PROGRESS", "COMPLETED"]);
export const CiConclusionSchema = z.enum([
  "SUCCESS",
  "FAILURE",
  "CANCELLED",
  "NEUTRAL",
  "SKIPPED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE"
]);
export const CiTruncationReasonSchema = z.enum(CI_TRUNCATION_REASONS);

const ciUnknownRunStatusSchema = z.union([CiRunStatusSchema, z.literal("UNKNOWN")]);
const ciUnknownConclusionSchema = z.union([CiConclusionSchema, z.literal("UNKNOWN")]);
const ciOidSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const boundedNameSchema = z.string().min(1).max(256);
const boundedTextSchema = z.string().max(16 * 1024);
const nullableTimestampSchema = z.string().datetime({ offset: true }).nullable();
const nullableGithubUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com" && !url.username && !url.password;
  })
  .nullable();

const CiRepositoryIdentitySchema = z
  .object({
    owner: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    fullName: z.string().min(3).max(201)
  })
  .strict()
  .refine((value) => value.fullName === `${value.owner}/${value.name}`);

const CiRevisionResultSchema = z
  .object({
    oid: ciOidSchema,
    branch: GitSafeRefNameSchema.nullable()
  })
  .strict();

const CiCheckSummarySchema = z
  .object({
    id: CiIdSchema,
    name: boundedNameSchema,
    state: CiOverallStateSchema,
    conclusion: CiConclusionSchema.nullable(),
    url: nullableGithubUrlSchema
  })
  .strict();

const CiRunSummarySchema = z
  .object({
    id: CiIdSchema,
    name: boundedNameSchema,
    workflow: boundedNameSchema.nullable(),
    status: ciUnknownRunStatusSchema,
    conclusion: ciUnknownConclusionSchema.nullable(),
    headOid: ciOidSchema,
    ref: GitSafeRefNameSchema.nullable(),
    event: z.string().min(1).max(128).nullable(),
    url: nullableGithubUrlSchema,
    createdAt: nullableTimestampSchema,
    startedAt: nullableTimestampSchema,
    updatedAt: nullableTimestampSchema
  })
  .strict();

const CiFailureSummarySchema = z
  .object({
    runId: CiIdSchema,
    jobId: CiIdSchema.nullable(),
    jobName: boundedNameSchema.nullable(),
    stepName: boundedNameSchema.nullable(),
    conclusion: ciUnknownConclusionSchema.nullable(),
    url: nullableGithubUrlSchema
  })
  .strict();

const CiStepSummarySchema = z
  .object({
    number: z.number().int().nonnegative().safe(),
    name: boundedNameSchema,
    status: ciUnknownRunStatusSchema,
    conclusion: ciUnknownConclusionSchema.nullable(),
    startedAt: nullableTimestampSchema,
    completedAt: nullableTimestampSchema
  })
  .strict();

const CiAnnotationSchema = z
  .object({
    path: z.string().min(1).max(4096).nullable(),
    startLine: z.number().int().positive().safe().nullable(),
    endLine: z.number().int().positive().safe().nullable(),
    startColumn: z.number().int().positive().safe().nullable(),
    endColumn: z.number().int().positive().safe().nullable(),
    level: z.enum(["NOTICE", "WARNING", "FAILURE", "UNKNOWN"]),
    message: boundedTextSchema,
    title: z.string().max(1024).nullable()
  })
  .strict();

const CiJobSummarySchema = z
  .object({
    id: CiIdSchema,
    name: boundedNameSchema,
    status: ciUnknownRunStatusSchema,
    conclusion: ciUnknownConclusionSchema.nullable(),
    startedAt: nullableTimestampSchema,
    completedAt: nullableTimestampSchema,
    url: nullableGithubUrlSchema,
    steps: z.array(CiStepSummarySchema).max(MAX_CI_JOB_STEPS)
  })
  .strict();

const CiTruncationFieldsSchema = z
  .object({
    truncated: z.boolean(),
    truncationReasons: z.array(CiTruncationReasonSchema)
  })
  .strict();

function hasConsistentTruncation(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.truncated === "boolean" &&
    Array.isArray(record.truncationReasons) &&
    record.truncated === (record.truncationReasons.length > 0)
  );
}

function withTruncationInvariant<T extends z.ZodRawShape>(shape: T) {
  return CiTruncationFieldsSchema.extend(shape).refine(hasConsistentTruncation);
}

export const CiRepositoryInputSchema: z.ZodType<CiRepositoryInput> = z
  .object({ workspaceId: z.string().min(1).optional() })
  .strict();

export const CiStatusInputSchema: z.ZodType<CiStatusInput> = z
  .object({
    workspaceId: z.string().min(1).optional(),
    revision: GitRevisionSchema.optional(),
    waitMs: z.number().int().nonnegative().max(MAX_CI_STATUS_WAIT_MS).safe().optional()
  })
  .strict();

export const CiRunsInputSchema: z.ZodType<CiRunsInput> = z
  .object({
    workspaceId: z.string().min(1).optional(),
    workflow: z.string().min(1).max(256).optional(),
    ref: GitSafeRefNameSchema.optional(),
    status: CiRunStatusSchema.optional(),
    conclusion: CiConclusionSchema.optional(),
    limit: z.number().int().positive().max(MAX_CI_RUNS_LIMIT).safe().optional()
  })
  .strict();

export const CiRunInputSchema: z.ZodType<CiRunInput> = z
  .object({
    workspaceId: z.string().min(1).optional(),
    runId: CiIdSchema
  })
  .strict();

export const CiFailureInputSchema: z.ZodType<CiFailureInput> = z
  .object({
    workspaceId: z.string().min(1).optional(),
    runId: CiIdSchema,
    jobId: CiIdSchema.optional()
  })
  .strict();

const ciWorkflowSchema = z
  .string()
  .min(1)
  .max(MAX_CI_WORKFLOW)
  .regex(/^[A-Za-z0-9._-]+$/);
const ciDispatchInputKeySchema = z
  .string()
  .min(1)
  .max(MAX_CI_DISPATCH_INPUT_KEY)
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/);
const ciDispatchInputsSchema = z
  .record(ciDispatchInputKeySchema, z.string().max(MAX_CI_DISPATCH_INPUT_VALUE))
  .superRefine((value, context) => {
    if (Object.keys(value).length > MAX_CI_DISPATCH_INPUTS) {
      context.addIssue({ code: "custom", message: `workflow dispatch supports at most ${MAX_CI_DISPATCH_INPUTS} inputs` });
    }
  });

export const CiRerunInputSchema: z.ZodType<CiRerunInput> = z
  .object({
    workspaceId: z.string().min(1).optional(),
    runId: CiIdSchema,
    failedOnly: z.boolean().optional()
  })
  .strict();

export const CiCancelInputSchema: z.ZodType<CiCancelInput> = z
  .object({
    workspaceId: z.string().min(1).optional(),
    runId: CiIdSchema
  })
  .strict();

export const CiDispatchInputSchema: z.ZodType<CiDispatchInput> = z
  .object({
    workspaceId: z.string().min(1).optional(),
    workflow: ciWorkflowSchema,
    ref: GitSafeRefNameSchema.refine((value) => value.length <= MAX_CI_REF),
    inputs: ciDispatchInputsSchema.optional()
  })
  .strict();

const CiMutationTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), runId: CiIdSchema }).strict(),
  z.object({ kind: z.literal("workflow"), workflow: ciWorkflowSchema, ref: GitSafeRefNameSchema }).strict()
]);

export const CiMutationResultSchema: z.ZodType<CiMutationResult> = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.string().min(1),
    provider: z.literal("github"),
    repository: CiRepositoryIdentitySchema,
    operation: z.enum(["rerun", "rerun_failed", "cancel", "dispatch"]),
    target: CiMutationTargetSchema,
    accepted: z.literal(true)
  })
  .strict();

export const CiRepositoryResultSchema = withTruncationInvariant({
  schemaVersion: z.literal(1),
  workspaceId: z.string().min(1),
  provider: z.literal("github"),
  repository: CiRepositoryIdentitySchema,
  selectedRemote: z.string().min(1).max(128),
  defaultBranch: GitSafeRefNameSchema.nullable(),
  currentRevision: CiRevisionResultSchema,
  available: z.boolean(),
  authState: z.enum(["AVAILABLE", "REQUIRED", "FAILED"]),
  credentialSource: z.literal("gh").nullable()
});

export const CiStatusResultSchema = withTruncationInvariant({
  schemaVersion: z.literal(1),
  workspaceId: z.string().min(1),
  provider: z.literal("github"),
  repository: CiRepositoryIdentitySchema,
  revision: CiRevisionResultSchema,
  state: CiOverallStateSchema,
  checks: z.array(CiCheckSummarySchema).max(MAX_CI_STATUS_SUMMARIES),
  runs: z.array(CiRunSummarySchema).max(MAX_CI_STATUS_SUMMARIES),
  failures: z.array(CiFailureSummarySchema).max(MAX_CI_STATUS_FAILURE_SUMMARIES)
});

export const CiRunsResultSchema = withTruncationInvariant({
  schemaVersion: z.literal(1),
  workspaceId: z.string().min(1),
  provider: z.literal("github"),
  repository: CiRepositoryIdentitySchema,
  runs: z.array(CiRunSummarySchema).max(MAX_CI_RUNS_LIMIT)
});

export const CiRunResultSchema = withTruncationInvariant({
  schemaVersion: z.literal(1),
  workspaceId: z.string().min(1),
  provider: z.literal("github"),
  repository: CiRepositoryIdentitySchema,
  run: CiRunSummarySchema,
  jobs: z.array(CiJobSummarySchema).max(MAX_CI_RUN_JOBS),
  annotations: z.array(CiAnnotationSchema).max(MAX_CI_ANNOTATIONS)
});

export const CiFailureResultSchema = withTruncationInvariant({
  schemaVersion: z.literal(1),
  workspaceId: z.string().min(1),
  provider: z.literal("github"),
  repository: CiRepositoryIdentitySchema,
  runId: CiIdSchema,
  job: CiJobSummarySchema,
  failedStep: CiStepSummarySchema.nullable(),
  reason: boundedTextSchema,
  annotations: z.array(CiAnnotationSchema).max(MAX_CI_ANNOTATIONS),
  logExcerpt: z
    .string()
    .refine((value) => Buffer.byteLength(value, "utf8") <= CI_LOG_EXCERPT_MAX_BYTES)
    .nullable()
});

