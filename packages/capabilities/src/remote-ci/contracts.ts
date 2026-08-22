import type { GitRevision } from "../contracts.js";

export const DEFAULT_CI_RUNS_LIMIT = 10;
export const MAX_CI_RUNS_LIMIT = 50;
export const MAX_CI_STATUS_SUMMARIES = 50;
export const MAX_CI_STATUS_FAILURE_SUMMARIES = 20;
export const MAX_CI_STATUS_WAIT_MS = 30_000;
export const MAX_CI_STATUS_OBSERVATIONS = 4;
export const MAX_CI_RUN_JOBS = 100;
export const MAX_CI_JOB_STEPS = 100;
export const MAX_CI_ANNOTATIONS = 100;
export const CI_LOG_SCAN_MAX_BYTES = 512 * 1024;
export const CI_LOG_EXCERPT_DEFAULT_BYTES = 64 * 1024;
export const CI_LOG_EXCERPT_MAX_BYTES = 256 * 1024;
export const MAX_CI_RESPONSE_BYTES = 512 * 1024;
export const MAX_CI_PROVIDER_METADATA_BYTES = 1024 * 1024;
export const MAX_CI_DISPATCH_INPUTS = 20;
export const MAX_CI_DISPATCH_INPUT_KEY = 64;
export const MAX_CI_DISPATCH_INPUT_VALUE = 1024;
export const MAX_CI_WORKFLOW = 256;
export const MAX_CI_REF = 128;

export const CI_REQUEST_BUDGETS = Object.freeze({
  repository: 1,
  status: 6,
  runs: 1,
  run: 2,
  failure: 5,
  rerun: 1,
  cancel: 1,
  dispatch: 1
} as const);

export const CI_TRUNCATION_REASONS = Object.freeze([
  "SUMMARY_LIMIT",
  "RUN_LIMIT",
  "JOB_LIMIT",
  "STEP_LIMIT",
  "ANNOTATION_LIMIT",
  "LOG_BYTE_LIMIT",
  "PROVIDER_PAGE_LIMIT",
  "RESPONSE_LIMIT"
] as const);

export type CiId = string;
export type CiOverallState = "PENDING" | "PASS" | "FAIL" | "CANCELLED" | "UNKNOWN";
export type CiRunStatus = "QUEUED" | "IN_PROGRESS" | "COMPLETED";
export type CiConclusion =
  | "SUCCESS"
  | "FAILURE"
  | "CANCELLED"
  | "NEUTRAL"
  | "SKIPPED"
  | "TIMED_OUT"
  | "ACTION_REQUIRED"
  | "STARTUP_FAILURE";
export type CiTruncationReason = (typeof CI_TRUNCATION_REASONS)[number];
export type CiAuthState = "AVAILABLE" | "REQUIRED" | "FAILED";

export interface CiRepositoryIdentity {
  owner: string;
  name: string;
  fullName: string;
}

export interface CiRepositoryInput {
  workspaceId?: string;
}

export interface CiRepositoryResult {
  schemaVersion: 1;
  workspaceId: string;
  provider: "github";
  repository: CiRepositoryIdentity;
  selectedRemote: string;
  defaultBranch: string | null;
  currentRevision: {
    oid: string;
    branch: string | null;
  };
  available: boolean;
  authState: CiAuthState;
  credentialSource: "gh" | null;
  truncated: boolean;
  truncationReasons: CiTruncationReason[];
}

export interface CiStatusInput {
  workspaceId?: string;
  revision?: GitRevision;
  waitMs?: number;
}

export interface CiCheckSummary {
  id: CiId;
  name: string;
  state: CiOverallState;
  conclusion: CiConclusion | null;
  url: string | null;
}

export interface CiRunSummary {
  id: CiId;
  name: string;
  workflow: string | null;
  status: CiRunStatus | "UNKNOWN";
  conclusion: CiConclusion | "UNKNOWN" | null;
  headOid: string;
  ref: string | null;
  event: string | null;
  url: string | null;
  createdAt: string | null;
  startedAt: string | null;
  updatedAt: string | null;
}

export interface CiFailureSummary {
  runId: CiId;
  jobId: CiId | null;
  jobName: string | null;
  stepName: string | null;
  conclusion: CiConclusion | "UNKNOWN" | null;
  url: string | null;
}

export interface CiStatusResult {
  schemaVersion: 1;
  workspaceId: string;
  provider: "github";
  repository: CiRepositoryIdentity;
  revision: { oid: string; branch: string | null };
  state: CiOverallState;
  checks: CiCheckSummary[];
  runs: CiRunSummary[];
  failures: CiFailureSummary[];
  truncated: boolean;
  truncationReasons: CiTruncationReason[];
}

export interface CiRunsInput {
  workspaceId?: string;
  workflow?: string;
  ref?: string;
  status?: CiRunStatus;
  conclusion?: CiConclusion;
  limit?: number;
}

export interface CiRunsResult {
  schemaVersion: 1;
  workspaceId: string;
  provider: "github";
  repository: CiRepositoryIdentity;
  runs: CiRunSummary[];
  truncated: boolean;
  truncationReasons: CiTruncationReason[];
}

export interface CiRunInput {
  workspaceId?: string;
  runId: CiId;
}

export interface CiStepSummary {
  number: number;
  name: string;
  status: CiRunStatus | "UNKNOWN";
  conclusion: CiConclusion | "UNKNOWN" | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CiAnnotation {
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  startColumn: number | null;
  endColumn: number | null;
  level: "NOTICE" | "WARNING" | "FAILURE" | "UNKNOWN";
  message: string;
  title: string | null;
}

export interface CiJobSummary {
  id: CiId;
  name: string;
  status: CiRunStatus | "UNKNOWN";
  conclusion: CiConclusion | "UNKNOWN" | null;
  startedAt: string | null;
  completedAt: string | null;
  url: string | null;
  steps: CiStepSummary[];
}

export interface CiRunResult {
  schemaVersion: 1;
  workspaceId: string;
  provider: "github";
  repository: CiRepositoryIdentity;
  run: CiRunSummary;
  jobs: CiJobSummary[];
  annotations: CiAnnotation[];
  truncated: boolean;
  truncationReasons: CiTruncationReason[];
}

export interface CiFailureInput {
  workspaceId?: string;
  runId: CiId;
  jobId?: CiId;
}

export interface CiFailureResult {
  schemaVersion: 1;
  workspaceId: string;
  provider: "github";
  repository: CiRepositoryIdentity;
  runId: CiId;
  job: CiJobSummary;
  failedStep: CiStepSummary | null;
  reason: string;
  annotations: CiAnnotation[];
  logExcerpt: string | null;
  truncated: boolean;
  truncationReasons: CiTruncationReason[];
}

export interface CiRerunInput {
  workspaceId?: string;
  runId: CiId;
  failedOnly?: boolean;
}

export interface CiCancelInput {
  workspaceId?: string;
  runId: CiId;
}

export interface CiDispatchInput {
  workspaceId?: string;
  workflow: string;
  ref: string;
  inputs?: Record<string, string>;
}

export type CiMutationOperation = "rerun" | "rerun_failed" | "cancel" | "dispatch";

export interface CiMutationResult {
  schemaVersion: 1;
  workspaceId: string;
  provider: "github";
  repository: CiRepositoryIdentity;
  operation: CiMutationOperation;
  target:
    | { kind: "run"; runId: CiId }
    | { kind: "workflow"; workflow: string; ref: string };
  accepted: true;
}
