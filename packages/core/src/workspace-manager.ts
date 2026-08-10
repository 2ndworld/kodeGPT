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

export interface WorkspaceGitInspectionResult {
  schemaVersion: number;
  exitCode: number;
  stdoutPreview: string;
  stderrPreview: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  sourceTruncated: boolean;
  bytesSpooled: number;
  artifact: ArtifactMetadata;
}

export type ProcessOperationState = "running" | "completed" | "failed" | "cancelled";

export interface WorkspaceProcessOperationResult {
  schemaVersion: number;
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

export type WorkspaceTreeEntryKind = "file" | "directory" | "symlink" | "other";

export interface WorkspaceTreeEntry {
  path: string;
  kind: WorkspaceTreeEntryKind;
}

export interface WorkspaceSearchMatch {
  path: string;
  line: number;
  lineText: string;
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

  async gitStatus(workspaceId: string): Promise<WorkspaceGitInspectionResult> {
    return this.#gitInspection(workspaceId, "git.status");
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
    if (path.length === 0) {
      throw new TypeError("Workspace tree path must not be empty");
    }
    const state = this.#requireReadyState(workspaceId);
    const result = await this.#kernel.request<unknown>("file.tree", {
      capabilityId: state.capabilityId,
      path
    });
    if (!isRecord(result) || !Array.isArray(result.entries)) {
      throw new WorkspaceManagerError(
        "RUNTIME_PROTOCOL_INVALID",
        "file.tree returned an invalid payload"
      );
    }
    const entries = result.entries.map(validateTreeEntry);
    return entries;
  }

  async search(workspaceId: string, query: string, path = "."): Promise<WorkspaceSearchMatch[]> {
    if (query.length === 0) {
      throw new TypeError("Workspace search query must not be empty");
    }
    if (path.length === 0) {
      throw new TypeError("Workspace search path must not be empty");
    }
    const state = this.#requireReadyState(workspaceId);
    const result = await this.#kernel.request<unknown>("file.search", {
      capabilityId: state.capabilityId,
      path,
      query
    });
    if (!isRecord(result) || !Array.isArray(result.matches)) {
      throw new WorkspaceManagerError(
        "RUNTIME_PROTOCOL_INVALID",
        "file.search returned an invalid payload"
      );
    }
    return result.matches.map(validateSearchMatch);
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
    method: "git.status" | "git.diff"
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

function isTreeEntryKind(value: unknown): value is WorkspaceTreeEntryKind {
  return value === "file" || value === "directory" || value === "symlink" || value === "other";
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
  method: "process.run" | "process.status" | "process.cancel"
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
