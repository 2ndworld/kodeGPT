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
  TrustedWorkspaceEntry
} from "@kodegpt/trust";

import { KernelRpcError } from "./kernel-client.js";

export interface KernelTransport {
  request<T>(method: RuntimeMethod, params: Record<string, unknown>): Promise<T>;
}

export interface TrustResolver {
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

export interface WorkspaceFileReadResult {
  contents: string;
  bytesRead: number;
  eof: boolean;
}

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

export interface WorkspaceTreeResult {
  entries: WorkspaceTreeEntry[];
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
  readonly #idFactory: () => string;
  readonly #closeTimeoutMs: number;
  readonly #workspaces = new Map<string, WorkspaceState>();

  constructor(options: {
    kernel: KernelTransport;
    trust: TrustResolver;
    idFactory?: () => string;
    closeTimeoutMs?: number;
  }) {
    this.#kernel = options.kernel;
    this.#trust = options.trust;
    this.#idFactory =
      options.idFactory ?? (() => `ws_${randomUUID().replaceAll("-", "")}`);
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
    content: string
  ): Promise<WorkspaceFileWriteResult> {
    if (path.length === 0) {
      throw new TypeError("Workspace file path must not be empty");
    }
    const state = this.#requireReadyState(workspaceId);
    const result = await this.#kernel.request<unknown>("file.write", {
      capabilityId: state.capabilityId,
      path,
      content
    });
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
    return (await this.treeBounded(workspaceId, path, 2_000)).entries;
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

function validateTreeEntry(value: unknown): WorkspaceTreeEntry {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !isTreeEntryKind(value.kind)
  ) {
    throw new WorkspaceManagerError(
      "RUNTIME_PROTOCOL_INVALID",
      "file.tree returned an invalid entry"
    );
  }
  return { path: value.path, kind: value.kind };
}

function validateGitCheckpoint(value: unknown): WorkspaceGitCheckpointResult {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
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
  return { schemaVersion: 1, records, truncated: value.truncated };
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
  if (method === "git.log") {
    const keys = ["schemaVersion", "resolvedOid", "commits", "returnedCount", "truncated", "truncationReasons"];
    if (!exactKeys(record, keys) || !Array.isArray(record.commits) || record.commits.length > 100 ||
        !record.commits.every((commit) => validCommit(commit, false)) ||
        !Number.isSafeInteger(record.returnedCount) || record.returnedCount !== record.commits.length) reject();
  }
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
