export const CONSOLE_GIT_FRESH_MS = 5_000;

export type ConsoleStatus = "FAILED" | "BLOCKED" | "DEGRADED" | "WORKING" | "READY";
export type ConsoleFreshness = "fresh" | "stale" | "unknown";

export interface ConsoleNextAction {
  kind:
    | "resolve-blocker"
    | "inspect-active-execution"
    | "inspect-ci-failure"
    | "verify-current-source"
    | "checkpoint-next-action"
    | "continue-objective";
  label: string;
  reason: string;
}

export interface ConsoleState {
  schemaVersion: 1;
  generatedAtMs: number;
  status: ConsoleStatus;
  cockpit: {
    workspace?: {
      workspaceId: string;
      root?: string;
      branch?: string;
      headOid?: string;
      dirty?: boolean;
      freshness: ConsoleFreshness;
    };
    objective?: {
      revision?: number;
      objective: string;
      status: string;
      relation?: string;
      nextActions: string[];
    };
    verification: {
      items: Array<{
        recipeId: string;
        label: string;
        category?: string;
        operationId?: string;
        state: string;
        exitCode?: number;
        freshness: ConsoleFreshness;
      }>;
    };
    processes: {
      active: Array<{ operationId: string; state: string }>;
    };
    previews: {
      active: Array<{
        previewId: string;
        operationId?: string;
        processState: string;
        reachable?: boolean;
        httpStatus?: number | null;
        freshness: ConsoleFreshness;
      }>;
    };
    remote: {
      pullRequest?: {
        repository: string;
        number: number;
        title?: string;
        state?: string;
        headBranch?: string;
        baseBranch?: string;
        draft?: boolean;
        merged?: boolean;
      };
      ci?: {
        repository: string;
        state?: string;
        branch?: string;
        oid?: string;
        failures: number;
      };
    };
    nextActions: ConsoleNextAction[];
  };
  workspace: {
    items: unknown[];
  };
  changes: {
    workspaceId?: string;
    gitStatus?: unknown;
    refreshedAtMs?: number;
    stale: boolean;
  };
  processes: {
    operations: unknown[];
  };
  security: {
    health: unknown;
  };
  diagnostics: {
    value: unknown;
  };
}

export interface ConsoleStatusSignals {
  failed?: boolean;
  blocked?: boolean;
  degraded?: boolean;
  working?: boolean;
}

type TimedValue = {
  value: unknown;
  observedAtMs: number;
};

type ProcessEntry = TimedValue & {
  workspaceId?: string;
};

type ContinuityEntry = TimedValue & {
  checkpoint?: unknown;
  relation?: string;
};

export class ConsoleStateStore {
  readonly #gitByWorkspace = new Map<string, TimedValue>();
  readonly #processes = new Map<string, ProcessEntry>();
  readonly #continuityByWorkspace = new Map<string, ContinuityEntry>();
  readonly #verificationByWorkspace = new Map<string, Map<string, TimedValue>>();
  readonly #previewByWorkspace = new Map<string, Map<string, TimedValue>>();
  readonly #pullRequestByRepository = new Map<string, TimedValue>();
  readonly #ciByWorkspace = new Map<string, TimedValue>();
  readonly #branchByWorkspace = new Map<string, string>();

  recordGitStatus(workspaceId: string, value: unknown, refreshedAtMs = Date.now()): void {
    if (workspaceId.length === 0 || !Number.isFinite(refreshedAtMs)) {
      return;
    }
    this.#gitByWorkspace.set(workspaceId, { value, observedAtMs: refreshedAtMs });
  }

  recordContextBuild(workspaceId: string, value: unknown, observedAtMs = Date.now()): void {
    if (workspaceId.length === 0 || !Number.isFinite(observedAtMs) || !isRecord(value)) return;
    if (isRecord(value.git)) {
      this.recordGitStatus(workspaceId, value.git, observedAtMs);
    }
    if (!isRecord(value.resume) || value.resume.checkpointPresent !== true) return;
    const checkpoint = value.resume.checkpoint;
    const checkpointState = isRecord(value.resume.checkpointState) ? value.resume.checkpointState : undefined;
    const relation = typeof checkpointState?.relation === "string" ? checkpointState.relation : undefined;
    this.#continuityByWorkspace.set(workspaceId, {
      value: value.resume,
      observedAtMs,
      checkpoint,
      ...(relation === undefined ? {} : { relation })
    });
    if (relation === "fresh" && isRecord(checkpoint) && isRecord(checkpoint.baseline)) {
      const branch = checkpoint.baseline.branch;
      if (typeof branch === "string" && branch.length > 0) {
        this.#branchByWorkspace.set(workspaceId, branch);
      }
    }
  }

  recordWorkspaceInfo(workspaceId: string, value: unknown, observedAtMs = Date.now()): void {
    if (workspaceId.length === 0 || !Number.isFinite(observedAtMs) || !isRecord(value)) return;
    if (!isRecord(value.checkpoint)) return;
    this.#continuityByWorkspace.set(workspaceId, {
      value,
      observedAtMs,
      checkpoint: value.checkpoint
    });
  }

  recordCheckpointResult(workspaceId: string, value: unknown, observedAtMs = Date.now()): void {
    if (workspaceId.length === 0 || !Number.isFinite(observedAtMs) || !isRecord(value)) return;
    if (value.operation === "clear" && value.cleared === true) {
      this.#continuityByWorkspace.delete(workspaceId);
      return;
    }
    if (value.operation !== "upsert" || !isRecord(value.checkpoint)) return;
    this.#continuityByWorkspace.set(workspaceId, {
      value,
      observedAtMs,
      checkpoint: value.checkpoint
    });
  }

  recordVerification(value: unknown, observedAtMs = Date.now()): void {
    if (!isRecord(value) || !Number.isFinite(observedAtMs)) return;
    const workspaceId = typeof value.workspaceId === "string" ? value.workspaceId : undefined;
    const recipe = isRecord(value.recipe) ? value.recipe : undefined;
    const recipeId = typeof recipe?.id === "string" ? recipe.id : undefined;
    if (!workspaceId || !recipeId) return;
    let entries = this.#verificationByWorkspace.get(workspaceId);
    if (entries === undefined) {
      entries = new Map();
      this.#verificationByWorkspace.set(workspaceId, entries);
    }
    entries.set(recipeId, { value, observedAtMs });
  }

  recordProcessOperation(value: unknown, workspaceId?: string, observedAtMs = Date.now()): void {
    if (!isRecord(value) || typeof value.operationId !== "string" || !value.operationId.startsWith("op_")) {
      return;
    }
    if (!Number.isFinite(observedAtMs)) return;
    this.#processes.set(value.operationId, {
      value,
      observedAtMs,
      ...(workspaceId === undefined ? {} : { workspaceId })
    });
  }

  recordPreview(workspaceId: string, value: unknown, observedAtMs = Date.now()): void {
    if (workspaceId.length === 0 || !isRecord(value) || !Number.isFinite(observedAtMs)) return;
    const previewId = typeof value.previewId === "string" ? value.previewId : undefined;
    if (!previewId || !previewId.startsWith("pv_")) return;
    let entries = this.#previewByWorkspace.get(workspaceId);
    if (entries === undefined) {
      entries = new Map();
      this.#previewByWorkspace.set(workspaceId, entries);
    }
    entries.set(previewId, { value, observedAtMs });
  }

  recordPullRequest(value: unknown, observedAtMs = Date.now()): void {
    if (!isRecord(value) || !Number.isFinite(observedAtMs)) return;
    const repository = typeof value.repository === "string" ? value.repository : undefined;
    const number = typeof value.number === "number" ? value.number : undefined;
    if (!repository || number === undefined) return;
    this.#pullRequestByRepository.set(repository, { value, observedAtMs });
  }

  recordCi(value: unknown, observedAtMs = Date.now()): void {
    if (!isRecord(value) || !Number.isFinite(observedAtMs)) return;
    const workspaceId = typeof value.workspaceId === "string" ? value.workspaceId : undefined;
    if (!workspaceId) return;
    this.#ciByWorkspace.set(workspaceId, { value, observedAtMs });
    const revision = isRecord(value.revision)
      ? value.revision
      : isRecord(value.currentRevision)
        ? value.currentRevision
        : undefined;
    const run = isRecord(value.run) ? value.run : undefined;
    const branch =
      typeof revision?.branch === "string"
        ? revision.branch
        : typeof run?.ref === "string"
          ? run.ref
          : undefined;
    if (branch) this.#branchByWorkspace.set(workspaceId, branch);
  }

  snapshot(
    input: {
      workspaces: unknown;
      health: unknown;
      blocked?: boolean;
      failed?: boolean;
    },
    nowMs = Date.now()
  ): ConsoleState {
    const workspaces = Array.isArray(input.workspaces) ? input.workspaces : [];
    const workspaceId = firstWorkspaceId(workspaces);
    const gitEntry = workspaceId === undefined ? undefined : this.#gitByWorkspace.get(workspaceId);
    const stale =
      gitEntry !== undefined && Math.max(0, nowMs - gitEntry.observedAtMs) > CONSOLE_GIT_FRESH_MS;
    const processEntries = [...this.#processes.values()];
    const operations = processEntries.map((entry) => entry.value);
    const working = operations.some(
      (operation) => isRecord(operation) && operation.state === "running"
    );
    const health = isRecord(input.health) ? input.health : {};
    const failed =
      input.failed === true || health.auditHealthy === false || health.filesystemBoundaryAvailable === false;
    const degraded = !failed && (health.ok === false || stale);
    const status = resolveConsoleStatus({
      failed,
      blocked: input.blocked === true,
      degraded,
      working
    });
    const cockpit = this.#cockpit(workspaceId, workspaces, gitEntry, stale);

    return {
      schemaVersion: 1,
      generatedAtMs: nowMs,
      status,
      cockpit,
      workspace: { items: workspaces },
      changes: {
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(gitEntry === undefined
          ? {}
          : { gitStatus: gitEntry.value, refreshedAtMs: gitEntry.observedAtMs }),
        stale
      },
      processes: { operations },
      security: { health: input.health },
      diagnostics: {
        value: isRecord(input.health) && "diagnostics" in input.health ? input.health.diagnostics : null
      }
    };
  }

  #cockpit(
    workspaceId: string | undefined,
    workspaces: unknown[],
    gitEntry: TimedValue | undefined,
    stale: boolean
  ): ConsoleState["cockpit"] {
    if (workspaceId === undefined) {
      return {
        verification: { items: [] },
        processes: { active: [] },
        previews: { active: [] },
        remote: {},
        nextActions: []
      };
    }
    const currentSource = sourceStateFrom(gitEntry?.value);
    const workspace = cockpitWorkspace(
      workspaceId,
      workspaces,
      gitEntry?.value,
      gitEntry === undefined ? undefined : stale,
      this.#branchByWorkspace.get(workspaceId)
    );
    const objective = objectiveFrom(this.#continuityByWorkspace.get(workspaceId));
    const verification = verificationItems(
      this.#verificationByWorkspace.get(workspaceId),
      currentSource,
      gitEntry === undefined || stale
    );
    const activeProcesses = [...this.#processes.values()]
      .filter((entry) => entry.workspaceId === undefined || entry.workspaceId === workspaceId)
      .map((entry) => entry.value)
      .filter((value): value is Record<string, unknown> => isRecord(value) && value.state === "running")
      .map((value) => ({
        operationId: String(value.operationId),
        state: String(value.state)
      }));
    const activePreviews = previewItems(
      this.#previewByWorkspace.get(workspaceId),
      currentSource,
      gitEntry === undefined || stale
    ).filter((preview) => preview.processState === "running");
    const ci = ciSummary(this.#ciByWorkspace.get(workspaceId));
    const pullRequest = pullRequestSummary(this.#pullRequestByRepository, ci?.repository);
    const remote = {
      ...(pullRequest === undefined ? {} : { pullRequest }),
      ...(ci === undefined ? {} : { ci })
    };
    const nextActions = nextActionHints({
      workspace,
      objective,
      verification: verification.items,
      activeProcesses,
      activePreviews,
      ci
    });
    return {
      workspace,
      ...(objective === undefined ? {} : { objective }),
      verification,
      processes: { active: activeProcesses },
      previews: { active: activePreviews },
      remote,
      nextActions
    };
  }
}

export function resolveConsoleStatus(signals: ConsoleStatusSignals): ConsoleStatus {
  if (signals.failed) return "FAILED";
  if (signals.blocked) return "BLOCKED";
  if (signals.degraded) return "DEGRADED";
  if (signals.working) return "WORKING";
  return "READY";
}

function firstWorkspaceId(workspaces: unknown[]): string | undefined {
  for (const workspace of workspaces) {
    if (isRecord(workspace) && typeof workspace.id === "string" && workspace.id.length > 0) {
      return workspace.id;
    }
  }
  return undefined;
}

function cockpitWorkspace(
  workspaceId: string,
  workspaces: unknown[],
  gitValue: unknown,
  stale: boolean | undefined,
  branch?: string
): NonNullable<ConsoleState["cockpit"]["workspace"]> {
  const workspace = workspaces.find(
    (candidate) => isRecord(candidate) && candidate.id === workspaceId
  );
  const git = isRecord(gitValue) ? gitValue : {};
  const sourceState = isRecord(git.sourceState) ? git.sourceState : {};
  return {
    workspaceId,
    ...(isRecord(workspace) && typeof workspace.canonicalRoot === "string"
      ? { root: workspace.canonicalRoot }
      : {}),
    ...(branch === undefined ? {} : { branch }),
    ...(typeof sourceState.headOid === "string" ? { headOid: sourceState.headOid } : {}),
    ...(typeof git.clean === "boolean" ? { dirty: !git.clean } : {}),
    freshness: stale === undefined ? "unknown" : stale ? "stale" : "fresh"
  };
}

function objectiveFrom(entry: ContinuityEntry | undefined): ConsoleState["cockpit"]["objective"] | undefined {
  if (entry === undefined || !isRecord(entry.checkpoint)) return undefined;
  const checkpoint = entry.checkpoint;
  if (typeof checkpoint.objective !== "string" || typeof checkpoint.status !== "string") return undefined;
  return {
    ...(typeof checkpoint.revision === "number" ? { revision: checkpoint.revision } : {}),
    objective: checkpoint.objective,
    status: checkpoint.status,
    ...(entry.relation === undefined ? {} : { relation: entry.relation }),
    nextActions: Array.isArray(checkpoint.nextActions)
      ? checkpoint.nextActions.filter((value): value is string => typeof value === "string").slice(0, 8)
      : []
  };
}

function verificationItems(
  entries: Map<string, TimedValue> | undefined,
  currentSource: SourceState | undefined,
  currentUnknown: boolean
): ConsoleState["cockpit"]["verification"] {
  const items = [...(entries?.values() ?? [])]
    .sort((left, right) => right.observedAtMs - left.observedAtMs)
    .map((entry) => {
      const value = isRecord(entry.value) ? entry.value : {};
      const recipe = isRecord(value.recipe) ? value.recipe : {};
      const operation = isRecord(value.operation) ? value.operation : {};
      return {
        recipeId: typeof recipe.id === "string" ? recipe.id : "unknown",
        label: typeof recipe.label === "string" ? recipe.label : String(recipe.id ?? "Verification"),
        ...(typeof recipe.category === "string" ? { category: recipe.category } : {}),
        ...(typeof operation.operationId === "string" ? { operationId: operation.operationId } : {}),
        state: typeof operation.state === "string" ? operation.state : "unknown",
        ...(typeof operation.exitCode === "number" ? { exitCode: operation.exitCode } : {}),
        freshness: sourceFreshness(currentSource, sourceStateFrom(value), currentUnknown)
      };
    });
  return { items };
}

function previewItems(
  entries: Map<string, TimedValue> | undefined,
  currentSource: SourceState | undefined,
  currentUnknown: boolean
): Array<NonNullable<ConsoleState["cockpit"]["previews"]>["active"][number]> {
  return [...(entries?.values() ?? [])]
    .sort((left, right) => right.observedAtMs - left.observedAtMs)
    .map((entry) => {
      const value = isRecord(entry.value) ? entry.value : {};
      return {
        previewId: typeof value.previewId === "string" ? value.previewId : "pv_unknown",
        ...(typeof value.operationId === "string" ? { operationId: value.operationId } : {}),
        processState: typeof value.processState === "string" ? value.processState : "unknown",
        ...(typeof value.reachable === "boolean" ? { reachable: value.reachable } : {}),
        ...(typeof value.httpStatus === "number" || value.httpStatus === null
          ? { httpStatus: value.httpStatus as number | null }
          : {}),
        freshness: sourceFreshness(currentSource, sourceStateFrom(value), currentUnknown)
      };
    });
}

function pullRequestSummary(
  byRepository: Map<string, TimedValue>,
  preferredRepository: string | undefined
): NonNullable<ConsoleState["cockpit"]["remote"]["pullRequest"]> | undefined {
  const candidate = preferredRepository === undefined
    ? [...byRepository.values()].sort((left, right) => right.observedAtMs - left.observedAtMs)[0]
    : byRepository.get(preferredRepository);
  if (candidate === undefined || !isRecord(candidate.value)) return undefined;
  const value = candidate.value;
  if (typeof value.repository !== "string" || typeof value.number !== "number") return undefined;
  return {
    repository: value.repository,
    number: value.number,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.state === "string" ? { state: value.state } : {}),
    ...(typeof value.headBranch === "string" ? { headBranch: value.headBranch } : {}),
    ...(typeof value.baseBranch === "string" ? { baseBranch: value.baseBranch } : {}),
    ...(typeof value.draft === "boolean" ? { draft: value.draft } : {}),
    ...(typeof value.merged === "boolean" ? { merged: value.merged } : {})
  };
}

function ciSummary(entry: TimedValue | undefined): NonNullable<ConsoleState["cockpit"]["remote"]["ci"]> | undefined {
  if (entry === undefined || !isRecord(entry.value)) return undefined;
  const value = entry.value;
  const repositoryValue = isRecord(value.repository) ? value.repository.fullName : value.repository;
  if (typeof repositoryValue !== "string") return undefined;
  const revision = isRecord(value.revision)
    ? value.revision
    : isRecord(value.currentRevision)
      ? value.currentRevision
      : undefined;
  const run = isRecord(value.run) ? value.run : undefined;
  const failureEvidence =
    typeof value.runId === "string" && isRecord(value.job) && typeof value.reason === "string";
  const state =
    typeof value.state === "string"
      ? value.state
      : typeof run?.conclusion === "string"
        ? run.conclusion
        : typeof run?.status === "string"
          ? run.status
          : failureEvidence
            ? "FAIL"
            : undefined;
  const branch =
    typeof revision?.branch === "string"
      ? revision.branch
      : typeof run?.ref === "string"
        ? run.ref
        : undefined;
  const oid =
    typeof revision?.oid === "string"
      ? revision.oid
      : typeof run?.headOid === "string"
        ? run.headOid
        : undefined;
  const failures = Array.isArray(value.failures) ? value.failures.length : failureEvidence ? 1 : 0;
  return {
    repository: repositoryValue,
    ...(state === undefined ? {} : { state }),
    ...(branch === undefined ? {} : { branch }),
    ...(oid === undefined ? {} : { oid }),
    failures
  };
}

function nextActionHints(input: {
  workspace: NonNullable<ConsoleState["cockpit"]["workspace"]>;
  objective?: ConsoleState["cockpit"]["objective"];
  verification: ConsoleState["cockpit"]["verification"]["items"];
  activeProcesses: ConsoleState["cockpit"]["processes"]["active"];
  activePreviews: ConsoleState["cockpit"]["previews"]["active"];
  ci?: NonNullable<ConsoleState["cockpit"]["remote"]["ci"]>;
}): ConsoleNextAction[] {
  const hints: ConsoleNextAction[] = [];
  if (input.objective?.status === "blocked") {
    hints.push({
      kind: "resolve-blocker",
      label: "Resolve checkpoint blocker",
      reason: input.objective.objective
    });
  }
  if (input.activeProcesses.length > 0 || input.activePreviews.length > 0) {
    hints.push({
      kind: "inspect-active-execution",
      label: "Inspect active execution",
      reason: "A process or preview is still running."
    });
  }
  if (input.ci?.state === "FAIL" || input.ci?.state === "FAILURE" || (input.ci?.failures ?? 0) > 0) {
    hints.push({
      kind: "inspect-ci-failure",
      label: "Inspect CI failure",
      reason: "The latest observed CI evidence contains a failure."
    });
  }
  const hasFreshVerification = input.verification.some(
    (item) => item.state === "completed" && item.exitCode === 0 && item.freshness === "fresh"
  );
  const hasStaleVerification = input.verification.some((item) => item.freshness === "stale");
  if ((input.workspace.dirty === true && !hasFreshVerification) || hasStaleVerification) {
    hints.push({
      kind: "verify-current-source",
      label: "Verify current source",
      reason: hasStaleVerification
        ? "Observed verification evidence belongs to an older source state."
        : "The workspace is dirty and has no fresh passing verification evidence."
    });
  }
  for (const label of input.objective?.nextActions ?? []) {
    hints.push({
      kind: "checkpoint-next-action",
      label,
      reason: "This action was recorded explicitly in the current checkpoint."
    });
  }
  if (hints.length === 0 && input.objective?.status === "active") {
    hints.push({
      kind: "continue-objective",
      label: "Continue objective",
      reason: input.objective.objective
    });
  }
  const seen = new Set<string>();
  return hints.filter((hint) => {
    const key = `${hint.kind}:${hint.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5);
}

type SourceState = {
  headOid: string;
  changesFingerprint: string;
};

function sourceStateFrom(value: unknown): SourceState | undefined {
  if (!isRecord(value)) return undefined;
  const source = isRecord(value.sourceState) ? value.sourceState : value;
  if (typeof source.headOid !== "string" || typeof source.changesFingerprint !== "string") return undefined;
  return { headOid: source.headOid, changesFingerprint: source.changesFingerprint };
}

function sourceFreshness(
  current: SourceState | undefined,
  evidence: SourceState | undefined,
  currentUnknown: boolean
): ConsoleFreshness {
  if (currentUnknown || current === undefined || evidence === undefined) return "unknown";
  return current.headOid === evidence.headOid && current.changesFingerprint === evidence.changesFingerprint
    ? "fresh"
    : "stale";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
