import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

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

  requireReady(workspaceId: string): OpenWorkspace {
    const state = this.#workspaces.get(workspaceId);
    if (state === undefined) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    if (state.phase !== "READY") {
      throw new WorkspaceNotReadyError(workspaceId);
    }
    return publicWorkspace(state);
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
