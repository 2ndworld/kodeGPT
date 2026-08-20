import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

export const WORKSPACE_CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_CHECKPOINT_MAX_BYTES = 16 * 1024;

const MAX_OBJECTIVE_BYTES = 2 * 1024;
const MAX_NEXT_ACTIONS = 8;
const MAX_NEXT_ACTION_BYTES = 512;
const MAX_EVIDENCE_REFS = 16;
const MAX_EVIDENCE_REF_BYTES = 512;
const MAX_EVIDENCE_SUMMARY_BYTES = 1024;
const MAX_BLOCKER_BYTES = 2 * 1024;
const MAX_NOTES_BYTES = 4 * 1024;
const TRUST_ID_PATTERN = /^trust_[a-f0-9]{32}$/;
const HEAD_OID_PATTERN = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

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
    return this.#readUnlocked(trustId);
  }

  async upsert(input: {
    trustId: string;
    body: WorkspaceCheckpointBody;
    expectedRevision?: number;
  }): Promise<WorkspaceCheckpoint> {
    validateTrustId(input.trustId);
    validateExpectedRevision(input.expectedRevision);
    const body = normalizeBody(input.body);

    return this.#serialize(input.trustId, async () => {
      const current = await this.#readUnlocked(input.trustId);
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
      await this.#writeUnlocked(input.trustId, checkpoint);
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
    let text: string;
    try {
      text = await readFile(this.#pathFor(trustId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (Buffer.byteLength(text, "utf8") > WORKSPACE_CHECKPOINT_MAX_BYTES) {
      throw new WorkspaceCheckpointError(
        "CHECKPOINT_LIMIT_EXCEEDED",
        "Persisted workspace checkpoint exceeds the maximum size"
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
    return parseCheckpoint(value);
  }

  async #writeUnlocked(trustId: string, checkpoint: WorkspaceCheckpoint): Promise<void> {
    const serialized = `${JSON.stringify(checkpoint)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > WORKSPACE_CHECKPOINT_MAX_BYTES) {
      throw new WorkspaceCheckpointError(
        "CHECKPOINT_LIMIT_EXCEEDED",
        "Workspace checkpoint exceeds the maximum size"
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
