import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { toPublicArtifactMetadata, type ArtifactMetadata } from "@kodegpt/artifacts";
import {
  getProfilePreset,
  profilePolicySchema,
  resolveProfile,
  type ProfilePolicy
} from "@kodegpt/profiles";
import type { RuntimeMethod } from "@kodegpt/protocol";
import type {
  PersistentFilesystemIdentity,
  ProfileCeiling,
  TrustedWorkspaceEntry
} from "@kodegpt/trust";

import { KernelRpcError } from "./kernel-client.js";
import type {
  WorkspaceCheckpoint,
  WorkspaceCheckpointBody,
  WorkspaceCheckpointSourceStateRef,
  WorkspaceContinuityInfo,
  WorkspaceContinuityRecord
} from "./workspace-checkpoint-store.js";

export interface KernelTransport {
  request<T>(method: RuntimeMethod, params: Record<string, unknown>): Promise<T>;
}

export interface TrustResolver {
  list(): TrustedWorkspaceEntry[] | Promise<TrustedWorkspaceEntry[]>;
  trust(input: {
    canonicalRoot: string;
    identity: PersistentFilesystemIdentity;
    profileCeiling: ProfileCeiling;
  }): TrustedWorkspaceEntry | Promise<TrustedWorkspaceEntry>;
  untrust(id: string): boolean | Promise<boolean>;
  requireTrusted(
    canonicalRoot: string,
    actualIdentity: PersistentFilesystemIdentity
  ): TrustedWorkspaceEntry | Promise<TrustedWorkspaceEntry>;
}

export interface OpenWorkspace {
  id: string;
  canonicalRoot: string;
  effectivePolicy: ProfilePolicy;
}

export interface WorkspaceInfo extends OpenWorkspace {
  checkpoint?: WorkspaceCheckpoint;
  continuity?: WorkspaceContinuityInfo;
}

export type WorkspaceCheckpointMutationInput =
  | {
      workspaceId: string;
      operation: "upsert";
      expectedRevision?: number;
      checkpoint: WorkspaceCheckpointBody;
      capturedSourceState: WorkspaceCheckpointSourceStateRef;
    }
  | {
      workspaceId: string;
      operation: "clear";
      expectedRevision: number;
    };

export type WorkspaceCheckpointMutationResult =
  | {
      schemaVersion: 1;
      operation: "upsert";
      checkpoint: WorkspaceCheckpoint;
    }
  | {
      schemaVersion: 1;
      operation: "clear";
      cleared: true;
    };

interface WorkspaceCheckpointStorage {
  readContinuity(trustId: string): Promise<WorkspaceContinuityRecord | undefined>;
  upsert(input: {
    trustId: string;
    body: WorkspaceCheckpointBody;
    capturedSourceState: WorkspaceCheckpointSourceStateRef;
    expectedRevision?: number;
  }): Promise<WorkspaceCheckpoint>;
  clear(trustId: string, expectedRevision: number): Promise<void>;
  purge(trustId: string): Promise<void>;
}

export interface TrustedWorkspaceSummary {
  id: string;
  canonicalRoot: string;
  profileCeiling: ProfileCeiling;
  trustedAt: string;
}

type TrustAuditAction = "trust" | "profile_update" | "untrust";
type TrustAuditPhase = "decision" | "success" | "failed";
type CheckpointAuditAction = "upsert" | "clear";
type CheckpointAuditPhase = "decision" | "success" | "failed";

export interface WorkspaceFileReadResult {
  contents: string;
  bytesRead: number;
  eof: boolean;
}

export interface WorkspaceFileReadBytesResult {
  bytes: Uint8Array;
  bytesRead: number;
  eof: boolean;
}

export type WorkspaceFileWritePrecondition =
  | { kind: "missing" }
  | { kind: "sha256"; value: string };

export interface WorkspaceFileWriteResult {
  bytesWritten: number;
  created: boolean;
}

export interface WorkspaceFileEditResult {
  bytesWritten: number;
  replacements: number;
}

export type WorkspacePatchFileAction = "create" | "update" | "delete";

export interface WorkspacePatchFileCommitInput {
  workspaceId: string;
  path: string;
  action: WorkspacePatchFileAction;
  expectedSha256: string | null;
  content: string | null;
}

export interface WorkspacePatchFileCommitResult {
  schemaVersion: 1;
  action: WorkspacePatchFileAction;
  bytesWritten: number;
  sha256: string | null;
}

export interface WorkspacePathIdentityResult {
  schemaVersion: 1;
  exists: boolean;
  kind?: "file" | "directory" | "symlink" | "other";
  sizeBytes?: number;
  sha256?: string;
  hashTruncated: boolean;
}

export type WorkspaceGitRevision =
  | { kind: "head" }
  | { kind: "oid"; oid: string }
  | { kind: "branch"; name: string }
  | { kind: "tag"; name: string };

export interface WorkspaceGitLogInput {
  workspaceId: string;
  revision: WorkspaceGitRevision;
  path?: string;
  limit: number;
}

export interface WorkspaceGitShowInput {
  workspaceId: string;
  revision: WorkspaceGitRevision;
  path?: string;
  includePatch: boolean;
  maxPatchBytes: number;
}

export interface WorkspaceGitRangeInput {
  workspaceId: string;
  baseRevision: WorkspaceGitRevision;
  headRevision: WorkspaceGitRevision;
  mode: "direct" | "symmetric";
  limit: number;
}

export interface WorkspaceGitDiffHistoryInput {
  workspaceId: string;
  baseRevision: WorkspaceGitRevision;
  headRevision: WorkspaceGitRevision;
  path?: string;
  maxPatchBytes: number;
}

export interface WorkspaceGitCommitSummary {
  oid: string;
  shortOid: string;
  parents: string[];
  authorName: string;
  authorTime: number;
  committerTime: number;
  subject: string;
  encodingLossy: boolean;
}

export interface WorkspaceGitCommitDetail extends WorkspaceGitCommitSummary {
  body: string;
  messageTruncated: boolean;
}

export type WorkspaceGitChangedPathStatus = "added" | "modified" | "deleted" | "typeChanged";

export interface WorkspaceGitChangedPath {
  path: string;
  status: WorkspaceGitChangedPathStatus;
  insertions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface WorkspaceGitStatSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  binaryFiles: number;
}

export type WorkspaceGitHistoryTruncationReason =
  | "COMMIT_LIMIT"
  | "MESSAGE_LIMIT"
  | "PATCH_LIMIT"
  | "PATH_LIMIT";

export interface WorkspaceGitLogResult {
  schemaVersion: 1;
  resolvedOid: string;
  commits: WorkspaceGitCommitSummary[];
  returnedCount: number;
  truncated: boolean;
  truncationReasons: WorkspaceGitHistoryTruncationReason[];
}

export interface WorkspaceGitShowResult {
  schemaVersion: 1;
  commit: WorkspaceGitCommitDetail;
  changedPaths: WorkspaceGitChangedPath[];
  summary: WorkspaceGitStatSummary;
  patch: string | null;
  truncated: boolean;
  truncationReasons: WorkspaceGitHistoryTruncationReason[];
}

export interface WorkspaceGitRangeResult {
  schemaVersion: 1;
  baseOid: string;
  headOid: string;
  isAncestor: boolean;
  mergeBaseOid: string | null;
  ahead: { value: number; exact: boolean };
  behind: { value: number; exact: boolean };
  commits: Array<WorkspaceGitCommitSummary & { side?: "base" | "head" }>;
  returnedCount: number;
  truncated: boolean;
  truncationReasons: WorkspaceGitHistoryTruncationReason[];
}

export interface WorkspaceGitHistoryDiffResult {
  schemaVersion: 1;
  baseOid: string;
  headOid: string;
  changedPaths: WorkspaceGitChangedPath[];
  summary: WorkspaceGitStatSummary;
  patch: string;
  truncated: boolean;
  truncationReasons: WorkspaceGitHistoryTruncationReason[];
}

export interface WorkspaceGitInspectionResult {
  schemaVersion: 1;
  exitCode: number;
  stdoutPreview: string;
  stderrPreview: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  sourceTruncated: boolean;
  bytesSpooled: number;
  artifact: ArtifactMetadata;
}

export interface WorkspaceGitRepositoryIdentity {
  headOid: string;
  branch: string | null;
  remotes: Array<{
    name: string;
    fetchUrl: string;
  }>;
}

export type WorkspaceRemoteCiCapability =
  | "ci.repository"
  | "ci.status"
  | "ci.runs"
  | "ci.run"
  | "ci.failure"
  | "ci.rerun"
  | "ci.cancel"
  | "ci.dispatch";

export type WorkspaceRemoteCiErrorCode =
  | "CI_WORKSPACE_AMBIGUOUS"
  | "CI_AUDIT_UNAVAILABLE"
  | "CI_AUTH_REQUIRED"
  | "CI_AUTH_FAILED"
  | "CI_REPOSITORY_UNAVAILABLE"
  | "CI_REPOSITORY_MISMATCH"
  | "CI_REMOTE_UNSUPPORTED"
  | "CI_NOT_FOUND"
  | "CI_PERMISSION_DENIED"
  | "CI_RATE_LIMITED"
  | "CI_PROVIDER_UNAVAILABLE"
  | "CI_RESPONSE_INVALID"
  | "CI_RESPONSE_LIMIT_EXCEEDED"
  | "CI_LOG_UNAVAILABLE"
  | "CI_LOG_LIMIT_EXCEEDED"
  | "CI_MUTATION_OUTCOME_UNKNOWN"
  | "CI_MUTATION_STATE_CONFLICT";

export interface WorkspaceRemoteCiAuditInput {
  workspaceId: string;
  operationId: string;
  capability: WorkspaceRemoteCiCapability;
  phase: "decision" | "success" | "failed";
  provider: "github";
  repository: string;
  credentialSource?: "gh";
  runId?: string;
  jobId?: string;
  errorCode?: WorkspaceRemoteCiErrorCode;
  truncated?: boolean;
  durationMs?: number;
}

export type WorkspaceGitMutationOperation =
  | "stage"
  | "commit"
  | "branch_create"
  | "branch_switch"
  | "branch_delete";

export interface WorkspaceGitMutationResult extends WorkspaceGitInspectionResult {
  operation: WorkspaceGitMutationOperation;
}

export interface WorkspaceGitWorktreeCreateResult {
  schemaVersion: 1;
  operation: "create";
  name: string;
  relativePath: `.worktrees/${string}`;
  branch: string;
  headOid: string;
}

export interface WorkspaceGitWorktreeRemoveResult {
  schemaVersion: 1;
  operation: "remove";
  name: string;
  relativePath: `.worktrees/${string}`;
  removed: true;
}

export type WorkspaceGitWorktreeMutationResult =
  | WorkspaceGitWorktreeCreateResult
  | WorkspaceGitWorktreeRemoveResult;

export type WorkspaceGitRemoteMutationOperation = "fetch" | "pull" | "push";

export interface WorkspaceGitRemoteCredential {
  readonly kind: "github_token";
  readonly token: string;
}

export interface WorkspaceGitRemoteMutationResult extends WorkspaceGitInspectionResult {
  operation: WorkspaceGitRemoteMutationOperation;
}

export interface WorkspaceGitCheckpointRecord {
  recordType: "ordinary" | "rename" | "unmerged" | "untracked";
  path: string;
  originalPath?: string;
  indexStatus?: string;
  worktreeStatus?: string;
  headMode?: string;
  indexMode?: string;
  worktreeMode?: string;
  headOid?: string;
  indexOid?: string;
  stage1Oid?: string;
  stage2Oid?: string;
  stage3Oid?: string;
  currentIdentity?: WorkspacePathIdentityResult;
}

export interface WorkspaceGitCheckpointResult {
  schemaVersion: 1;
  headOid: string;
  records: WorkspaceGitCheckpointRecord[];
  truncated: boolean;
}

export type ProcessOperationState = "running" | "completed" | "failed" | "cancelled";

export interface WorkspaceProcessOperationResult {
  schemaVersion: 1;
  operationId: string;
  state: ProcessOperationState;
  exitCode?: number;
  stdoutPreview: string;
  stderrPreview: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  sourceTruncated: boolean;
  bytesSpooled: number;
  artifact: ArtifactMetadata;
}

export interface WorkspaceProcessRunInput {
  workspaceId: string;
  logicalExecutable: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  background?: boolean;
}

export interface WorkspaceExecutableAvailabilityResult {
  schemaVersion: 1;
  executableAvailable: boolean;
  sandboxAvailable: boolean;
}

export interface WorkspaceVerificationRunInput {
  workspaceId: string;
  recipeId: string;
  logicalExecutable: string;
  argv: string[];
  cwd: string;
  background?: boolean;
}

export type WorkspaceTraversalScope = "literal" | "semantic";
export type WorkspaceTreeEntryKind = "file" | "directory" | "symlink" | "other";

export interface WorkspaceTreeEntry {
  path: string;
  kind: WorkspaceTreeEntryKind;
}

export interface WorkspaceTreeMetadataEntry extends WorkspaceTreeEntry {
  sizeBytes: number;
}

export interface WorkspaceTreeResult {
  entries: WorkspaceTreeMetadataEntry[];
  truncated: boolean;
}

export interface WorkspaceSearchMatch {
  path: string;
  line: number;
  lineText: string;
}

export type WorkspaceSearchTruncationReason =
  | "TREE_LIMIT"
  | "FILE_SIZE_LIMIT"
  | "SCAN_BYTE_LIMIT"
  | "MATCH_LIMIT"
  | "SNIPPET_BYTE_LIMIT";

export interface WorkspaceSearchResult {
  matches: WorkspaceSearchMatch[];
  truncated: boolean;
  truncationReasons: WorkspaceSearchTruncationReason[];
}

type WorkspacePhase = "OPENING" | "READY" | "CLOSING";

type WorkspaceState = {
  id: string;
  phase: WorkspacePhase;
  closeInFlight: boolean;
  canonicalRoot?: string;
  trustId?: string;
  capabilityId?: string;
  effectivePolicy?: ProfilePolicy;
};

interface InspectRootResult {
  canonicalRoot: string;
  identity: PersistentFilesystemIdentity;
}

interface RegisterResult {
  capabilityId: string;
}

interface ProjectProfileResult {
  contents: string | null;
}

export class WorkspaceManagerError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceManagerError";
    this.code = code;
  }
}

export class WorkspaceNotReadyError extends WorkspaceManagerError {
  constructor(workspaceId: string) {
    super("WORKSPACE_NOT_READY", `Workspace is not READY: ${workspaceId}`);
    this.name = "WorkspaceNotReadyError";
  }
}

export class WorkspaceNotFoundError extends WorkspaceManagerError {
  constructor(workspaceId: string) {
    super("WORKSPACE_NOT_FOUND", `Workspace was not found: ${workspaceId}`);
    this.name = "WorkspaceNotFoundError";
  }
}

export class WorkspaceCloseIncompleteError extends WorkspaceManagerError {
  constructor(workspaceId: string, cause?: unknown) {
    super(
      "WORKSPACE_CLOSE_INCOMPLETE",
      `Workspace close did not complete within the allowed bound: ${workspaceId}`,
      cause === undefined ? undefined : { cause }
    );
    this.name = "WorkspaceCloseIncompleteError";
  }
}

export class ProjectProfileInvalidError extends WorkspaceManagerError {
  constructor(message: string, cause?: unknown) {
    super("PROJECT_PROFILE_INVALID", message, cause === undefined ? undefined : { cause });
    this.name = "ProjectProfileInvalidError";
  }
}

export class WorkspaceManager {
  readonly #kernel: KernelTransport;
  readonly #trust: TrustResolver;
  readonly #checkpointStore: WorkspaceCheckpointStorage | undefined;
  readonly #idFactory: () => string;
  readonly #auditOperationIdFactory: () => string;
  readonly #closeTimeoutMs: number;
  readonly #workspaces = new Map<string, WorkspaceState>();

  constructor(options: {
    kernel: KernelTransport;
    trust: TrustResolver;
    checkpointStore?: WorkspaceCheckpointStorage;
    idFactory?: () => string;
    auditOperationIdFactory?: () => string;
    closeTimeoutMs?: number;
  }) {
    this.#kernel = options.kernel;
    this.#trust = options.trust;
    this.#checkpointStore = options.checkpointStore;
    this.#idFactory =
      options.idFactory ?? (() => `ws_${randomUUID().replaceAll("-", "")}`);
    this.#auditOperationIdFactory =
      options.auditOperationIdFactory ??
      (() => `op_trust_${randomUUID().replaceAll("-", "")}`);
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    if (
      !Number.isSafeInteger(this.#closeTimeoutMs) ||
      this.#closeTimeoutMs <= 0 ||
      this.#closeTimeoutMs > 5_000
    ) {
      throw new RangeError("closeTimeoutMs must be an integer in the range 1..5000");
    }
  }

  async #requestOk(method: RuntimeMethod, params: Record<string, unknown>): Promise<void> {
    const result = await this.#kernel.request<unknown>(method, params);
    if (!isRecord(result) || result.ok !== true) {
      throw new WorkspaceManagerError(
        "RUNTIME_PROTOCOL_INVALID",
        `${method} returned an invalid acknowledgement`
      );
    }
  }

  async #auditTrust(
    operationId: string,
    action: TrustAuditAction,
    phase: TrustAuditPhase
  ): Promise<void> {
    await this.#requestOk("trust.audit", { operationId, action, phase });
  }

  async #auditCheckpoint(
    operationId: string,
    action: CheckpointAuditAction,
    phase: CheckpointAuditPhase
  ): Promise<void> {
    await this.#requestOk("workspace.checkpoint_audit", { operationId, action, phase });
  }

  async openWorkspace(rootPath: string): Promise<OpenWorkspace> {
    if (rootPath.length === 0) {
      throw new TypeError("Workspace root path must not be empty");
    }
    const id = this.#idFactory();
    if (this.#workspaces.has(id)) {
      throw new WorkspaceManagerError("WORKSPACE_ID_COLLISION", `Duplicate workspace id: ${id}`);
    }
    const state: WorkspaceState = {
      id,
      phase: "OPENING",
      closeInFlight: false
    };
    this.#workspaces.set(id, state);

    try {
      const inspected = await this.#kernel.request<InspectRootResult>("system.inspect_root", {
        path: rootPath
      });
      validateInspectResult(inspected);
      state.canonicalRoot = inspected.canonicalRoot;

      const trusted = await this.#trust.requireTrusted(inspected.canonicalRoot, inspected.identity);
      state.trustId = trusted.id;
      const ceiling = getProfilePreset(trusted.profileCeiling);

      const registered = await this.#kernel.request<RegisterResult>("workspace.register", {
        rootPath: inspected.canonicalRoot,
        expectedIdentity: inspected.identity,
        ceiling
      });
      if (!isRecord(registered) || typeof registered.capabilityId !== "string" || registered.capabilityId.length === 0) {
        throw new WorkspaceManagerError(
          "RUNTIME_PROTOCOL_INVALID",
          "workspace.register returned an invalid capability"
        );
      }
      state.capabilityId = registered.capabilityId;

      const profileResult = await this.#kernel.request<ProjectProfileResult>(
        "workspace.read_project_profile",
        { capabilityId: registered.capabilityId }
      );
      if (
        !isRecord(profileResult) ||
        (profileResult.contents !== null && typeof profileResult.contents !== "string")
      ) {
        throw new WorkspaceManagerError(
          "RUNTIME_PROTOCOL_INVALID",
          "workspace.read_project_profile returned an invalid payload"
        );
      }

      const restriction =
        profileResult.contents === null ? ceiling : parseProjectProfile(profileResult.contents);
      const effectivePolicy = resolveProfile(ceiling, restriction);
      await this.#requestOk("workspace.restrict_policy", {
        capabilityId: registered.capabilityId,
        restriction: effectivePolicy
      });
      await this.#requestOk("workspace.activate", {
        capabilityId: registered.capabilityId
      });

      state.effectivePolicy = effectivePolicy;
      state.phase = "READY";
      return publicWorkspace(state);
    } catch (error) {
      const capabilityId = state.capabilityId;
      this.#workspaces.delete(id);
      if (capabilityId !== undefined) {
        await this.#requestOk("workspace.unregister", { capabilityId }).catch(() => undefined);
      }
      throw error;
    }
  }

  listWorkspaces(): OpenWorkspace[] {
    return [...this.#workspaces.values()]
      .filter((state) => state.phase === "READY" && state.capabilityId !== undefined)
      .map(publicWorkspace)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async trustWorkspace(
    rootPath: string,
    profileCeiling: ProfileCeiling = "observe"
  ): Promise<TrustedWorkspaceSummary> {
    if (rootPath.length === 0) {
      throw new TypeError("Workspace root path must not be empty");
    }
    const inspected = await this.#kernel.request<InspectRootResult>("system.inspect_root", {
      path: rootPath
    });
    validateInspectResult(inspected);
    const existing = (await this.#trust.list()).find(
      (entry) => entry.canonicalRoot === inspected.canonicalRoot
    );
    const action: TrustAuditAction = existing === undefined ? "trust" : "profile_update";
    const operationId = this.#auditOperationIdFactory();
    await this.#auditTrust(operationId, action, "decision");
    let trusted: TrustedWorkspaceEntry;
    try {
      trusted = await this.#trust.trust({
        canonicalRoot: inspected.canonicalRoot,
        identity: inspected.identity,
        profileCeiling
      });
    } catch (error) {
      try {
        await this.#auditTrust(operationId, action, "failed");
      } catch (auditError) {
        throw auditError;
      }
      throw error;
    }
    await this.#auditTrust(operationId, action, "success");
    return publicTrustedWorkspace(trusted);
  }

  async listTrustedWorkspaces(): Promise<TrustedWorkspaceSummary[]> {
    const entries = await this.#trust.list();
    return entries
      .map(publicTrustedWorkspace)
      .sort((left, right) => left.canonicalRoot.localeCompare(right.canonicalRoot));
  }

  async untrustWorkspace(trustId: string): Promise<boolean> {
    if (trustId.length === 0) {
      throw new TypeError("Workspace trust ID must not be empty");
    }
    const trusted = (await this.#trust.list()).find((entry) => entry.id === trustId);
    const bound = [...this.#workspaces.values()].filter(
      (state) =>
        state.trustId === trustId ||
        (trusted !== undefined && state.canonicalRoot === trusted.canonicalRoot)
    );
    const transitioning = bound.find((state) => state.phase !== "READY");
    if (transitioning !== undefined) {
      throw new WorkspaceNotReadyError(transitioning.id);
    }
    const operationId = this.#auditOperationIdFactory();
    await this.#auditTrust(operationId, "untrust", "decision");
    let removed: boolean;
    try {
      for (const state of bound) {
        await this.closeWorkspace(state.id);
      }
      await this.#checkpointStore?.purge(trustId);
      removed = await this.#trust.untrust(trustId);
    } catch (error) {
      try {
        await this.#auditTrust(operationId, "untrust", "failed");
      } catch (auditError) {
        throw auditError;
      }
      throw error;
    }
    await this.#auditTrust(operationId, "untrust", "success");
    return removed;
  }

  async workspaceInfo(workspaceId: string): Promise<WorkspaceInfo> {
    const state = this.#requireReadyState(workspaceId);
    const workspace = publicWorkspace(state);
    if (this.#checkpointStore === undefined) return workspace;
    const trustId = requireReadyTrustId(state);
    const record = await this.#checkpointStore.readContinuity(trustId);
    return record === undefined
      ? workspace
      : { ...workspace, checkpoint: record.checkpoint, continuity: record.continuity };
  }

  async checkpointWorkspace(
    input: WorkspaceCheckpointMutationInput
  ): Promise<WorkspaceCheckpointMutationResult> {
    const state = this.#requireReadyState(input.workspaceId);
    const checkpointStore = this.#checkpointStore;
    if (checkpointStore === undefined) {
      throw new WorkspaceManagerError(
        "CHECKPOINT_UNAVAILABLE",
        "Workspace checkpoint storage is unavailable"
      );
    }
    const trustId = requireReadyTrustId(state);
    const operationId = this.#auditOperationIdFactory();
    await this.#auditCheckpoint(operationId, input.operation, "decision");

    let result: WorkspaceCheckpointMutationResult;
    try {
      if (input.operation === "upsert") {
        const checkpoint = await checkpointStore.upsert({
          trustId,
          body: input.checkpoint,
          capturedSourceState: input.capturedSourceState,
          ...(input.expectedRevision === undefined
            ? {}
            : { expectedRevision: input.expectedRevision })
        });
        result = { schemaVersion: 1, operation: "upsert", checkpoint };
      } else {
        await checkpointStore.clear(trustId, input.expectedRevision);
        result = { schemaVersion: 1, operation: "clear", cleared: true };
      }
    } catch (error) {
      try {
        await this.#auditCheckpoint(operationId, input.operation, "failed");
      } catch (auditError) {
        throw auditError;
      }
      throw error;
    }

    await this.#auditCheckpoint(operationId, input.operation, "success");
    return result;
  }

  requireReady(workspaceId: string): OpenWorkspace {
    return publicWorkspace(this.#requireReadyState(workspaceId));
  }

  async readFile(
    workspaceId: string,
    path: string,
    options: { offset?: number; maxBytes?: number } = {}
  ): Promise<WorkspaceFileReadResult> {
    if (path.length === 0) {
      throw new TypeError("Workspace file path must not be empty");
    }
    const offset = options.offset ?? 0;
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError("offset must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 1024 * 1024) {
      throw new RangeError("maxBytes must be an integer in the range 0..1048576");
    }
    const state = this.#requireReadyState(workspaceId);
    const result = await this.#kernel.request<unknown>("file.read", {
      capabilityId: state.capabilityId,
      path,
      offset,
      maxBytes
    });
    if (
      !isRecord(result) ||
      typeof result.contents !== "string" ||
      !Number.isSafeInteger(result.bytesRead) ||
      (result.bytesRead as number) < 0 ||
      typeof result.eof !== "boolean"
    ) {
      throw new WorkspaceManagerError(
        "RUNTIME_PROTOCOL_INVALID",
        "file.read returned an invalid payload"
      );
    }
    return {
      contents: result.contents,
      bytesRead: result.bytesRead as number,
      eof: result.eof
    };
  }

  async readFileBytes(
    workspaceId: string,
    path: string,
    options: { offset?: number; maxBytes?: number } = {}
  ): Promise<WorkspaceFileReadBytesResult> {
    if (path.length === 0) {
      throw new TypeError("Workspace file path must not be empty");
    }
    const offset = options.offset ?? 0;
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError("offset must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 1024 * 1024) {
      throw new RangeError("maxBytes must be an integer in the range 0..1048576");
    }
    const state = this.#requireReadyState(workspaceId);
    const result = await this.#kernel.request<unknown>("file.read", {
      capabilityId: state.capabilityId,
      path,
      offset,
      maxBytes,
      encoding: "base64"
    });
    if (
      !isRecord(result) ||
      typeof result.contentBase64 !== "string" ||
      !Number.isSafeInteger(result.bytesRead) ||
      (result.bytesRead as number) < 0 ||
      (result.bytesRead as number) > maxBytes ||
      typeof result.eof !== "boolean"
    ) {
      throw new WorkspaceManagerError(
        "RUNTIME_PROTOCOL_INVALID",
        "file.read returned an invalid binary payload"
      );
    }
    const bytes = decodeCanonicalBase64(result.contentBase64);
    if (bytes === undefined || bytes.byteLength !== result.bytesRead) {
      throw new WorkspaceManagerError(
        "RUNTIME_PROTOCOL_INVALID",
        "file.read returned an invalid binary payload"
      );
    }
    return {
      bytes,
      bytesRead: result.bytesRead as number,
      eof: result.eof
    };
  }

  async pathIdentity(
    workspaceId: string,
    path: string,
    options: { includeSha256: boolean }
  ): Promise<WorkspacePathIdentityResult> {
    if (path.length === 0) {
      throw new TypeError("Workspace identity path must not be empty");
    }
    const state = this.#requireReadyState(workspaceId);
    const result = await this.#kernel.request<unknown>("file.identity", {
      capabilityId: state.capabilityId,
      path,
      includeSha256: options.includeSha256
    });
    if (!isValidPathIdentityResult(result, options.includeSha256)) {
      throw new WorkspaceManagerError(
        "RUNTIME_PROTOCOL_INVALID",
        "file.identity returned an invalid payload"
      );
    }
    return result;
  }

  async writeFile(
    workspaceId: string,
    path: string,
    content: string,
    options?: { precondition?: WorkspaceFileWritePrecondition }
  ): Promise<WorkspaceFileWriteResult> {
    if (path.length === 0) {
      throw new TypeError("Workspace file path must not be empty");
    }
    const precondition = options?.precondition;
    if (
      precondition?.kind === "sha256" &&
      !/^[0-9a-f]{64}$/.test(precondition.value)
    ) {
      throw new TypeError("Workspace file write SHA-256 precondition is invalid");
    }
    const state = this.#requireReadyState(workspaceId);
    let result: unknown;
    try {
      result = await this.#kernel.request<unknown>("file.write", {
        capabilityId: state.capabilityId,
        path,
        content,
        ...(precondition === undefined ? {} : { precondition })
      });
    } catch (error) {
      if (error instanceof KernelRpcError && error.message === "FILE_PRECONDITION_FAILED") {
        throw new WorkspaceManagerError(
          "FILE_PRECONDITION_FAILED",
          "Workspace file write precondition failed",
          { cause: error }
        );
      }
      throw error;
    }
    if (
      !isRecord(result) ||
      !Number.isSafeInteger(result.bytesWritten) ||
      (result.bytesWritten as number) < 0 ||
      typeof result.created !== "boolean"
    ) {
      throw new WorkspaceManagerError(
        "RUNTIME_PROTOCOL_INVALID",
        "file.write returned an invalid payload"
      );
    }
    return {
      bytesWritten: result.bytesWritten as number,
      created: result.created
    };
  }

  async editFile(
    workspaceId: string,
    path: string,
    oldText: string,
    newText: string,
    expectedReplacements: number
  ): Promise<WorkspaceFileEditResult> {
    if (path.length === 0 || oldText.length === 0) {
      throw new TypeError("Workspace edit path and oldText must not be empty");
    }
    if (!Number.isSafeInteger(expectedReplacements) || expectedReplacements < 0) {
      throw new RangeError("expectedReplacements must be a non-negative safe integer");
    }
    const state = this.#requireReadyState(workspaceId);
    const result = await this.#kernel.request<unknown>("file.edit", {
      capabilityId: state.capabilityId,
      path,
      oldText,
      newText,
      expectedReplacements
    });
    if (
      !isRecord(result) ||
      !Number.isSafeInteger(result.bytesWritten) ||
      (result.bytesWritten as number) < 0 ||
      !Number.isSafeInteger(result.replacements) ||
      (result.replacements as number) < 0
    ) {
      throw new WorkspaceManagerError(
        "RUNTIME_PROTOCOL_INVALID",
        "file.edit returned an invalid payload"
      );
    }
    return {
      bytesWritten: result.bytesWritten as number,
      replacements: result.replacements as number
    };
  }

  async commitPatchFile(
    input: WorkspacePatchFileCommitInput
  ): Promise<WorkspacePatchFileCommitResult> {
    if (input.path.length === 0) {
      throw new TypeError("Workspace patch path must not be empty");
    }
    const sha256 = /^[a-f0-9]{64}$/;
    const validInput =
      (input.action === "create" && input.expectedSha256 === null && typeof input.content === "string") ||
      (input.action === "update" &&
        typeof input.expectedSha256 === "string" &&
        sha256.test(input.expectedSha256) &&
        typeof input.content === "string") ||
      (input.action === "delete" &&
        typeof input.expectedSha256 === "string" &&
        sha256.test(input.expectedSha256) &&
        input.content === null);
    if (!validInput) {
      throw new TypeError("Workspace patch action, digest, and content are inconsistent");
    }

    const state = this.#requireReadyState(input.workspaceId);
    const result = await this.#kernel.request<unknown>("file.commit_patch_file", {
      capabilityId: state.capabilityId,
      path: input.path,
      action: input.action,
      expectedSha256: input.expectedSha256,
      content: input.content
    });
    const resultKeys = isRecord(result) ? Object.keys(result) : [];
    const resultShaValid =
      input.action === "delete"
        ? isRecord(result) && result.sha256 === null
        : isRecord(result) && typeof result.sha256 === "string" && sha256.test(result.sha256);
    if (
      !isRecord(result) ||
      result.schemaVersion !== 1 ||
      result.action !== input.action ||
      !Number.isSafeInteger(result.bytesWritten) ||
      (result.bytesWritten as number) < 0 ||
      !resultShaValid ||
      resultKeys.length !== 4 ||
      resultKeys.some((key) => !["schemaVersion", "action", "bytesWritten", "sha256"].includes(key))
    ) {
      throw new WorkspaceManagerError(
        "RUNTIME_PROTOCOL_INVALID",
        "file.commit_patch_file returned an invalid payload"
      );
    }
    return {
      schemaVersion: 1,
      action: input.action,
      bytesWritten: result.bytesWritten as number,
      sha256: result.sha256 as string | null
    };
  }

  async gitLog(input: WorkspaceGitLogInput): Promise<WorkspaceGitLogResult> {
    return (await this.#gitHistory("git.log", input.workspaceId, {
      revision: input.revision,
      ...(input.path === undefined ? {} : { path: input.path }),
      limit: input.limit
    })) as unknown as WorkspaceGitLogResult;
  }

  async gitShow(input: WorkspaceGitShowInput): Promise<WorkspaceGitShowResult> {
    return (await this.#gitHistory("git.show", input.workspaceId, {
      revision: input.revision,
      ...(input.path === undefined ? {} : { path: input.path }),
      includePatch: input.includePatch,
      maxPatchBytes: input.maxPatchBytes
    })) as unknown as WorkspaceGitShowResult;
  }

  async gitRange(input: WorkspaceGitRangeInput): Promise<WorkspaceGitRangeResult> {
    return (await this.#gitHistory("git.range", input.workspaceId, {
      baseRevision: input.baseRevision,
      headRevision: input.headRevision,
      mode: input.mode,
      limit: input.limit
    })) as unknown as WorkspaceGitRangeResult;
  }

  async gitDiffHistory(input: WorkspaceGitDiffHistoryInput): Promise<WorkspaceGitHistoryDiffResult> {
    return (await this.#gitHistory("git.diff_history", input.workspaceId, {
      baseRevision: input.baseRevision,
      headRevision: input.headRevision,
      ...(input.path === undefined ? {} : { path: input.path }),
      maxPatchBytes: input.maxPatchBytes
    })) as unknown as WorkspaceGitHistoryDiffResult;
  }

  async #gitHistory(
    method: "git.log" | "git.show" | "git.range" | "git.diff_history",
    workspaceId: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const state = this.#requireReadyState(workspaceId);
    try {
      const result = await this.#kernel.request<unknown>(method, {
        capabilityId: state.capabilityId,
        ...params
      });
      return validateGitHistoryResult(result, method);
    } catch (error) {
      if (error instanceof KernelRpcError && GIT_HISTORY_ERROR_CODES.has(error.message)) {
        throw new WorkspaceManagerError(error.message, `${method} failed`);
      }
      throw error;
    }
  }

  async auditRemoteCi(input: WorkspaceRemoteCiAuditInput): Promise<void> {
    const state = this.#requireReadyState(input.workspaceId);
    const params: Record<string, unknown> = {
      capabilityId: state.capabilityId,
      operationId: input.operationId,
      ciCapability: input.capability,
      phase: input.phase,
      provider: input.provider,
      repository: input.repository,
      ...(input.credentialSource === undefined ? {} : { credentialSource: input.credentialSource }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(input.truncated === undefined ? {} : { truncated: input.truncated }),
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs })
    };
    try {
      const result = await this.#kernel.request<unknown>("ci.audit", params);
      if (!isRecord(result) || result.ok !== true || Object.keys(result).length !== 1) {
        throw new WorkspaceManagerError(
          "RUNTIME_PROTOCOL_INVALID",
          "ci.audit returned an invalid acknowledgement"
        );
      }
    } catch (error) {
      if (error instanceof WorkspaceManagerError) throw error;
      if (error instanceof KernelRpcError && error.message === "AUDIT_UNAVAILABLE") {
        throw new WorkspaceManagerError(
          "CI_AUDIT_UNAVAILABLE",
          "Remote-CI durable audit is unavailable",
          { cause: error }
        );
      }
      throw error;
    }
  }

  async inspectGitRepositoryIdentity(workspaceId: string): Promise<WorkspaceGitRepositoryIdentity> {
    const state = this.#requireReadyState(workspaceId);
    const result = await this.#kernel.request<unknown>("git.repository_identity", {
      capabilityId: state.capabilityId
    });
    return validateGitRepositoryIdentity(result);
  }

  async gitStatus(workspaceId: string): Promise<WorkspaceGitInspectionResult> {
    return this.#gitInspection(workspaceId, "git.status");
  }

  async gitCheckpoint(workspaceId: string): Promise<WorkspaceGitCheckpointResult> {
    const state = this.#requireReadyState(workspaceId);
    try {
      const result = await this.#kernel.request<unknown>("git.checkpoint", {
        capabilityId: state.capabilityId
      });
      return validateGitCheckpoint(result);
    } catch (error) {
      if (error instanceof KernelRpcError && error.message === "GIT_STATUS_INVALID") {
        throw new WorkspaceManagerError(
          "GIT_STATUS_INVALID",
          "git.checkpoint returned invalid status"
        );
      }
      throw error;
    }
  }

  async gitCheckpointPatch(workspaceId: string): Promise<WorkspaceGitInspectionResult> {
    return this.#gitInspection(workspaceId, "git.checkpoint_patch");
  }

  async gitDiff(workspaceId: string): Promise<WorkspaceGitInspectionResult> {
    return this.#gitInspection(workspaceId, "git.diff");
  }

  async gitStage(workspaceId: string, paths: string[]): Promise<WorkspaceGitMutationResult> {
    return this.#gitLocalMutation(workspaceId, "stage", { paths });
  }

  async gitCommit(workspaceId: string, message: string): Promise<WorkspaceGitMutationResult> {
    return this.#gitLocalMutation(workspaceId, "commit", { message });
  }

  async gitBranchCreate(workspaceId: string, name: string): Promise<WorkspaceGitMutationResult> {
    return this.#gitLocalMutation(workspaceId, "branch_create", { name });
  }

  async gitBranchSwitch(workspaceId: string, name: string): Promise<WorkspaceGitMutationResult> {
    return this.#gitLocalMutation(workspaceId, "branch_switch", { name });
  }

  async gitBranchDelete(workspaceId: string, name: string): Promise<WorkspaceGitMutationResult> {
    return this.#gitLocalMutation(workspaceId, "branch_delete", { name });
  }

  async gitWorktreeCreate(
    workspaceId: string,
    name: string,
    branch: string
  ): Promise<WorkspaceGitWorktreeCreateResult> {
    return this.#gitWorktreeMutation(workspaceId, "create", { name, branch }) as Promise<WorkspaceGitWorktreeCreateResult>;
  }

  async gitWorktreeRemove(workspaceId: string, name: string): Promise<WorkspaceGitWorktreeRemoveResult> {
    return this.#gitWorktreeMutation(workspaceId, "remove", { name }) as Promise<WorkspaceGitWorktreeRemoveResult>;
  }

  async gitFetch(
    workspaceId: string,
    remote: string,
    ref: string,
    credential?: WorkspaceGitRemoteCredential | null
  ): Promise<WorkspaceGitRemoteMutationResult> {
    return this.#gitRemoteMutation(workspaceId, "fetch", remote, ref, credential);
  }

  async gitPull(
    workspaceId: string,
    remote: string,
    ref: string,
    credential?: WorkspaceGitRemoteCredential | null
  ): Promise<WorkspaceGitRemoteMutationResult> {
    return this.#gitRemoteMutation(workspaceId, "pull", remote, ref, credential);
  }

  async gitPush(
    workspaceId: string,
    remote: string,
    ref: string,
    credential?: WorkspaceGitRemoteCredential | null
  ): Promise<WorkspaceGitRemoteMutationResult> {
    return this.#gitRemoteMutation(workspaceId, "push", remote, ref, credential);
  }

  async runProcess(input: WorkspaceProcessRunInput): Promise<WorkspaceProcessOperationResult> {
    if (input.logicalExecutable.length === 0) {
      throw new TypeError("Process logical executable must not be empty");
    }
    const state = this.#requireReadyState(input.workspaceId);
    const result = await this.#kernel.request<unknown>("process.run", {
      capabilityId: state.capabilityId,
      logicalExecutable: input.logicalExecutable,
      argv: input.argv,
      cwd: input.cwd ?? ".",
      env: input.env ?? {},
      background: input.background ?? false
    });
    return validateProcessOperation(result, "process.run");
  }

  async inspectExecutable(
    workspaceId: string,
    logicalExecutable: string
  ): Promise<WorkspaceExecutableAvailabilityResult> {
    if (logicalExecutable.length === 0) {
      throw new TypeError("Process logical executable must not be empty");
    }
    const state = this.#requireReadyState(workspaceId);
    const result = await this.#kernel.request<unknown>("process.inspect_executable", {
      capabilityId: state.capabilityId,
      logicalExecutable
    });
    if (
      !isRecord(result) ||
      result.schemaVersion !== 1 ||
      typeof result.executableAvailable !== "boolean" ||
      typeof result.sandboxAvailable !== "boolean" ||
      Object.keys(result).some(
        (key) => !["schemaVersion", "executableAvailable", "sandboxAvailable"].includes(key)
      )
    ) {
      throw new WorkspaceManagerError(
        "RUNTIME_PROTOCOL_INVALID",
        "process.inspect_executable returned an invalid payload"
      );
    }
    return {
      schemaVersion: 1,
      executableAvailable: result.executableAvailable,
      sandboxAvailable: result.sandboxAvailable
    };
  }

  async runVerificationProcess(
    input: WorkspaceVerificationRunInput
  ): Promise<WorkspaceProcessOperationResult> {
    if (input.recipeId.length === 0 || input.logicalExecutable.length === 0 || input.cwd.length === 0) {
      throw new TypeError("Verification run fields must not be empty");
    }
    const state = this.#requireReadyState(input.workspaceId);
    const result = await this.#kernel.request<unknown>("verify.run", {
      capabilityId: state.capabilityId,
      recipeId: input.recipeId,
      logicalExecutable: input.logicalExecutable,
      argv: input.argv,
      cwd: input.cwd,
      background: input.background ?? false
    });
    return validateProcessOperation(result, "verify.run");
  }

  async processStatus(
    workspaceId: string,
    operationId: string
  ): Promise<WorkspaceProcessOperationResult> {
    return this.#processOperation(workspaceId, operationId, "process.status");
  }

  async processCancel(
    workspaceId: string,
    operationId: string
  ): Promise<WorkspaceProcessOperationResult> {
    return this.#processOperation(workspaceId, operationId, "process.cancel");
  }

  async tree(workspaceId: string, path = "."): Promise<WorkspaceTreeEntry[]> {
    return (await this.treeBounded(workspaceId, path, 2_000)).entries.map(({ path: entryPath, kind }) => ({
      path: entryPath,
      kind
    }));
  }

  async treeBounded(
    workspaceId: string,
    path = ".",
    maxEntries = 2_000,
    scope: WorkspaceTraversalScope = "literal"
  ): Promise<WorkspaceTreeResult> {
    if (path.length === 0) {
      throw new TypeError("Workspace tree path must not be empty");
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || maxEntries > 10_000) {
      throw new TypeError("Workspace tree maxEntries must be between 1 and 10000");
    }
    if (scope !== "literal" && scope !== "semantic") {
      throw new TypeError("Workspace tree scope must be literal or semantic");
    }
    const state = this.#requireReadyState(workspaceId);
    const result = await this.#kernel.request<unknown>("file.tree", {
      capabilityId: state.capabilityId,
      path,
      maxEntries,
      scope
    });
    if (
      !isRecord(result) ||
      !Array.isArray(result.entries) ||
      typeof result.truncated !== "boolean"
    ) {
      throw new WorkspaceManagerError(
        "RUNTIME_PROTOCOL_INVALID",
        "file.tree returned an invalid payload"
      );
    }
    return {
      entries: result.entries.map(validateTreeEntry),
      truncated: result.truncated
    };
  }

  async search(workspaceId: string, query: string, path = "."): Promise<WorkspaceSearchMatch[]> {
    return (await this.searchBounded(workspaceId, query, path, 200)).matches;
  }

  async searchBounded(
    workspaceId: string,
    query: string,
    path = ".",
    maxMatches = 200,
    scope: WorkspaceTraversalScope = "literal"
  ): Promise<WorkspaceSearchResult> {
    if (query.length === 0) {
      throw new TypeError("Workspace search query must not be empty");
    }
    if (path.length === 0) {
      throw new TypeError("Workspace search path must not be empty");
    }
    if (!Number.isSafeInteger(maxMatches) || maxMatches <= 0 || maxMatches > 500) {
      throw new TypeError("Workspace search maxMatches must be between 1 and 500");
    }
    if (scope !== "literal" && scope !== "semantic") {
      throw new TypeError("Workspace search scope must be literal or semantic");
    }
    const state = this.#requireReadyState(workspaceId);
    const result = await this.#kernel.request<unknown>("file.search", {
      capabilityId: state.capabilityId,
      path,
      query,
      maxMatches,
      scope
    });
    if (
      !isRecord(result) ||
      !Array.isArray(result.matches) ||
      typeof result.truncated !== "boolean" ||
      !Array.isArray(result.truncationReasons) ||
      !result.truncationReasons.every(isSearchTruncationReason) ||
      result.truncated !== (result.truncationReasons.length > 0)
    ) {
      throw new WorkspaceManagerError(
        "RUNTIME_PROTOCOL_INVALID",
        "file.search returned an invalid payload"
      );
    }
    return {
      matches: result.matches.map(validateSearchMatch),
      truncated: result.truncated,
      truncationReasons: [...result.truncationReasons]
    };
  }

  async #processOperation(
    workspaceId: string,
    operationId: string,
    method: "process.status" | "process.cancel"
  ): Promise<WorkspaceProcessOperationResult> {
    if (!operationId.startsWith("op_")) {
      throw new TypeError("Process operation ID must start with op_");
    }
    const state = this.#requireReadyState(workspaceId);
    const result = await this.#kernel.request<unknown>(method, {
      capabilityId: state.capabilityId,
      operationId
    });
    return validateProcessOperation(result, method);
  }

  async #gitInspection(
    workspaceId: string,
    method: "git.status" | "git.checkpoint_patch" | "git.diff"
  ): Promise<WorkspaceGitInspectionResult> {
    const state = this.#requireReadyState(workspaceId);
    const result = await this.#kernel.request<unknown>(method, {
      capabilityId: state.capabilityId
    });
    if (
      !isRecord(result) ||
      result.schemaVersion !== 1 ||
      !Number.isSafeInteger(result.exitCode) ||
      typeof result.stdoutPreview !== "string" ||
      typeof result.stderrPreview !== "string" ||
      typeof result.stdoutTruncated !== "boolean" ||
      typeof result.stderrTruncated !== "boolean" ||
      typeof result.sourceTruncated !== "boolean" ||
      !Number.isSafeInteger(result.bytesSpooled) ||
      (result.bytesSpooled as number) < 0 ||
      !isRecord(result.artifact) ||
      "artifactId" in result ||
      "processGroup" in result ||
      "pid" in result
    ) {
      throw new WorkspaceManagerError(
        "RUNTIME_PROTOCOL_INVALID",
        `${method} returned an invalid payload`
      );
    }
    return {
      schemaVersion: 1,
      exitCode: result.exitCode as number,
      stdoutPreview: result.stdoutPreview,
      stderrPreview: result.stderrPreview,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      sourceTruncated: result.sourceTruncated,
      bytesSpooled: result.bytesSpooled as number,
      artifact: validateArtifactMetadata(result.artifact, method)
    };
  }

  async #gitLocalMutation(
    workspaceId: string,
    operation: WorkspaceGitMutationOperation,
    params: Record<string, unknown>
  ): Promise<WorkspaceGitMutationResult> {
    const state = this.#requireReadyState(workspaceId);
    let result: unknown;
    try {
      result = await this.#kernel.request<unknown>("git.local_mutation", {
        capabilityId: state.capabilityId,
        operation,
        ...params
      });
    } catch (error) {
      if (error instanceof KernelRpcError && GIT_MUTATION_ERROR_CODES.has(error.message)) {
        throw new WorkspaceManagerError(error.message, "git.local_mutation failed");
      }
      throw error;
    }
    if (
      !isRecord(result) ||
      result.schemaVersion !== 1 ||
      result.operation !== operation ||
      !Number.isSafeInteger(result.exitCode) ||
      typeof result.stdoutPreview !== "string" ||
      typeof result.stderrPreview !== "string" ||
      typeof result.stdoutTruncated !== "boolean" ||
      typeof result.stderrTruncated !== "boolean" ||
      typeof result.sourceTruncated !== "boolean" ||
      !Number.isSafeInteger(result.bytesSpooled) ||
      (result.bytesSpooled as number) < 0 ||
      !isRecord(result.artifact) ||
      "artifactId" in result ||
      "processGroup" in result ||
      "pid" in result
    ) {
      throw new WorkspaceManagerError(
        "RUNTIME_PROTOCOL_INVALID",
        "git.local_mutation returned an invalid payload"
      );
    }
    return {
      schemaVersion: 1,
      operation,
      exitCode: result.exitCode as number,
      stdoutPreview: result.stdoutPreview,
      stderrPreview: result.stderrPreview,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      sourceTruncated: result.sourceTruncated,
      bytesSpooled: result.bytesSpooled as number,
      artifact: validateArtifactMetadata(result.artifact, "git.local_mutation")
    };
  }

  async #gitWorktreeMutation(
    workspaceId: string,
    operation: "create" | "remove",
    params: Record<string, unknown>
  ): Promise<WorkspaceGitWorktreeMutationResult> {
    const state = this.#requireReadyState(workspaceId);
    let result: unknown;
    try {
      result = await this.#kernel.request<unknown>("git.worktree_mutation", {
        capabilityId: state.capabilityId,
        operation,
        ...params
      });
    } catch (error) {
      if (error instanceof KernelRpcError && GIT_WORKTREE_ERROR_CODES.has(error.message)) {
        throw new WorkspaceManagerError(error.message, "git.worktree_mutation failed");
      }
      throw error;
    }
    if (
      !isRecord(result) ||
      result.schemaVersion !== 1 ||
      result.operation !== operation ||
      typeof result.name !== "string" ||
      typeof result.relativePath !== "string" ||
      result.relativePath !== `.worktrees/${result.name}`
    ) {
      throw new WorkspaceManagerError(
        "RUNTIME_PROTOCOL_INVALID",
        "git.worktree_mutation returned an invalid payload"
      );
    }
    const allowedKeys = operation === "create"
      ? new Set(["schemaVersion", "operation", "name", "relativePath", "branch", "headOid"])
      : new Set(["schemaVersion", "operation", "name", "relativePath", "removed"]);
    if (Object.keys(result).some((key) => !allowedKeys.has(key))) {
      throw new WorkspaceManagerError(
        "RUNTIME_PROTOCOL_INVALID",
        "git.worktree_mutation returned an invalid payload"
      );
    }
    if (operation === "create") {
      if (
        typeof result.branch !== "string" ||
        typeof result.headOid !== "string" ||
        !/^[0-9a-f]{40}$/.test(result.headOid)
      ) {
        throw new WorkspaceManagerError(
          "RUNTIME_PROTOCOL_INVALID",
          "git.worktree_mutation returned an invalid payload"
        );
      }
      return {
        schemaVersion: 1,
        operation: "create",
        name: result.name,
        relativePath: result.relativePath as `.worktrees/${string}`,
        branch: result.branch,
        headOid: result.headOid
      };
    }
    if (result.removed !== true) {
      throw new WorkspaceManagerError(
        "RUNTIME_PROTOCOL_INVALID",
        "git.worktree_mutation returned an invalid payload"
      );
    }
    return {
      schemaVersion: 1,
      operation: "remove",
      name: result.name,
      relativePath: result.relativePath as `.worktrees/${string}`,
      removed: true
    };
  }

  async #gitRemoteMutation(
    workspaceId: string,
    operation: WorkspaceGitRemoteMutationOperation,
    remote: string,
    ref: string,
    credential?: WorkspaceGitRemoteCredential | null
  ): Promise<WorkspaceGitRemoteMutationResult> {
    const state = this.#requireReadyState(workspaceId);
    let result: unknown;
    try {
      result = await this.#kernel.request<unknown>("git.remote_mutation", {
        capabilityId: state.capabilityId,
        operation,
        remote,
        ref,
        ...(credential === undefined || credential === null ? {} : { credential })
      });
    } catch (error) {
      if (error instanceof KernelRpcError && GIT_REMOTE_MUTATION_ERROR_CODES.has(error.message)) {
        throw new WorkspaceManagerError(error.message, "git.remote_mutation failed");
      }
      throw error;
    }
    if (
      !isRecord(result) ||
      result.schemaVersion !== 1 ||
      result.operation !== operation ||
      !Number.isSafeInteger(result.exitCode) ||
      typeof result.stdoutPreview !== "string" ||
      typeof result.stderrPreview !== "string" ||
      typeof result.stdoutTruncated !== "boolean" ||
      typeof result.stderrTruncated !== "boolean" ||
      typeof result.sourceTruncated !== "boolean" ||
      !Number.isSafeInteger(result.bytesSpooled) ||
      (result.bytesSpooled as number) < 0 ||
      !isRecord(result.artifact) ||
      "artifactId" in result ||
      "processGroup" in result ||
      "pid" in result
    ) {
      throw new WorkspaceManagerError(
        "RUNTIME_PROTOCOL_INVALID",
        "git.remote_mutation returned an invalid payload"
      );
    }
    return {
      schemaVersion: 1,
      operation,
      exitCode: result.exitCode as number,
      stdoutPreview: result.stdoutPreview,
      stderrPreview: result.stderrPreview,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      sourceTruncated: result.sourceTruncated,
      bytesSpooled: result.bytesSpooled as number,
      artifact: validateArtifactMetadata(result.artifact, "git.remote_mutation")
    };
  }

  #requireReadyState(workspaceId: string): WorkspaceState {
    const state = this.#workspaces.get(workspaceId);
    if (state === undefined) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    if (state.phase !== "READY" || state.capabilityId === undefined) {
      throw new WorkspaceNotReadyError(workspaceId);
    }
    return state;
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    const state = this.#workspaces.get(workspaceId);
    if (state === undefined) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    if (
      state.phase === "OPENING" ||
      state.capabilityId === undefined ||
      state.closeInFlight
    ) {
      throw new WorkspaceNotReadyError(workspaceId);
    }

    state.phase = "CLOSING";
    state.closeInFlight = true;
    const capabilityId = state.capabilityId;
    const deadline = performance.now() + this.#closeTimeoutMs;
    try {
      await beforeDeadline(
        this.#requestOk("workspace.begin_close", { capabilityId }),
        deadline
      );
      await beforeDeadline(
        this.#requestOk("workspace.cancel_executions", { capabilityId }),
        deadline
      );
      await beforeDeadline(
        this.#requestOk("workspace.unregister", { capabilityId }),
        deadline
      );
      this.#workspaces.delete(workspaceId);
    } catch (error) {
      throw new WorkspaceCloseIncompleteError(workspaceId, error);
    } finally {
      if (this.#workspaces.get(workspaceId) === state) {
        state.closeInFlight = false;
      }
    }
  }
}

function parseProjectProfile(contents: string): ProfilePolicy {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new ProjectProfileInvalidError(".kodegpt/profile.json is invalid JSON", error);
  }
  try {
    return profilePolicySchema.parse(value);
  } catch (error) {
    throw new ProjectProfileInvalidError(
      ".kodegpt/profile.json does not match the profile schema",
      error
    );
  }
}

function publicWorkspace(state: WorkspaceState): OpenWorkspace {
  if (
    state.phase !== "READY" ||
    state.canonicalRoot === undefined ||
    state.effectivePolicy === undefined
  ) {
    throw new WorkspaceNotReadyError(state.id);
  }
  return {
    id: state.id,
    canonicalRoot: state.canonicalRoot,
    effectivePolicy: {
      ...state.effectivePolicy,
      allowedExecutableNames: [...state.effectivePolicy.allowedExecutableNames],
      envAllowlist: [...state.effectivePolicy.envAllowlist]
    }
  };
}

function requireReadyTrustId(state: WorkspaceState): string {
  if (state.phase !== "READY" || state.trustId === undefined) {
    throw new WorkspaceNotReadyError(state.id);
  }
  return state.trustId;
}

function publicTrustedWorkspace(entry: TrustedWorkspaceEntry): TrustedWorkspaceSummary {
  return {
    id: entry.id,
    canonicalRoot: entry.canonicalRoot,
    profileCeiling: entry.profileCeiling,
    trustedAt: entry.trustedAt
  };
}

function validateInspectResult(value: unknown): asserts value is InspectRootResult {
  if (
    !isRecord(value) ||
    typeof value.canonicalRoot !== "string" ||
    !isRecord(value.identity) ||
    !Number.isSafeInteger(value.identity.deviceMajor) ||
    !Number.isSafeInteger(value.identity.deviceMinor) ||
    typeof value.identity.inode !== "string"
  ) {
    throw new WorkspaceManagerError(
      "RUNTIME_PROTOCOL_INVALID",
      "system.inspect_root returned an invalid payload"
    );
  }
}

function validateTreeEntry(value: unknown): WorkspaceTreeMetadataEntry {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !isTreeEntryKind(value.kind) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.sizeBytes as number) < 0
  ) {
    throw new WorkspaceManagerError(
      "RUNTIME_PROTOCOL_INVALID",
      "file.tree returned an invalid entry"
    );
  }
  return { path: value.path, kind: value.kind, sizeBytes: value.sizeBytes as number };
}

function validateGitCheckpoint(value: unknown): WorkspaceGitCheckpointResult {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.headOid !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.headOid) ||
    !Array.isArray(value.records) ||
    typeof value.truncated !== "boolean"
  ) {
    throw new WorkspaceManagerError(
      "RUNTIME_PROTOCOL_INVALID",
      "git.checkpoint returned an invalid payload"
    );
  }
  const records = value.records.map(validateGitCheckpointRecord);
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.path)) {
      throw new WorkspaceManagerError(
        "RUNTIME_PROTOCOL_INVALID",
        "git.checkpoint returned duplicate paths"
      );
    }
    seen.add(record.path);
  }
  return { schemaVersion: 1, headOid: value.headOid, records, truncated: value.truncated };
}

function validateGitCheckpointRecord(value: unknown): WorkspaceGitCheckpointRecord {
  if (
    !isRecord(value) ||
    !isGitCheckpointRecordType(value.recordType) ||
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    !optionalNonemptyString(value.originalPath) ||
    !optionalGitStatus(value.indexStatus) ||
    !optionalGitStatus(value.worktreeStatus) ||
    !optionalGitMode(value.headMode) ||
    !optionalGitMode(value.indexMode) ||
    !optionalGitMode(value.worktreeMode) ||
    !optionalGitOid(value.headOid) ||
    !optionalGitOid(value.indexOid) ||
    !optionalGitOid(value.stage1Oid) ||
    !optionalGitOid(value.stage2Oid) ||
    !optionalGitOid(value.stage3Oid) ||
    (value.currentIdentity !== undefined && !isValidPathIdentityResult(value.currentIdentity, true))
  ) {
    throw new WorkspaceManagerError(
      "RUNTIME_PROTOCOL_INVALID",
      "git.checkpoint returned an invalid record"
    );
  }
  if (value.recordType === "rename" && value.originalPath === undefined) {
    throw new WorkspaceManagerError(
      "RUNTIME_PROTOCOL_INVALID",
      "git.checkpoint rename record is missing originalPath"
    );
  }
  if (value.recordType !== "rename" && value.originalPath !== undefined) {
    throw new WorkspaceManagerError(
      "RUNTIME_PROTOCOL_INVALID",
      "git.checkpoint non-rename record contains originalPath"
    );
  }
  const needsCurrentIdentity =
    value.recordType === "untracked" ||
    (typeof value.worktreeStatus === "string" && value.worktreeStatus !== "D");
  if (needsCurrentIdentity && value.currentIdentity === undefined) {
    throw new WorkspaceManagerError(
      "RUNTIME_PROTOCOL_INVALID",
      "git.checkpoint record is missing currentIdentity"
    );
  }
  return value as unknown as WorkspaceGitCheckpointRecord;
}

function isGitCheckpointRecordType(
  value: unknown
): value is WorkspaceGitCheckpointRecord["recordType"] {
  return value === "ordinary" || value === "rename" || value === "unmerged" || value === "untracked";
}

function optionalNonemptyString(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

function optionalGitStatus(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && /^[MADRCUT?]$/.test(value))
  );
}

function optionalGitMode(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && /^[0-7]{6}$/.test(value));
}

function optionalGitOid(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value));
}

function isTreeEntryKind(value: unknown): value is WorkspaceTreeEntryKind {
  return value === "file" || value === "directory" || value === "symlink" || value === "other";
}

function isValidPathIdentityResult(
  value: unknown,
  includeSha256: boolean
): value is WorkspacePathIdentityResult {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.exists !== "boolean" ||
    typeof value.hashTruncated !== "boolean"
  ) {
    return false;
  }
  if (!value.exists) {
    return (
      value.kind === undefined &&
      value.sizeBytes === undefined &&
      value.sha256 === undefined &&
      value.hashTruncated === false
    );
  }
  if (
    !isTreeEntryKind(value.kind) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.sizeBytes as number) < 0 ||
    (value.sha256 !== undefined &&
      (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256))) ||
    (value.hashTruncated && value.sha256 !== undefined)
  ) {
    return false;
  }
  if (!includeSha256) {
    return value.sha256 === undefined && value.hashTruncated === false;
  }
  if (value.kind === "file" || value.kind === "symlink") {
    return value.hashTruncated || value.sha256 !== undefined;
  }
  return value.sha256 === undefined && value.hashTruncated === false;
}

function isSearchTruncationReason(value: unknown): value is WorkspaceSearchTruncationReason {
  return (
    value === "TREE_LIMIT" ||
    value === "FILE_SIZE_LIMIT" ||
    value === "SCAN_BYTE_LIMIT" ||
    value === "MATCH_LIMIT" ||
    value === "SNIPPET_BYTE_LIMIT"
  );
}

function validateSearchMatch(value: unknown): WorkspaceSearchMatch {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !Number.isSafeInteger(value.line) ||
    (value.line as number) <= 0 ||
    typeof value.lineText !== "string"
  ) {
    throw new WorkspaceManagerError(
      "RUNTIME_PROTOCOL_INVALID",
      "file.search returned an invalid match"
    );
  }
  return {
    path: value.path,
    line: value.line as number,
    lineText: value.lineText
  };
}

function validateGitRepositoryIdentity(value: unknown): WorkspaceGitRepositoryIdentity {
  const invalid = (): never => {
    throw new WorkspaceManagerError(
      "RUNTIME_PROTOCOL_INVALID",
      "git.repository_identity returned an invalid payload"
    );
  };
  if (!isRecord(value)) invalid();
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) invalid();
  if (Object.keys(record).sort().join(",") !== "branch,headOid,remotes,schemaVersion") invalid();
  if (typeof record.headOid !== "string" || !isGitOid(record.headOid)) invalid();
  if (record.branch !== null && (typeof record.branch !== "string" || !isSafePrivateGitRef(record.branch))) invalid();
  if (!Array.isArray(record.remotes) || record.remotes.length > 32) invalid();

  const remoteValues = record.remotes as unknown[];
  const names = new Set<string>();
  const remotes: WorkspaceGitRepositoryIdentity["remotes"] = remoteValues.map((candidate) => {
    if (!isRecord(candidate)) invalid();
    const remote = candidate as Record<string, unknown>;
    if (Object.keys(remote).sort().join(",") !== "fetchUrl,name") invalid();
    if (typeof remote.name !== "string" || !isSafePrivateRemoteName(remote.name) || names.has(remote.name)) invalid();
    if (typeof remote.fetchUrl !== "string" || !isSafePrivateRemoteUrl(remote.fetchUrl)) invalid();
    const name = remote.name as string;
    const fetchUrl = remote.fetchUrl as string;
    names.add(name);
    return { name, fetchUrl };
  });
  const sortedNames = remotes.map((remote) => remote.name).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  if (remotes.some((remote, index) => remote.name !== sortedNames[index])) invalid();

  return {
    headOid: record.headOid as string,
    branch: record.branch as string | null,
    remotes
  };
}

function isGitOid(value: string): boolean {
  return (value.length === 40 || value.length === 64) && [...value].every((char) => "0123456789abcdef".includes(char));
}

function hasAsciiControl(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function isSafePrivateRemoteName(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !hasAsciiControl(value);
}

function isSafePrivateRemoteUrl(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= 8192 && !hasAsciiControl(value);
}

function isSafePrivateGitRef(value: string): boolean {
  if (value.length === 0 || value.length > 128 || value.includes("..") || value.includes("@{")) return false;
  return value.split("/").every((part) => {
    if (part.length === 0 || part.endsWith(".lock") || part.endsWith(".")) return false;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) return false;
    return true;
  });
}

function validateProcessOperation(
  value: unknown,
  method: "process.run" | "verify.run" | "process.status" | "process.cancel"
): WorkspaceProcessOperationResult {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.operationId !== "string" ||
    !value.operationId.startsWith("op_") ||
    !isProcessOperationState(value.state) ||
    (value.exitCode !== undefined && !Number.isSafeInteger(value.exitCode)) ||
    typeof value.stdoutPreview !== "string" ||
    typeof value.stderrPreview !== "string" ||
    typeof value.stdoutTruncated !== "boolean" ||
    typeof value.stderrTruncated !== "boolean" ||
    typeof value.sourceTruncated !== "boolean" ||
    !Number.isSafeInteger(value.bytesSpooled) ||
    (value.bytesSpooled as number) < 0 ||
    "executionId" in value ||
    "processGroup" in value ||
    "pid" in value ||
    !isRecord(value.artifact) ||
    "artifactId" in value
  ) {
    throw new WorkspaceManagerError(
      "RUNTIME_PROTOCOL_INVALID",
      `${method} returned an invalid payload`
    );
  }
  return {
    schemaVersion: 1,
    operationId: value.operationId,
    state: value.state,
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode as number }),
    stdoutPreview: value.stdoutPreview,
    stderrPreview: value.stderrPreview,
    stdoutTruncated: value.stdoutTruncated,
    stderrTruncated: value.stderrTruncated,
    sourceTruncated: value.sourceTruncated,
    bytesSpooled: value.bytesSpooled as number,
    artifact: validateArtifactMetadata(value.artifact, method)
  };
}

function validateArtifactMetadata(value: unknown, method: string): ArtifactMetadata {
  try {
    return toPublicArtifactMetadata(value);
  } catch (error) {
    throw new WorkspaceManagerError(
      "RUNTIME_PROTOCOL_INVALID",
      `${method} returned invalid artifact metadata`,
      { cause: error }
    );
  }
}

function isProcessOperationState(value: unknown): value is ProcessOperationState {
  return value === "running" || value === "completed" || value === "failed" || value === "cancelled";
}

function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    return Promise.reject(new Error("workspace close deadline exceeded"));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("workspace close deadline exceeded")), remaining);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

const GIT_MUTATION_ERROR_CODES = new Set([
  "GIT_POLICY_DENIED",
  "GIT_MUTATION_INPUT_INVALID",
  "GIT_MUTATION_UNAVAILABLE",
  "GIT_MUTATION_FAILED"
]);

const GIT_WORKTREE_ERROR_CODES = new Set([
  "WORKSPACE_NOT_READY",
  "GIT_POLICY_DENIED",
  "GIT_WORKTREE_INPUT_INVALID",
  "GIT_WORKTREE_TARGET_EXISTS",
  "GIT_WORKTREE_BRANCH_MISSING",
  "GIT_WORKTREE_BRANCH_IN_USE",
  "GIT_WORKTREE_METADATA_INVALID",
  "GIT_WORKTREE_DIRTY",
  "GIT_WORKTREE_LOCKED",
  "GIT_WORKTREE_UNAVAILABLE",
  "GIT_WORKTREE_FAILED",
  "GIT_WORKTREE_INCONSISTENT"
]);

const GIT_REMOTE_MUTATION_ERROR_CODES = new Set([
  "GIT_REMOTE_POLICY_DENIED",
  "GIT_REMOTE_INPUT_INVALID",
  "GIT_REMOTE_UNAVAILABLE",
  "GIT_REMOTE_FAILED"
]);

const GIT_HISTORY_ERROR_CODES = new Set([
  "NOT_A_GIT_REPOSITORY",
  "REVISION_INVALID",
  "REVISION_NOT_FOUND",
  "OBJECT_TYPE_UNSUPPORTED",
  "PATH_INVALID",
  "OUTPUT_LIMIT_EXCEEDED",
  "PROCESS_TIMEOUT",
  "GIT_UNAVAILABLE",
  "GIT_READ_FAILED"
]);

function validateGitHistoryResult(value: unknown, method: string): Record<string, unknown> {
  const reject = (): never => {
    throw new WorkspaceManagerError(
      "RUNTIME_PROTOCOL_INVALID",
      `${method} returned an invalid payload`
    );
  };
  if (!isRecord(value) || value.schemaVersion !== 1) reject();
  const record = value as Record<string, unknown>;
  const forbidden = ["capabilityId", "artifactId", "pid", "processGroup"];
  const inspect = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(inspect);
      return;
    }
    if (!isRecord(candidate)) return;
    if (Object.keys(candidate).some((key) => forbidden.includes(key))) reject();
    for (const nested of Object.values(candidate)) inspect(nested);
  };
  inspect(record);
  const oid = (candidate: unknown) =>
    typeof candidate === "string" && (/^[0-9a-f]{40}$/.test(candidate) || /^[0-9a-f]{64}$/.test(candidate));
  const exactKeys = (candidate: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(candidate).length === keys.length && Object.keys(candidate).every((key) => keys.includes(key));
  const validCommit = (candidate: unknown, allowSide: boolean): boolean => {
    if (!isRecord(candidate)) return false;
    const keys = ["oid", "shortOid", "parents", "authorName", "authorTime", "committerTime", "subject", "encodingLossy", ...(allowSide && candidate.side !== undefined ? ["side"] : [])];
    return exactKeys(candidate, keys) &&
      oid(candidate.oid) &&
      typeof candidate.shortOid === "string" &&
      candidate.shortOid === (candidate.oid as string).slice(0, 12) &&
      Array.isArray(candidate.parents) && candidate.parents.every(oid) &&
      typeof candidate.authorName === "string" && Buffer.byteLength(candidate.authorName, "utf8") <= 256 &&
      Number.isSafeInteger(candidate.authorTime) && Number.isSafeInteger(candidate.committerTime) &&
      typeof candidate.subject === "string" && Buffer.byteLength(candidate.subject, "utf8") <= 512 &&
      typeof candidate.encodingLossy === "boolean" &&
      (!allowSide || candidate.side === undefined || candidate.side === "base" || candidate.side === "head");
  };
  for (const key of ["resolvedOid", "baseOid", "headOid", "mergeBaseOid"]) {
    const candidate = record[key];
    if (candidate !== undefined && candidate !== null && !oid(candidate)) reject();
  }
  if (
    typeof record.truncated !== "boolean" ||
    !Array.isArray(record.truncationReasons) ||
    record.truncated !== (record.truncationReasons.length > 0)
  ) reject();
  const validPath = (candidate: unknown): boolean =>
    typeof candidate === "string" &&
    Buffer.byteLength(candidate, "utf8") <= 4096 &&
    !candidate.startsWith("/") &&
    !candidate.startsWith(":") &&
    !/[\u0000-\u001f\u007f]/.test(candidate) &&
    candidate.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
  const validChangedPath = (candidate: unknown): boolean =>
    isRecord(candidate) &&
    exactKeys(candidate, ["path", "status", "insertions", "deletions", "binary"]) &&
    validPath(candidate.path) &&
    (candidate.status === "added" || candidate.status === "modified" || candidate.status === "deleted" || candidate.status === "typeChanged") &&
    (candidate.insertions === null || (Number.isSafeInteger(candidate.insertions) && (candidate.insertions as number) >= 0)) &&
    (candidate.deletions === null || (Number.isSafeInteger(candidate.deletions) && (candidate.deletions as number) >= 0)) &&
    typeof candidate.binary === "boolean";
  const validSummary = (candidate: unknown): boolean =>
    isRecord(candidate) &&
    exactKeys(candidate, ["filesChanged", "insertions", "deletions", "binaryFiles"]) &&
    [candidate.filesChanged, candidate.insertions, candidate.deletions, candidate.binaryFiles].every(
      (number) => Number.isSafeInteger(number) && (number as number) >= 0
    );
  if (method === "git.log") {
    const keys = ["schemaVersion", "resolvedOid", "commits", "returnedCount", "truncated", "truncationReasons"];
    if (!exactKeys(record, keys) || !Array.isArray(record.commits) || record.commits.length > 100 ||
        !record.commits.every((commit) => validCommit(commit, false)) ||
        !Number.isSafeInteger(record.returnedCount) || record.returnedCount !== record.commits.length) reject();
  } else if (method === "git.show") {
    const keys = ["schemaVersion", "commit", "changedPaths", "summary", "patch", "truncated", "truncationReasons"];
    if (!exactKeys(record, keys) || !isRecord(record.commit) ||
        !validCommit(Object.fromEntries(Object.entries(record.commit).filter(([key]) => key !== "body" && key !== "messageTruncated")), false) ||
        typeof record.commit.body !== "string" || typeof record.commit.messageTruncated !== "boolean" ||
        !Array.isArray(record.changedPaths) || record.changedPaths.length > 500 || !record.changedPaths.every(validChangedPath) ||
        !validSummary(record.summary) || (record.patch !== null && typeof record.patch !== "string")) reject();
  } else if (method === "git.range") {
    const keys = ["schemaVersion", "baseOid", "headOid", "isAncestor", "mergeBaseOid", "ahead", "behind", "commits", "returnedCount", "truncated", "truncationReasons"];
    const boundedCount = (candidate: unknown) => isRecord(candidate) && exactKeys(candidate, ["value", "exact"]) && Number.isSafeInteger(candidate.value) && (candidate.value as number) >= 0 && (candidate.value as number) <= 10000 && typeof candidate.exact === "boolean";
    if (!exactKeys(record, keys) || typeof record.isAncestor !== "boolean" || !boundedCount(record.ahead) || !boundedCount(record.behind) ||
        !Array.isArray(record.commits) || record.commits.length > 100 || !record.commits.every((commit) => validCommit(commit, true)) ||
        !Number.isSafeInteger(record.returnedCount) || record.returnedCount !== record.commits.length) reject();
  } else if (method === "git.diff_history") {
    const keys = ["schemaVersion", "baseOid", "headOid", "changedPaths", "summary", "patch", "truncated", "truncationReasons"];
    if (!exactKeys(record, keys) || !Array.isArray(record.changedPaths) || record.changedPaths.length > 500 ||
        !record.changedPaths.every(validChangedPath) || !validSummary(record.summary) || typeof record.patch !== "string") reject();
  }
  return record;
}

function decodeCanonicalBase64(value: string): Uint8Array | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return undefined;
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.toString("base64") !== value) {
    return undefined;
  }
  return Uint8Array.from(buffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
