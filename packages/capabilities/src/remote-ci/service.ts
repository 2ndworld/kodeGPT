import { randomUUID } from "node:crypto";

import type {
  RemoteCiAdapter,
  RemoteCiAuditAdapter,
  RemoteCiAuditInput,
  RemoteCiErrorCode,
  RemoteCiRevisionAdapter,
  RemoteCiWorkspaceRootAdapter
} from "../adapters.js";
import { CapabilityError, type CapabilityErrorCode } from "../errors.js";
import {
  CI_REQUEST_BUDGETS,
  DEFAULT_CI_RUNS_LIMIT,
  MAX_CI_STATUS_FAILURE_SUMMARIES,
  MAX_CI_STATUS_SUMMARIES,
  type CiCheckSummary,
  type CiFailureSummary,
  type CiOverallState,
  type CiRepositoryInput,
  type CiRepositoryResult,
  type CiRunInput,
  type CiRunResult,
  type CiRunsInput,
  type CiRunsResult,
  type CiRunSummary,
  type CiStatusInput,
  type CiStatusResult,
  type CiTruncationReason
} from "./contracts.js";
import type { GitHubCredential, GitHubCredentialProvider } from "./credential-provider.js";
import { fitCiResult } from "./response-budget.js";
import type { ResolvedCiRepository } from "./repository-resolver.js";
import {
  CiRepositoryInputSchema,
  CiRepositoryResultSchema,
  CiRunInputSchema,
  CiRunResultSchema,
  CiRunsInputSchema,
  CiRunsResultSchema,
  CiStatusInputSchema,
  CiStatusResultSchema
} from "./schemas.js";

export interface RemoteCiRepositoryResolverLike {
  resolveRepository(input: { workspaceId?: string }): Promise<ResolvedCiRepository>;
}

export interface RemoteCiAdapterFactory {
  create(credential: GitHubCredential): RemoteCiAdapter;
}

export interface RemoteCiServiceDependencies {
  resolver: RemoteCiRepositoryResolverLike;
  roots: RemoteCiWorkspaceRootAdapter;
  revisions: RemoteCiRevisionAdapter;
  credentialProvider: GitHubCredentialProvider;
  adapterFactory: RemoteCiAdapterFactory;
  audit: RemoteCiAuditAdapter;
  operationIdFactory?: () => string;
  now?: () => number;
}

export class RemoteCiService {
  readonly #resolver: RemoteCiRepositoryResolverLike;
  readonly #roots: RemoteCiWorkspaceRootAdapter;
  readonly #revisions: RemoteCiRevisionAdapter;
  readonly #credentialProvider: GitHubCredentialProvider;
  readonly #adapterFactory: RemoteCiAdapterFactory;
  readonly #audit: RemoteCiAuditAdapter;
  readonly #operationIdFactory: () => string;
  readonly #now: () => number;

  constructor(dependencies: RemoteCiServiceDependencies) {
    this.#resolver = dependencies.resolver;
    this.#roots = dependencies.roots;
    this.#revisions = dependencies.revisions;
    this.#credentialProvider = dependencies.credentialProvider;
    this.#adapterFactory = dependencies.adapterFactory;
    this.#audit = dependencies.audit;
    this.#operationIdFactory = dependencies.operationIdFactory ?? (() => `op_ci_${randomUUID().replaceAll("-", "")}`);
    this.#now = dependencies.now ?? Date.now;
  }

  async repository(input: CiRepositoryInput): Promise<CiRepositoryResult> {
    const parsed = parseInput(CiRepositoryInputSchema, input);
    const resolved = await this.#resolve(parsed.workspaceId);
    const operation = this.#operation("ci.repository", resolved);
    await this.#decision(operation);

    let credentialSource: "gh" | undefined;
    try {
      const root = await this.#roots.rootFor(resolved.workspaceId);
      let credential;
      try {
        credential = await this.#credentialProvider.getCredential({ workspaceRoot: root });
        credentialSource = credential.source;
      } catch (error) {
        if (error instanceof CapabilityError && error.code === "CI_AUTH_REQUIRED") {
          const diagnostic = this.#finalizeRepository({
            schemaVersion: 1,
            workspaceId: resolved.workspaceId,
            provider: "github",
            repository: publicRepository(resolved),
            selectedRemote: resolved.selectedRemote,
            defaultBranch: null,
            currentRevision: { oid: resolved.headOid, branch: resolved.branch },
            available: false,
            authState: "REQUIRED",
            credentialSource: null,
            truncated: false,
            truncationReasons: []
          });
          await this.#success(operation, diagnostic.truncated);
          return diagnostic;
        }
        throw error;
      }

      const adapter = this.#adapterFactory.create(credential);
      const provider = await adapter.repository({ repository: publicRepository(resolved) });
      enforceProviderBudget("repository", provider.providerRequests);
      const result = this.#finalizeRepository({
        schemaVersion: 1,
        workspaceId: resolved.workspaceId,
        provider: "github",
        repository: publicRepository(resolved),
        selectedRemote: resolved.selectedRemote,
        defaultBranch: provider.defaultBranch,
        currentRevision: { oid: resolved.headOid, branch: resolved.branch },
        available: true,
        authState: "AVAILABLE",
        credentialSource: "gh",
        truncated: false,
        truncationReasons: []
      });
      await this.#success(operation, result.truncated, credentialSource);
      return result;
    } catch (error) {
      const normalized = normalizeOperationError(error);
      if (normalized.code === "CI_AUDIT_UNAVAILABLE") throw normalized;
      await this.#failed(operation, normalized, credentialSource);
      throw normalized;
    }
  }

  async status(input: CiStatusInput): Promise<CiStatusResult> {
    const parsed = parseInput(CiStatusInputSchema, input);
    const resolved = await this.#resolve(parsed.workspaceId);
    const operation = this.#operation("ci.status", resolved);
    await this.#decision(operation);

    let credentialSource: "gh" | undefined;
    try {
      const revision =
        parsed.revision === undefined || parsed.revision.kind === "head"
          ? { oid: resolved.headOid, branch: resolved.branch }
          : validateResolvedRevision(
              await this.#revisions.resolve(resolved.workspaceId, parsed.revision)
            );
      const root = await this.#roots.rootFor(resolved.workspaceId);
      const credential = await this.#credentialProvider.getCredential({ workspaceRoot: root });
      credentialSource = credential.source;
      const adapter = this.#adapterFactory.create(credential);
      const provider = await adapter.statusEvidence({
        repository: publicRepository(resolved),
        oid: revision.oid
      });
      enforceProviderBudget("status", provider.providerRequests);

      const observations = [
        ...provider.checks.map((check, index) => ({
          kind: "check" as const,
          state: check.state,
          index,
          value: check
        })),
        ...provider.runs.map((run, index) => ({
          kind: "run" as const,
          state: stateForRun(run),
          index,
          value: run
        }))
      ];
      const overallState = aggregateState(observations.map((observation) => observation.state));
      const retained = [...observations]
        .sort((left, right) => {
          const rank = CI_STATE_RANK[right.state] - CI_STATE_RANK[left.state];
          if (rank !== 0) return rank;
          if (left.kind !== right.kind) return left.kind === "check" ? -1 : 1;
          return left.index - right.index;
        })
        .slice(0, MAX_CI_STATUS_SUMMARIES);
      const checks = retained
        .filter((observation): observation is Extract<(typeof retained)[number], { kind: "check" }> => observation.kind === "check")
        .map((observation) => observation.value);
      const runs = retained
        .filter((observation): observation is Extract<(typeof retained)[number], { kind: "run" }> => observation.kind === "run")
        .map((observation) => observation.value);

      const failureCandidates = provider.runs
        .filter((run) => stateForRun(run) === "FAIL")
        .map<CiFailureSummary>((run) => ({
          runId: run.id,
          jobId: null,
          jobName: null,
          stepName: null,
          conclusion: run.conclusion,
          url: run.url
        }));
      const failures = failureCandidates.slice(0, MAX_CI_STATUS_FAILURE_SUMMARIES);
      const reasons: CiTruncationReason[] = [];
      if (
        provider.summaryLimitReached ||
        observations.length > MAX_CI_STATUS_SUMMARIES ||
        failureCandidates.length > MAX_CI_STATUS_FAILURE_SUMMARIES
      ) {
        reasons.push("SUMMARY_LIMIT");
      }
      if (provider.providerPageLimited) reasons.push("PROVIDER_PAGE_LIMIT");

      const result = this.#finalizeStatus({
        schemaVersion: 1,
        workspaceId: resolved.workspaceId,
        provider: "github",
        repository: publicRepository(resolved),
        revision,
        state: overallState,
        checks,
        runs,
        failures,
        truncated: reasons.length > 0,
        truncationReasons: reasons
      });
      await this.#success(operation, result.truncated, credentialSource);
      return result;
    } catch (error) {
      const normalized = normalizeOperationError(error);
      if (normalized.code === "CI_AUDIT_UNAVAILABLE") throw normalized;
      await this.#failed(operation, normalized, credentialSource);
      throw normalized;
    }
  }

  async runs(input: CiRunsInput): Promise<CiRunsResult> {
    const parsed = parseInput(CiRunsInputSchema, input);
    const resolved = await this.#resolve(parsed.workspaceId);
    const operation = this.#operation("ci.runs", resolved);
    await this.#decision(operation);

    let credentialSource: "gh" | undefined;
    try {
      const root = await this.#roots.rootFor(resolved.workspaceId);
      const credential = await this.#credentialProvider.getCredential({ workspaceRoot: root });
      credentialSource = credential.source;
      const adapter = this.#adapterFactory.create(credential);
      const provider = await adapter.runs({
        repository: publicRepository(resolved),
        ...(parsed.workflow === undefined ? {} : { workflow: parsed.workflow }),
        ...(parsed.ref === undefined ? {} : { ref: parsed.ref }),
        ...(parsed.status === undefined ? {} : { status: parsed.status }),
        ...(parsed.conclusion === undefined ? {} : { conclusion: parsed.conclusion }),
        limit: parsed.limit ?? DEFAULT_CI_RUNS_LIMIT
      });
      enforceProviderBudget("runs", provider.providerRequests);

      const reasons: CiTruncationReason[] = [];
      if (provider.limitReached) reasons.push("RUN_LIMIT");
      if (provider.providerPageLimited) reasons.push("PROVIDER_PAGE_LIMIT");
      const result = this.#finalizeRuns({
        schemaVersion: 1,
        workspaceId: resolved.workspaceId,
        provider: "github",
        repository: publicRepository(resolved),
        runs: provider.items,
        truncated: reasons.length > 0,
        truncationReasons: reasons
      });
      await this.#success(operation, result.truncated, credentialSource);
      return result;
    } catch (error) {
      const normalized = normalizeOperationError(error);
      if (normalized.code === "CI_AUDIT_UNAVAILABLE") throw normalized;
      await this.#failed(operation, normalized, credentialSource);
      throw normalized;
    }
  }

  async run(input: CiRunInput): Promise<CiRunResult> {
    const parsed = parseInput(CiRunInputSchema, input);
    const resolved = await this.#resolve(parsed.workspaceId);
    const operation = this.#operation("ci.run", resolved, { runId: parsed.runId });
    await this.#decision(operation);

    let credentialSource: "gh" | undefined;
    try {
      const root = await this.#roots.rootFor(resolved.workspaceId);
      const credential = await this.#credentialProvider.getCredential({ workspaceRoot: root });
      credentialSource = credential.source;
      const adapter = this.#adapterFactory.create(credential);
      const provider = await adapter.run({
        repository: publicRepository(resolved),
        runId: parsed.runId
      });
      enforceProviderBudget("run", provider.providerRequests);

      const reasons: CiTruncationReason[] = [];
      if (provider.jobLimitReached) reasons.push("JOB_LIMIT");
      if (provider.stepLimitReached) reasons.push("STEP_LIMIT");
      if (provider.annotations.length > 100) reasons.push("ANNOTATION_LIMIT");
      if (provider.providerPageLimited) reasons.push("PROVIDER_PAGE_LIMIT");
      const result = this.#finalizeRun({
        schemaVersion: 1,
        workspaceId: resolved.workspaceId,
        provider: "github",
        repository: publicRepository(resolved),
        run: provider.run,
        jobs: provider.jobs,
        annotations: provider.annotations.slice(0, 100),
        truncated: reasons.length > 0,
        truncationReasons: reasons
      });
      await this.#success(operation, result.truncated, credentialSource);
      return result;
    } catch (error) {
      const normalized = normalizeOperationError(error);
      if (normalized.code === "CI_AUDIT_UNAVAILABLE") throw normalized;
      await this.#failed(operation, normalized, credentialSource);
      throw normalized;
    }
  }

  async #resolve(workspaceId: string | undefined): Promise<ResolvedCiRepository> {
    try {
      return await this.#resolver.resolveRepository(
        workspaceId === undefined ? {} : { workspaceId }
      );
    } catch (error) {
      if (error instanceof CapabilityError) throw error;
      throw new CapabilityError("CI_REPOSITORY_UNAVAILABLE", "Remote-CI repository context is unavailable");
    }
  }

  #operation(
    capability: RemoteCiAuditInput["capability"],
    resolved: ResolvedCiRepository,
    ids?: { runId?: string; jobId?: string }
  ): OperationContext {
    const operationId = this.#operationIdFactory();
    if (!/^op_[A-Za-z0-9_-]{1,93}$/.test(operationId)) {
      throw new CapabilityError("CI_AUDIT_UNAVAILABLE", "Remote-CI durable audit is unavailable");
    }
    return {
      workspaceId: resolved.workspaceId,
      operationId,
      capability,
      provider: "github",
      repository: resolved.fullName,
      startedAt: this.#now(),
      ...(ids?.runId === undefined ? {} : { runId: ids.runId }),
      ...(ids?.jobId === undefined ? {} : { jobId: ids.jobId })
    };
  }

  async #decision(operation: OperationContext): Promise<void> {
    try {
      await this.#audit.record({
        ...auditBase(operation),
        phase: "decision"
      });
    } catch {
      throw new CapabilityError("CI_AUDIT_UNAVAILABLE", "Remote-CI durable audit is unavailable");
    }
  }

  async #success(
    operation: OperationContext,
    truncated: boolean,
    credentialSource?: "gh"
  ): Promise<void> {
    try {
      await this.#audit.record({
        ...auditBase(operation),
        phase: "success",
        ...(credentialSource === undefined ? {} : { credentialSource }),
        truncated,
        durationMs: elapsed(this.#now(), operation.startedAt)
      });
    } catch {
      throw new CapabilityError("CI_AUDIT_UNAVAILABLE", "Remote-CI durable audit is unavailable");
    }
  }

  async #failed(
    operation: OperationContext,
    error: CapabilityError,
    credentialSource?: "gh"
  ): Promise<void> {
    try {
      await this.#audit.record({
        ...auditBase(operation),
        phase: "failed",
        ...(credentialSource === undefined ? {} : { credentialSource }),
        ...(toCiErrorCode(error.code) === undefined ? {} : { errorCode: toCiErrorCode(error.code)! }),
        durationMs: elapsed(this.#now(), operation.startedAt)
      });
    } catch {
      throw new CapabilityError("CI_AUDIT_UNAVAILABLE", "Remote-CI durable audit is unavailable");
    }
  }

  #finalizeRepository(value: CiRepositoryResult): CiRepositoryResult {
    return parseResult(CiRepositoryResultSchema, fitCiResult(value));
  }

  #finalizeStatus(value: CiStatusResult): CiStatusResult {
    return parseResult(CiStatusResultSchema, fitCiResult(value));
  }

  #finalizeRuns(value: CiRunsResult): CiRunsResult {
    return parseResult(CiRunsResultSchema, fitCiResult(value));
  }

  #finalizeRun(value: CiRunResult): CiRunResult {
    return parseResult(CiRunResultSchema, fitCiResult(value));
  }
}

interface OperationContext {
  workspaceId: string;
  operationId: string;
  capability: RemoteCiAuditInput["capability"];
  provider: "github";
  repository: string;
  startedAt: number;
  runId?: string;
  jobId?: string;
}

function auditBase(operation: OperationContext): Omit<RemoteCiAuditInput, "phase"> {
  return {
    workspaceId: operation.workspaceId,
    operationId: operation.operationId,
    capability: operation.capability,
    provider: operation.provider,
    repository: operation.repository,
    ...(operation.runId === undefined ? {} : { runId: operation.runId }),
    ...(operation.jobId === undefined ? {} : { jobId: operation.jobId })
  };
}

function publicRepository(resolved: ResolvedCiRepository) {
  return {
    owner: resolved.owner,
    name: resolved.name,
    fullName: resolved.fullName
  };
}

const CI_STATE_RANK: Record<CiOverallState, number> = {
  PASS: 0,
  UNKNOWN: 1,
  CANCELLED: 2,
  PENDING: 3,
  FAIL: 4
};

function aggregateState(states: CiOverallState[]): CiOverallState {
  if (states.length === 0) return "UNKNOWN";
  return states.reduce<CiOverallState>((highest, state) =>
    CI_STATE_RANK[state] > CI_STATE_RANK[highest] ? state : highest
  , "PASS");
}

function stateForRun(run: CiRunSummary): CiOverallState {
  if (run.status === "QUEUED" || run.status === "IN_PROGRESS") return "PENDING";
  if (run.status !== "COMPLETED") return "UNKNOWN";
  switch (run.conclusion) {
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

function validateResolvedRevision(value: {
  oid: string;
  branch: string | null;
}): { oid: string; branch: string | null } {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.oid)) {
    throw new CapabilityError("CI_RESPONSE_INVALID", "Local Git revision resolver returned an invalid OID");
  }
  if (value.branch !== null && !isSafeGitRef(value.branch)) {
    throw new CapabilityError("CI_RESPONSE_INVALID", "Local Git revision resolver returned an invalid branch");
  }
  return value;
}

function isSafeGitRef(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    !value.includes("..") &&
    !value.includes("@{") &&
    value.split("/").every((part) =>
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) &&
      !part.endsWith(".lock") &&
      !part.endsWith(".")
    )
  );
}

function parseInput<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Remote-CI input is invalid");
  }
  return parsed.data;
}

function parseResult<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CapabilityError("CI_RESPONSE_INVALID", "Remote-CI produced an invalid response");
  }
  return parsed.data;
}

function enforceProviderBudget(
  operation: keyof typeof CI_REQUEST_BUDGETS,
  providerRequests: number
): void {
  if (
    !Number.isSafeInteger(providerRequests) ||
    providerRequests < 0 ||
    providerRequests > CI_REQUEST_BUDGETS[operation]
  ) {
    throw new CapabilityError("CI_RESPONSE_INVALID", "Remote-CI provider request budget was exceeded");
  }
}

function normalizeOperationError(error: unknown): CapabilityError {
  if (error instanceof CapabilityError) return error;
  return new CapabilityError("CI_PROVIDER_UNAVAILABLE", "Remote-CI provider is unavailable");
}

function toCiErrorCode(code: CapabilityErrorCode): RemoteCiErrorCode | undefined {
  return code.startsWith("CI_") ? (code as RemoteCiErrorCode) : undefined;
}

function elapsed(now: number, startedAt: number): number {
  const value = Math.max(0, Math.trunc(now - startedAt));
  return Number.isSafeInteger(value) ? value : 0;
}
