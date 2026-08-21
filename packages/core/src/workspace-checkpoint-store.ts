import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

export const WORKSPACE_CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_CHECKPOINT_MAX_BYTES = 16 * 1024;
export const WORKSPACE_CONTINUITY_PERSISTENCE_SCHEMA_VERSION = 2 as const;
export const WORKSPACE_CONTINUITY_MAX_BYTES = 32 * 1024;
export const WORKSPACE_MILESTONE_MAX_COUNT = 8;

const MAX_OBJECTIVE_BYTES = 2 * 1024;
const MAX_MILESTONE_OBJECTIVE_BYTES = 512;
const MAX_NEXT_ACTIONS = 8;
const MAX_NEXT_ACTION_BYTES = 512;
const MAX_EVIDENCE_REFS = 16;
const MAX_EVIDENCE_REF_BYTES = 512;
const MAX_EVIDENCE_SUMMARY_BYTES = 1024;
const MAX_BLOCKER_BYTES = 2 * 1024;
const MAX_NOTES_BYTES = 4 * 1024;
const TRUST_ID_PATTERN = /^trust_[a-f0-9]{32}$/;
const HEAD_OID_PATTERN = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const CHANGES_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export type WorkspaceCheckpointStatus = "active" | "blocked" | "complete";
export type WorkspaceCheckpointEvidenceKind =
  | "artifact"
  | "process"
  | "preview"
  | "pr"
  | "ci"
  | "git"
  | "note";

export interface WorkspaceCheckpointBody {
  objective?: string;
  status: WorkspaceCheckpointStatus;
  baseline?: {
    branch?: string;
    headOid?: string;
  };
  nextActions: string[];
  evidenceRefs: Array<{
    kind: WorkspaceCheckpointEvidenceKind;
    ref: string;
    summary?: string;
  }>;
  blocker?: string;
  notes?: string;
}

export interface WorkspaceCheckpoint extends WorkspaceCheckpointBody {
  schemaVersion: typeof WORKSPACE_CHECKPOINT_SCHEMA_VERSION;
  revision: number;
  updatedAt: string;
}

export interface WorkspaceCheckpointSourceStateRef {
  headOid: string;
  changesFingerprint: string;
}

export interface WorkspaceMilestone {
  revision: number;
  status: WorkspaceCheckpointStatus;
  objective?: string;
  sourceState?: WorkspaceCheckpointSourceStateRef;
  updatedAt: string;
}

export interface WorkspaceContinuityInfo {
  schemaVersion: 1;
  capturedSourceState?: WorkspaceCheckpointSourceStateRef;
  milestones: WorkspaceMilestone[];
}

export interface WorkspaceContinuityRecord {
  checkpoint: WorkspaceCheckpoint;
  continuity: WorkspaceContinuityInfo;
}

export type WorkspaceCheckpointErrorCode =
  | "CHECKPOINT_NOT_FOUND"
  | "CHECKPOINT_STALE"
  | "CHECKPOINT_INVALID"
  | "CHECKPOINT_LIMIT_EXCEEDED"
  | "CHECKPOINT_SCHEMA_UNSUPPORTED";

export class WorkspaceCheckpointError extends Error {
  readonly code: WorkspaceCheckpointErrorCode;

  constructor(code: WorkspaceCheckpointErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceCheckpointError";
    this.code = code;
  }
}

export class WorkspaceCheckpointStore {
  readonly #stateRoot: string;
  readonly #directory: string;
  readonly #now: () => Date;
  readonly #mutationTails = new Map<string, Promise<void>>();

  constructor(stateRoot: string, options: { now?: () => Date } = {}) {
    if (stateRoot.length === 0) {
      throw new TypeError("Workspace checkpoint state root must not be empty");
    }
    this.#stateRoot = resolve(stateRoot);
    this.#directory = join(this.#stateRoot, "workspace-checkpoints");
    this.#now = options.now ?? (() => new Date());
  }

  async read(trustId: string): Promise<WorkspaceCheckpoint | undefined> {
    validateTrustId(trustId);
    return (await this.#readContinuityUnlocked(trustId))?.checkpoint;
  }

  async readContinuity(trustId: string): Promise<WorkspaceContinuityRecord | undefined> {
    validateTrustId(trustId);
    return this.#readContinuityUnlocked(trustId);
  }

  async upsert(input: {
    trustId: string;
    body: WorkspaceCheckpointBody;
    capturedSourceState: WorkspaceCheckpointSourceStateRef;
    expectedRevision?: number;
  }): Promise<WorkspaceCheckpoint> {
    validateTrustId(input.trustId);
    validateExpectedRevision(input.expectedRevision);
    const body = normalizeBody(input.body);
    const capturedSourceState = normalizeSourceState(
      input.capturedSourceState,
      "captured source state"
    );

    return this.#serialize(input.trustId, async () => {
      const currentRecord = await this.#readContinuityUnlocked(input.trustId);
      const current = currentRecord?.checkpoint;
      if (current === undefined) {
        if (input.expectedRevision !== undefined) {
          throw new WorkspaceCheckpointError(
            "CHECKPOINT_NOT_FOUND",
            "Workspace checkpoint was not found"
          );
        }
      } else if (
        input.expectedRevision === undefined ||
        input.expectedRevision !== current.revision
      ) {
        throw new WorkspaceCheckpointError(
          "CHECKPOINT_STALE",
          "Workspace checkpoint revision is stale"
        );
      }

      let updatedAt: string;
      try {
        updatedAt = this.#now().toISOString();
      } catch (error) {
        throw new WorkspaceCheckpointError(
          "CHECKPOINT_INVALID",
          "Workspace checkpoint clock is invalid",
          { cause: error }
        );
      }
      const checkpoint: WorkspaceCheckpoint = {
        schemaVersion: WORKSPACE_CHECKPOINT_SCHEMA_VERSION,
        revision: (current?.revision ?? 0) + 1,
        ...cloneBody(body),
        updatedAt
      };
      ensureSerializedBound(checkpoint);
      const milestones = [...(currentRecord?.continuity.milestones ?? [])];
      if (current !== undefined) {
        milestones.push(
          compactMilestone(current, currentRecord?.continuity.capturedSourceState)
        );
      }
      const continuity: WorkspaceContinuityRecord = {
        checkpoint,
        continuity: {
          schemaVersion: 1,
          capturedSourceState,
          milestones: milestones.slice(-WORKSPACE_MILESTONE_MAX_COUNT)
        }
      };
      await this.#writeContinuityUnlocked(input.trustId, continuity);
      return cloneCheckpoint(checkpoint);
    });
  }

  async clear(trustId: string, expectedRevision: number): Promise<void> {
    validateTrustId(trustId);
    validateExpectedRevision(expectedRevision, true);
    await this.#serialize(trustId, async () => {
      const current = await this.#readUnlocked(trustId);
      if (current === undefined) {
        throw new WorkspaceCheckpointError(
          "CHECKPOINT_NOT_FOUND",
          "Workspace checkpoint was not found"
        );
      }
      if (current.revision !== expectedRevision) {
        throw new WorkspaceCheckpointError(
          "CHECKPOINT_STALE",
          "Workspace checkpoint revision is stale"
        );
      }
      await rm(this.#pathFor(trustId));
      await syncDirectory(this.#directory);
    });
  }

  async purge(trustId: string): Promise<void> {
    validateTrustId(trustId);
    await this.#serialize(trustId, async () => {
      await rm(this.#pathFor(trustId), { force: true });
      await syncDirectory(this.#directory, true);
    });
  }

  async #readUnlocked(trustId: string): Promise<WorkspaceCheckpoint | undefined> {
    return (await this.#readContinuityUnlocked(trustId))?.checkpoint;
  }

  async #readContinuityUnlocked(trustId: string): Promise<WorkspaceContinuityRecord | undefined> {
    let text: string;
    try {
      text = await readFile(this.#pathFor(trustId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (Buffer.byteLength(text, "utf8") > WORKSPACE_CONTINUITY_MAX_BYTES) {
      throw new WorkspaceCheckpointError(
        "CHECKPOINT_LIMIT_EXCEEDED",
        "Persisted workspace continuity exceeds the maximum size"
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      throw new WorkspaceCheckpointError(
        "CHECKPOINT_INVALID",
        "Workspace checkpoint is invalid JSON",
        { cause: error }
      );
    }
    return parseContinuity(value);
  }

  async #writeContinuityUnlocked(
    trustId: string,
    record: WorkspaceContinuityRecord
  ): Promise<void> {
    const serialized = `${JSON.stringify({
      schemaVersion: WORKSPACE_CONTINUITY_PERSISTENCE_SCHEMA_VERSION,
      current: record.checkpoint,
      ...(record.continuity.capturedSourceState === undefined
        ? {}
        : { capturedSourceState: record.continuity.capturedSourceState }),
      milestones: record.continuity.milestones
    })}\n`;
    if (Buffer.byteLength(serialized, "utf8") > WORKSPACE_CONTINUITY_MAX_BYTES) {
      throw new WorkspaceCheckpointError(
        "CHECKPOINT_LIMIT_EXCEEDED",
        "Workspace continuity exceeds the maximum size"
      );
    }

    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
    const finalPath = this.#pathFor(trustId);
    const temporaryPath = join(
      this.#directory,
      `.${trustId}.${process.pid}.${randomUUID().replaceAll("-", "")}.tmp`
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, finalPath);
      await chmod(finalPath, 0o600);
      await syncDirectory(this.#directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #serialize<T>(trustId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTails.get(trustId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#mutationTails.set(trustId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#mutationTails.get(trustId) === tail) {
        this.#mutationTails.delete(trustId);
      }
    }
  }

  #pathFor(trustId: string): string {
    return join(this.#directory, `${trustId}.json`);
  }
}

function parseContinuity(value: unknown): WorkspaceContinuityRecord {
  if (!isRecord(value)) {
    throw invalid("Workspace continuity must be an object");
  }
  if (value.schemaVersion === WORKSPACE_CHECKPOINT_SCHEMA_VERSION) {
    return {
      checkpoint: parseCheckpoint(value),
      continuity: { schemaVersion: 1, milestones: [] }
    };
  }
  if (value.schemaVersion !== WORKSPACE_CONTINUITY_PERSISTENCE_SCHEMA_VERSION) {
    throw new WorkspaceCheckpointError(
      "CHECKPOINT_SCHEMA_UNSUPPORTED",
      `Unsupported workspace checkpoint schema version: ${String(value.schemaVersion)}`
    );
  }
  if (!exactKeys(value, ["schemaVersion", "current", "capturedSourceState", "milestones"])) {
    throw invalid("Workspace continuity contains unknown fields");
  }
  const checkpoint = parseCheckpoint(value.current);
  const capturedSourceState =
    value.capturedSourceState === undefined
      ? undefined
      : normalizeSourceState(value.capturedSourceState, "captured source state");
  if (!Array.isArray(value.milestones)) {
    throw invalid("Workspace continuity milestones must be an array");
  }
  if (value.milestones.length > WORKSPACE_MILESTONE_MAX_COUNT) {
    throw limit("Workspace continuity has too many milestones");
  }
  const milestones = value.milestones.map((milestone) => normalizeMilestone(milestone));
  return cloneContinuityRecord({
    checkpoint,
    continuity: {
      schemaVersion: 1,
      ...(capturedSourceState === undefined ? {} : { capturedSourceState }),
      milestones
    }
  });
}

function normalizeSourceState(value: unknown, label: string): WorkspaceCheckpointSourceStateRef {
  if (!isRecord(value) || !exactKeys(value, ["headOid", "changesFingerprint"])) {
    throw invalid(`Workspace checkpoint ${label} is invalid`);
  }
  if (typeof value.headOid !== "string" || !HEAD_OID_PATTERN.test(value.headOid)) {
    throw invalid(`Workspace checkpoint ${label} head OID is invalid`);
  }
  if (
    typeof value.changesFingerprint !== "string" ||
    !CHANGES_FINGERPRINT_PATTERN.test(value.changesFingerprint)
  ) {
    throw invalid(`Workspace checkpoint ${label} fingerprint is invalid`);
  }
  return {
    headOid: value.headOid.toLowerCase(),
    changesFingerprint: value.changesFingerprint
  };
}

function normalizeMilestone(value: unknown): WorkspaceMilestone {
  if (!isRecord(value) || !exactKeys(value, ["revision", "status", "objective", "sourceState", "updatedAt"])) {
    throw invalid("Workspace continuity milestone is invalid");
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) <= 0) {
    throw invalid("Workspace continuity milestone revision is invalid");
  }
  if (!isStatus(value.status)) {
    throw invalid("Workspace continuity milestone status is invalid");
  }
  const objective = optionalBoundedString(
    value.objective,
    MAX_MILESTONE_OBJECTIVE_BYTES,
    "milestone objective"
  );
  const sourceState =
    value.sourceState === undefined
      ? undefined
      : normalizeSourceState(value.sourceState, "milestone source state");
  if (typeof value.updatedAt !== "string" || !isCanonicalTimestamp(value.updatedAt)) {
    throw invalid("Workspace continuity milestone timestamp is invalid");
  }
  return {
    revision: value.revision as number,
    status: value.status,
    ...(objective === undefined ? {} : { objective }),
    ...(sourceState === undefined ? {} : { sourceState }),
    updatedAt: value.updatedAt
  };
}

function parseCheckpoint(value: unknown): WorkspaceCheckpoint {
  if (!isRecord(value)) {
    throw invalid("Workspace checkpoint must be an object");
  }
  if (value.schemaVersion !== WORKSPACE_CHECKPOINT_SCHEMA_VERSION) {
    throw new WorkspaceCheckpointError(
      "CHECKPOINT_SCHEMA_UNSUPPORTED",
      `Unsupported workspace checkpoint schema version: ${String(value.schemaVersion)}`
    );
  }
  if (
    !exactKeys(value, [
      "schemaVersion",
      "revision",
      "objective",
      "status",
      "baseline",
      "nextActions",
      "evidenceRefs",
      "blocker",
      "notes",
      "updatedAt"
    ])
  ) {
    throw invalid("Workspace checkpoint contains unknown fields");
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) <= 0) {
    throw invalid("Workspace checkpoint revision is invalid");
  }
  if (
    typeof value.updatedAt !== "string" ||
    !isCanonicalTimestamp(value.updatedAt)
  ) {
    throw invalid("Workspace checkpoint timestamp is invalid");
  }

  const body = normalizeBody({
    ...(value.objective === undefined ? {} : { objective: value.objective }),
    status: value.status,
    ...(value.baseline === undefined ? {} : { baseline: value.baseline }),
    nextActions: value.nextActions,
    evidenceRefs: value.evidenceRefs,
    ...(value.blocker === undefined ? {} : { blocker: value.blocker }),
    ...(value.notes === undefined ? {} : { notes: value.notes })
  } as WorkspaceCheckpointBody);
  const checkpoint: WorkspaceCheckpoint = {
    schemaVersion: WORKSPACE_CHECKPOINT_SCHEMA_VERSION,
    revision: value.revision as number,
    ...body,
    updatedAt: value.updatedAt
  };
  ensureSerializedBound(checkpoint);
  return cloneCheckpoint(checkpoint);
}

function normalizeBody(value: WorkspaceCheckpointBody): WorkspaceCheckpointBody {
  if (!isRecord(value)) throw invalid("Workspace checkpoint body must be an object");
  if (
    !exactKeys(value, [
      "objective",
      "status",
      "baseline",
      "nextActions",
      "evidenceRefs",
      "blocker",
      "notes"
    ])
  ) {
    throw invalid("Workspace checkpoint body contains unknown fields");
  }
  if (!isStatus(value.status)) throw invalid("Workspace checkpoint status is invalid");

  const objective = optionalBoundedString(value.objective, MAX_OBJECTIVE_BYTES, "objective");
  const blocker = optionalBoundedString(value.blocker, MAX_BLOCKER_BYTES, "blocker");
  const notes = optionalBoundedString(value.notes, MAX_NOTES_BYTES, "notes");

  if (!Array.isArray(value.nextActions)) {
    throw invalid("Workspace checkpoint nextActions must be an array");
  }
  if (value.nextActions.length > MAX_NEXT_ACTIONS) {
    throw limit("Workspace checkpoint has too many next actions");
  }
  const nextActions = value.nextActions.map((action) => {
    if (typeof action !== "string") throw invalid("Workspace checkpoint next action is invalid");
    ensureUtf8Bound(action, MAX_NEXT_ACTION_BYTES, "next action");
    return action;
  });

  if (!Array.isArray(value.evidenceRefs)) {
    throw invalid("Workspace checkpoint evidenceRefs must be an array");
  }
  if (value.evidenceRefs.length > MAX_EVIDENCE_REFS) {
    throw limit("Workspace checkpoint has too many evidence references");
  }
  const evidenceRefs = value.evidenceRefs.map((entry) => normalizeEvidence(entry));
  const baseline = value.baseline === undefined ? undefined : normalizeBaseline(value.baseline);

  if (value.status === "blocked") {
    if (blocker === undefined || blocker.trim().length === 0) {
      throw invalid("Blocked workspace checkpoint requires a blocker");
    }
  } else if (blocker !== undefined) {
    throw invalid("Only blocked workspace checkpoints may contain a blocker");
  }
  if (value.status === "complete" && nextActions.length !== 0) {
    throw invalid("Complete workspace checkpoint must have no next actions");
  }

  return {
    ...(objective === undefined ? {} : { objective }),
    status: value.status,
    ...(baseline === undefined ? {} : { baseline }),
    nextActions,
    evidenceRefs,
    ...(blocker === undefined ? {} : { blocker }),
    ...(notes === undefined ? {} : { notes })
  };
}

function normalizeBaseline(value: unknown): NonNullable<WorkspaceCheckpointBody["baseline"]> {
  if (!isRecord(value) || !exactKeys(value, ["branch", "headOid"])) {
    throw invalid("Workspace checkpoint baseline is invalid");
  }
  const branch = value.branch;
  if (branch !== undefined && typeof branch !== "string") {
    throw invalid("Workspace checkpoint baseline branch is invalid");
  }
  const headOid = value.headOid;
  if (
    headOid !== undefined &&
    (typeof headOid !== "string" || !HEAD_OID_PATTERN.test(headOid))
  ) {
    throw invalid("Workspace checkpoint baseline head OID is invalid");
  }
  return {
    ...(branch === undefined ? {} : { branch }),
    ...(headOid === undefined ? {} : { headOid: headOid.toLowerCase() })
  };
}

function normalizeEvidence(value: unknown): WorkspaceCheckpointBody["evidenceRefs"][number] {
  if (!isRecord(value) || !exactKeys(value, ["kind", "ref", "summary"])) {
    throw invalid("Workspace checkpoint evidence reference is invalid");
  }
  if (!isEvidenceKind(value.kind)) {
    throw invalid("Workspace checkpoint evidence kind is invalid");
  }
  if (typeof value.ref !== "string" || value.ref.length === 0) {
    throw invalid("Workspace checkpoint evidence ref is invalid");
  }
  ensureUtf8Bound(value.ref, MAX_EVIDENCE_REF_BYTES, "evidence ref");
  const summary = optionalBoundedString(
    value.summary,
    MAX_EVIDENCE_SUMMARY_BYTES,
    "evidence summary"
  );
  return {
    kind: value.kind,
    ref: value.ref,
    ...(summary === undefined ? {} : { summary })
  };
}

function compactMilestone(
  checkpoint: WorkspaceCheckpoint,
  sourceState: WorkspaceCheckpointSourceStateRef | undefined
): WorkspaceMilestone {
  return {
    revision: checkpoint.revision,
    status: checkpoint.status,
    ...(checkpoint.objective === undefined
      ? {}
      : { objective: compactUtf8(checkpoint.objective, MAX_MILESTONE_OBJECTIVE_BYTES) }),
    ...(sourceState === undefined ? {} : { sourceState: cloneSourceState(sourceState) }),
    updatedAt: checkpoint.updatedAt
  };
}

function compactUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(output + character, "utf8") > maxBytes) break;
    output += character;
  }
  return output;
}

function optionalBoundedString(
  value: unknown,
  maxBytes: number,
  label: string
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid(`Workspace checkpoint ${label} is invalid`);
  ensureUtf8Bound(value, maxBytes, label);
  return value;
}

function ensureUtf8Bound(value: string, maxBytes: number, label: string): void {
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw limit(`Workspace checkpoint ${label} exceeds its byte limit`);
  }
}

function ensureSerializedBound(checkpoint: WorkspaceCheckpoint): void {
  const serialized = `${JSON.stringify(checkpoint)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > WORKSPACE_CHECKPOINT_MAX_BYTES) {
    throw limit("Workspace checkpoint exceeds the maximum serialized size");
  }
}

function validateTrustId(value: string): void {
  if (!TRUST_ID_PATTERN.test(value)) {
    throw invalid("Workspace checkpoint trust ID is invalid");
  }
}

function validateExpectedRevision(value: number | undefined, required = false): void {
  if (value === undefined) {
    if (required) throw invalid("Workspace checkpoint expected revision is required");
    return;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalid("Workspace checkpoint expected revision is invalid");
  }
}

function isCanonicalTimestamp(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isStatus(value: unknown): value is WorkspaceCheckpointStatus {
  return value === "active" || value === "blocked" || value === "complete";
}

function isEvidenceKind(value: unknown): value is WorkspaceCheckpointEvidenceKind {
  return (
    value === "artifact" ||
    value === "process" ||
    value === "preview" ||
    value === "pr" ||
    value === "ci" ||
    value === "git" ||
    value === "note"
  );
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function cloneBody(body: WorkspaceCheckpointBody): WorkspaceCheckpointBody {
  return {
    ...(body.objective === undefined ? {} : { objective: body.objective }),
    status: body.status,
    ...(body.baseline === undefined ? {} : { baseline: { ...body.baseline } }),
    nextActions: [...body.nextActions],
    evidenceRefs: body.evidenceRefs.map((entry) => ({ ...entry })),
    ...(body.blocker === undefined ? {} : { blocker: body.blocker }),
    ...(body.notes === undefined ? {} : { notes: body.notes })
  };
}

function cloneCheckpoint(checkpoint: WorkspaceCheckpoint): WorkspaceCheckpoint {
  return {
    schemaVersion: WORKSPACE_CHECKPOINT_SCHEMA_VERSION,
    revision: checkpoint.revision,
    ...cloneBody(checkpoint),
    updatedAt: checkpoint.updatedAt
  };
}

function cloneSourceState(
  sourceState: WorkspaceCheckpointSourceStateRef
): WorkspaceCheckpointSourceStateRef {
  return { ...sourceState };
}

function cloneMilestone(milestone: WorkspaceMilestone): WorkspaceMilestone {
  return {
    revision: milestone.revision,
    status: milestone.status,
    ...(milestone.objective === undefined ? {} : { objective: milestone.objective }),
    ...(milestone.sourceState === undefined
      ? {}
      : { sourceState: cloneSourceState(milestone.sourceState) }),
    updatedAt: milestone.updatedAt
  };
}

function cloneContinuityRecord(record: WorkspaceContinuityRecord): WorkspaceContinuityRecord {
  return {
    checkpoint: cloneCheckpoint(record.checkpoint),
    continuity: {
      schemaVersion: 1,
      ...(record.continuity.capturedSourceState === undefined
        ? {}
        : { capturedSourceState: cloneSourceState(record.continuity.capturedSourceState) }),
      milestones: record.continuity.milestones.map((milestone) => cloneMilestone(milestone))
    }
  };
}

async function syncDirectory(path: string, allowMissing = false): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function invalid(message: string): WorkspaceCheckpointError {
  return new WorkspaceCheckpointError("CHECKPOINT_INVALID", message);
}

function limit(message: string): WorkspaceCheckpointError {
  return new WorkspaceCheckpointError("CHECKPOINT_LIMIT_EXCEEDED", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
