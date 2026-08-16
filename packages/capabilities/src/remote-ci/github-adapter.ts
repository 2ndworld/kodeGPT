import type {
  RemoteCiAdapter,
  RemoteCiFailureMetadata,
  RemoteCiProviderList,
  RemoteCiRunDetail,
  RemoteCiStatusEvidence
} from "../adapters.js";
import { CapabilityError } from "../errors.js";
import {
  MAX_CI_ANNOTATIONS,
  MAX_CI_JOB_STEPS,
  MAX_CI_RUN_JOBS,
  MAX_CI_RUNS_LIMIT,
  MAX_CI_STATUS_SUMMARIES,
  type CiAnnotation,
  type CiCheckSummary,
  type CiConclusion,
  type CiJobSummary,
  type CiOverallState,
  type CiRepositoryIdentity,
  type CiRunStatus,
  type CiRunSummary,
  type CiStepSummary
} from "./contracts.js";
import type { GitHubHttp, GitHubLogRead } from "./github-http.js";

interface GitHubHttpLike {
  getJson<T>(path: string, query?: URLSearchParams): Promise<T>;
  getJobLog(path: string, scanMaxBytes: number): Promise<GitHubLogRead>;
}

export class GitHubRemoteCiAdapter implements RemoteCiAdapter {
  readonly #http: GitHubHttpLike;

  constructor(options: { http: GitHubHttp | GitHubHttpLike }) {
    this.#http = options.http;
  }

  async repository(input: { repository: CiRepositoryIdentity }): Promise<{
    defaultBranch: string | null;
    providerRequests: number;
  }> {
    const raw = await this.#http.getJson<unknown>(repoPath(input.repository));
    const record = expectRecord(raw);
    const fullName = expectBoundedString(record.full_name, 201);
    if (fullName.toLowerCase() !== input.repository.fullName.toLowerCase()) {
      throw new CapabilityError(
        "CI_REPOSITORY_MISMATCH",
        "GitHub repository identity does not match the trusted local remote"
      );
    }
    const defaultBranch = record.default_branch === null
      ? null
      : expectSafeRef(record.default_branch);
    return { defaultBranch, providerRequests: 1 };
  }

  async statusEvidence(input: {
    repository: CiRepositoryIdentity;
    oid: string;
  }): Promise<RemoteCiStatusEvidence> {
    const oid = expectOid(input.oid);
    const commitRaw = await this.#http.getJson<unknown>(`${repoPath(input.repository)}/commits/${oid}`);
    const commit = expectRecord(commitRaw);
    if (expectOid(commit.sha) !== oid) throw invalidResponse();

    const checksQuery = new URLSearchParams({ per_page: String(MAX_CI_STATUS_SUMMARIES) });
    const runsQuery = new URLSearchParams({ head_sha: oid, per_page: String(MAX_CI_STATUS_SUMMARIES) });
    const [checksRaw, runsRaw] = await Promise.all([
      this.#http.getJson<unknown>(`${repoPath(input.repository)}/commits/${oid}/check-runs`, checksQuery),
      this.#http.getJson<unknown>(`${repoPath(input.repository)}/actions/runs`, runsQuery)
    ]);
    const checks = normalizeCheckPage(checksRaw, input.repository, MAX_CI_STATUS_SUMMARIES);
    const runs = normalizeRunPage(runsRaw, input.repository, MAX_CI_STATUS_SUMMARIES);
    return {
      checks: checks.items,
      runs: runs.items,
      providerPageLimited: checks.providerPageLimited || runs.providerPageLimited,
      summaryLimitReached: checks.limitReached || runs.limitReached,
      providerRequests: 1 + checks.providerRequests + runs.providerRequests
    };
  }

  async runs(input: {
    repository: CiRepositoryIdentity;
    workflow?: string;
    ref?: string;
    status?: CiRunStatus;
    conclusion?: CiConclusion;
    limit: number;
  }): Promise<RemoteCiProviderList<CiRunSummary>> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > MAX_CI_RUNS_LIMIT) {
      throw new CapabilityError("CI_RESPONSE_INVALID", "Remote-CI run limit is invalid");
    }
    const query = new URLSearchParams();
    if (input.ref !== undefined) query.set("branch", input.ref);
    if (input.status !== undefined) {
      query.set("status", providerStatus(input.status));
    } else if (input.conclusion !== undefined) {
      query.set("status", providerConclusion(input.conclusion));
    }
    query.set("per_page", String(MAX_CI_RUNS_LIMIT));
    const raw = await this.#http.getJson<unknown>(`${repoPath(input.repository)}/actions/runs`, query);
    const page = normalizeRunPage(raw, input.repository, MAX_CI_RUNS_LIMIT);
    const filtered = page.items.filter((run) => {
      if (input.workflow !== undefined && run.workflow !== input.workflow) return false;
      if (input.ref !== undefined && run.ref !== input.ref) return false;
      if (input.status !== undefined && run.status !== input.status) return false;
      if (input.conclusion !== undefined && run.conclusion !== input.conclusion) return false;
      return true;
    });
    const limited = filtered.slice(0, input.limit);
    return {
      items: limited,
      providerPageLimited: page.providerPageLimited,
      limitReached: page.limitReached || filtered.length > limited.length,
      providerRequests: page.providerRequests
    };
  }

  async run(input: { repository: CiRepositoryIdentity; runId: string }): Promise<RemoteCiRunDetail> {
    const runId = expectDecimalId(input.runId);
    const runRaw = await this.#http.getJson<unknown>(`${repoPath(input.repository)}/actions/runs/${runId}`);
    const run = normalizeRun(runRaw, input.repository);
    if (run.id !== runId) throw invalidResponse();

    const query = new URLSearchParams({ per_page: String(MAX_CI_RUN_JOBS) });
    const jobsRaw = await this.#http.getJson<unknown>(
      `${repoPath(input.repository)}/actions/runs/${runId}/jobs`,
      query
    );
    const jobsPage = normalizeJobsPage(jobsRaw, input.repository, runId);
    return {
      run,
      jobs: jobsPage.items,
      annotations: [],
      providerPageLimited: jobsPage.providerPageLimited,
      jobLimitReached: jobsPage.limitReached,
      stepLimitReached: jobsPage.stepLimitReached,
      providerRequests: 1 + jobsPage.providerRequests
    };
  }

  async failureMetadata(input: {
    repository: CiRepositoryIdentity;
    runId: string;
    selectJob(jobs: readonly CiJobSummary[]): string;
  }): Promise<RemoteCiFailureMetadata> {
    const runId = expectDecimalId(input.runId);
    const runRaw = await this.#http.getJson<unknown>(`${repoPath(input.repository)}/actions/runs/${runId}`);
    const run = normalizeRun(runRaw, input.repository);
    if (run.id !== runId) throw invalidResponse();

    const query = new URLSearchParams({ per_page: String(MAX_CI_RUN_JOBS) });
    const jobsRaw = await this.#http.getJson<unknown>(
      `${repoPath(input.repository)}/actions/runs/${runId}/jobs`,
      query
    );
    const page = normalizeFailureJobsPage(jobsRaw, input.repository, runId);
    const selectedJobId = expectDecimalId(input.selectJob(page.items.map((item) => item.job)));
    const selected = page.items.find((item) => item.job.id === selectedJobId);
    if (selected === undefined) throw invalidResponse();

    let annotations: CiAnnotation[] = [];
    let annotationLimitReached = false;
    let providerRequests = 2;
    if (selected.checkRunId !== null) {
      const annotationsQuery = new URLSearchParams({ per_page: String(MAX_CI_ANNOTATIONS) });
      const raw = await this.#http.getJson<unknown>(
        `${repoPath(input.repository)}/check-runs/${selected.checkRunId}/annotations`,
        annotationsQuery
      );
      const values = expectArray(raw);
      annotations = values.slice(0, MAX_CI_ANNOTATIONS).map(normalizeAnnotation);
      annotationLimitReached = values.length >= MAX_CI_ANNOTATIONS;
      providerRequests += 1;
    }

    return {
      run,
      jobs: page.items.map((item) => item.job),
      selectedJobId,
      annotations,
      providerPageLimited: page.providerPageLimited,
      jobLimitReached: page.jobLimitReached,
      stepLimitReached: page.stepLimitReached,
      annotationLimitReached,
      providerRequests
    };
  }

  async failureLog(input: {
    repository: CiRepositoryIdentity;
    jobId: string;
    scanMaxBytes: number;
  }): Promise<GitHubLogRead> {
    const jobId = expectDecimalId(input.jobId);
    return await this.#http.getJobLog(
      `${repoPath(input.repository)}/actions/jobs/${jobId}/logs`,
      input.scanMaxBytes
    );
  }
}

function repoPath(repository: CiRepositoryIdentity): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

function normalizeCheckPage(
  raw: unknown,
  repository: CiRepositoryIdentity,
  limit: number
): RemoteCiProviderList<CiCheckSummary> {
  const record = expectRecord(raw);
  const totalCount = expectSafeCount(record.total_count);
  const values = expectArray(record.check_runs);
  const observed = values.slice(0, limit).map((value) => normalizeCheck(value, repository));
  return {
    items: observed,
    providerPageLimited: totalCount > values.length,
    limitReached: values.length > observed.length,
    providerRequests: 1
  };
}

function normalizeCheck(raw: unknown, repository: CiRepositoryIdentity): CiCheckSummary {
  const record = expectRecord(raw);
  const status = normalizeGithubStatus(expectBoundedString(record.status, 64));
  const conclusion = normalizeGithubConclusionNullable(record.conclusion);
  return {
    id: normalizeProviderId(record.id),
    name: expectBoundedString(record.name, 256),
    state: deriveState(status, conclusion),
    conclusion: conclusion === "UNKNOWN" ? null : conclusion,
    url: safeRepositoryUrl(record.html_url, repository)
  };
}

function normalizeRunPage(
  raw: unknown,
  repository: CiRepositoryIdentity,
  limit: number
): RemoteCiProviderList<CiRunSummary> {
  const record = expectRecord(raw);
  const totalCount = expectSafeCount(record.total_count);
  const values = expectArray(record.workflow_runs);
  const observed = values.slice(0, limit).map((value) => normalizeRun(value, repository));
  return {
    items: observed,
    providerPageLimited: totalCount > values.length,
    limitReached: values.length > observed.length,
    providerRequests: 1
  };
}

function normalizeRun(raw: unknown, repository: CiRepositoryIdentity): CiRunSummary {
  const record = expectRecord(raw);
  const workflow = expectBoundedString(record.name, 256);
  const display = record.display_title === undefined || record.display_title === null
    ? workflow
    : expectBoundedString(record.display_title, 256);
  return {
    id: normalizeProviderId(record.id),
    name: display,
    workflow,
    status: normalizeGithubStatus(expectBoundedString(record.status, 64)),
    conclusion: normalizeGithubConclusionNullable(record.conclusion),
    headOid: expectOid(record.head_sha),
    ref: record.head_branch === null ? null : expectSafeRef(record.head_branch),
    event: nullableBoundedString(record.event, 128),
    url: safeRepositoryUrl(record.html_url, repository),
    createdAt: normalizeTimestamp(record.created_at),
    startedAt: normalizeTimestamp(record.run_started_at),
    updatedAt: normalizeTimestamp(record.updated_at)
  };
}

interface NormalizedJobsPage extends RemoteCiProviderList<CiJobSummary> {
  stepLimitReached: boolean;
}

function normalizeJobsPage(
  raw: unknown,
  repository: CiRepositoryIdentity,
  runId: string
): NormalizedJobsPage {
  const record = expectRecord(raw);
  const totalCount = expectSafeCount(record.total_count);
  const values = expectArray(record.jobs);
  const normalized = values
    .slice(0, MAX_CI_RUN_JOBS)
    .map((value) => normalizeJob(value, repository, runId));
  return {
    items: normalized.map((value) => value.job),
    providerPageLimited: totalCount > values.length,
    limitReached: values.length > normalized.length,
    stepLimitReached: normalized.some((value) => value.stepLimitReached),
    providerRequests: 1
  };
}

interface NormalizedFailureJobsPage {
  items: Array<{
    job: CiJobSummary;
    checkRunId: string | null;
    stepLimitReached: boolean;
  }>;
  providerPageLimited: boolean;
  jobLimitReached: boolean;
  stepLimitReached: boolean;
}

function normalizeFailureJobsPage(
  raw: unknown,
  repository: CiRepositoryIdentity,
  runId: string
): NormalizedFailureJobsPage {
  const record = expectRecord(raw);
  const totalCount = expectSafeCount(record.total_count);
  const values = expectArray(record.jobs);
  const items = values.slice(0, MAX_CI_RUN_JOBS).map((value) => {
    const normalized = normalizeJob(value, repository, runId);
    const rawRecord = expectRecord(value);
    return {
      ...normalized,
      checkRunId: normalizeCheckRunId(rawRecord.check_run_url, repository)
    };
  });
  return {
    items,
    providerPageLimited: totalCount > values.length,
    jobLimitReached: values.length > items.length,
    stepLimitReached: items.some((item) => item.stepLimitReached)
  };
}

function normalizeJob(
  raw: unknown,
  repository: CiRepositoryIdentity,
  runId: string
): { job: CiJobSummary; stepLimitReached: boolean } {
  const record = expectRecord(raw);
  if (normalizeProviderId(record.run_id) !== runId) throw invalidResponse();
  const rawSteps = record.steps === undefined || record.steps === null ? [] : expectArray(record.steps);
  const steps = rawSteps.slice(0, MAX_CI_JOB_STEPS).map(normalizeStep);
  return {
    job: {
      id: normalizeProviderId(record.id),
      name: expectBoundedString(record.name, 256),
      status: normalizeGithubStatus(expectBoundedString(record.status, 64)),
      conclusion: normalizeGithubConclusionNullable(record.conclusion),
      startedAt: normalizeTimestamp(record.started_at),
      completedAt: normalizeTimestamp(record.completed_at),
      url: safeRepositoryUrl(record.html_url, repository),
      steps
    },
    stepLimitReached: rawSteps.length > steps.length
  };
}

function normalizeStep(raw: unknown): CiStepSummary {
  const record = expectRecord(raw);
  const number = record.number;
  if (!Number.isSafeInteger(number) || (number as number) < 0) throw invalidResponse();
  return {
    number: number as number,
    name: expectBoundedString(record.name, 256),
    status: normalizeGithubStatus(expectBoundedString(record.status, 64)),
    conclusion: normalizeGithubConclusionNullable(record.conclusion),
    startedAt: normalizeTimestamp(record.started_at),
    completedAt: normalizeTimestamp(record.completed_at)
  };
}

export function normalizeGithubStatus(value: string): CiRunStatus | "UNKNOWN" {
  switch (value.toLowerCase()) {
    case "queued":
      return "QUEUED";
    case "in_progress":
      return "IN_PROGRESS";
    case "completed":
      return "COMPLETED";
    default:
      return "UNKNOWN";
  }
}

export function normalizeGithubConclusion(value: string): CiConclusion | "UNKNOWN" {
  switch (value.toLowerCase()) {
    case "success":
      return "SUCCESS";
    case "failure":
      return "FAILURE";
    case "cancelled":
      return "CANCELLED";
    case "neutral":
      return "NEUTRAL";
    case "skipped":
      return "SKIPPED";
    case "timed_out":
      return "TIMED_OUT";
    case "action_required":
      return "ACTION_REQUIRED";
    case "startup_failure":
      return "STARTUP_FAILURE";
    default:
      return "UNKNOWN";
  }
}

function normalizeGithubConclusionNullable(value: unknown): CiConclusion | "UNKNOWN" | null {
  if (value === null || value === undefined) return null;
  return normalizeGithubConclusion(expectBoundedString(value, 64));
}

function deriveState(
  status: CiRunStatus | "UNKNOWN",
  conclusion: CiConclusion | "UNKNOWN" | null
): CiOverallState {
  if (status === "QUEUED" || status === "IN_PROGRESS") return "PENDING";
  if (status === "UNKNOWN") return "UNKNOWN";
  switch (conclusion) {
    case "FAILURE":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
      return "FAIL";
    case "CANCELLED":
      return "CANCELLED";
    case "SUCCESS":
    case "NEUTRAL":
    case "SKIPPED":
      return "PASS";
    default:
      return "UNKNOWN";
  }
}

function providerStatus(value: CiRunStatus): string {
  switch (value) {
    case "QUEUED": return "queued";
    case "IN_PROGRESS": return "in_progress";
    case "COMPLETED": return "completed";
  }
}

function providerConclusion(value: CiConclusion): string {
  return value.toLowerCase();
}

function normalizeProviderId(value: unknown): string {
  if (typeof value === "string") return expectDecimalId(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw invalidResponse();
}

function expectDecimalId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) throw invalidResponse();
  return value;
}

function expectOid(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw invalidResponse();
  }
  return value;
}

function expectSafeRef(value: unknown): string {
  const ref = expectBoundedString(value, 128);
  if (
    ref.includes("..") ||
    ref.includes("@{") ||
    !ref.split("/").every((part) =>
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && !part.endsWith(".lock") && !part.endsWith("."))
  ) {
    throw invalidResponse();
  }
  return ref;
}

function safeRepositoryUrl(value: unknown, repository: CiRepositoryIdentity): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 2048 || hasControl(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  let owner: string;
  let name: string;
  try {
    owner = decodeURIComponent(parts[0]!);
    name = decodeURIComponent(parts[1]!);
  } catch {
    return null;
  }
  if (owner.toLowerCase() !== repository.owner.toLowerCase() || name.toLowerCase() !== repository.name.toLowerCase()) {
    return null;
  }
  return url.toString();
}

function normalizeCheckRunId(
  value: unknown,
  repository: CiRepositoryIdentity
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 2048 || hasControl(value)) throw invalidResponse();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidResponse();
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "api.github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) throw invalidResponse();
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 5 || parts[0] !== "repos" || parts[3] !== "check-runs") throw invalidResponse();
  let owner: string;
  let name: string;
  try {
    owner = decodeURIComponent(parts[1]!);
    name = decodeURIComponent(parts[2]!);
  } catch {
    throw invalidResponse();
  }
  if (
    owner.toLowerCase() !== repository.owner.toLowerCase() ||
    name.toLowerCase() !== repository.name.toLowerCase()
  ) throw invalidResponse();
  return expectDecimalId(parts[4]);
}

function normalizeAnnotation(raw: unknown): CiAnnotation {
  const record = expectRecord(raw);
  return {
    path: nullableString(record.path, 4096),
    startLine: nullablePositiveInteger(record.start_line),
    endLine: nullablePositiveInteger(record.end_line),
    startColumn: nullablePositiveInteger(record.start_column),
    endColumn: nullablePositiveInteger(record.end_column),
    level: normalizeAnnotationLevel(record.annotation_level),
    message: boundedString(record.message, 16 * 1024),
    title: nullableString(record.title, 1024)
  };
}

function normalizeAnnotationLevel(value: unknown): CiAnnotation["level"] {
  if (typeof value !== "string") return "UNKNOWN";
  switch (value.toLowerCase()) {
    case "notice": return "NOTICE";
    case "warning": return "WARNING";
    case "failure": return "FAILURE";
    default: return "UNKNOWN";
  }
}

function nullablePositiveInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw invalidResponse();
  return value as number;
}

function nullableString(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  return boundedString(value, max);
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max || hasControl(value)) throw invalidResponse();
  return value;
}

function normalizeTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 64) return null;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function nullableBoundedString(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  return expectBoundedString(value, max);
}

function expectBoundedString(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || hasControl(value)) {
    throw invalidResponse();
  }
  return value;
}

function expectSafeCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidResponse();
  return value as number;
}

function expectArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw invalidResponse();
  return value;
}

function expectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function invalidResponse(): CapabilityError {
  return new CapabilityError("CI_RESPONSE_INVALID", "GitHub returned an invalid response");
}
