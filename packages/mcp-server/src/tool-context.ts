import type { ArtifactReadResult, ArtifactStore } from "../../artifacts/src/index.js";
import type {
  CodeSearchInput,
  CodeSearchResult,
  ContextBuildInput,
  ContextBuildResult,
  FilePatchInput,
  FilePatchResult,
  GitChangesInput,
  GitChangesResult,
  VerifyListInput,
  VerifyListResult,
  VerifyRunInput,
  VerifyRunResult,
  WorkspaceInspectInput,
  WorkspaceInspectResult
} from "@kodegpt/capabilities";
import type {
  ExecutionManager,
  OpenWorkspace,
  WorkspaceFileReadResult,
  WorkspaceManager,
  WorkspaceSearchMatch,
  WorkspaceTreeEntry
} from "../../core/src/index.js";
import type { ExtensionRegistry, PublicExtensionMetadata } from "../../extensions/src/index.js";
import type {
  SkillCatalogToolAdapter,
  SkillCompatibility,
  SkillInspectResult,
  SkillListResult,
  SkillLoadResult
} from "@kodegpt/skills";
import { SkillError } from "@kodegpt/skills/errors";

export type JsonObject = Record<string, unknown>;
export type MaybePromise<T> = Promise<T> | T;

export type WorkspaceFileWriteResult = Awaited<ReturnType<WorkspaceManager["writeFile"]>>;
export type WorkspaceFileEditResult = Awaited<ReturnType<WorkspaceManager["editFile"]>>;
export type WorkspaceGitInspectionResult = Awaited<ReturnType<WorkspaceManager["gitStatus"]>>;
export type WorkspaceProcessOperationResult = Awaited<ReturnType<ExecutionManager["run"]>>;

export interface WorkspaceCloseResult {
  ok: true;
}

export interface ProfileCurrentResult {
  workspaceId: string;
  effectivePolicy: OpenWorkspace["effectivePolicy"];
}

export interface WorkspaceToolContext {
  list(): MaybePromise<OpenWorkspace[]>;
  open(input: { rootPath: string }): MaybePromise<OpenWorkspace>;
  close(input: { workspaceId: string }): MaybePromise<WorkspaceCloseResult>;
  info(input: { workspaceId: string }): MaybePromise<OpenWorkspace>;
  readFile(input: {
    workspaceId: string;
    path: string;
    offset?: number;
    maxBytes?: number;
  }): MaybePromise<WorkspaceFileReadResult>;
  writeFile(input: {
    workspaceId: string;
    path: string;
    content: string;
  }): MaybePromise<WorkspaceFileWriteResult>;
  editFile(input: {
    workspaceId: string;
    path: string;
    oldText: string;
    newText: string;
    expectedReplacements: number;
  }): MaybePromise<WorkspaceFileEditResult>;
  search(input: {
    workspaceId: string;
    query: string;
    path?: string;
  }): MaybePromise<WorkspaceSearchMatch[]>;
  tree(input: { workspaceId: string; path?: string }): MaybePromise<WorkspaceTreeEntry[]>;
  inspect(input: WorkspaceInspectInput): Promise<WorkspaceInspectResult>;
}

export interface GitToolContext {
  status(input: { workspaceId: string }): MaybePromise<WorkspaceGitInspectionResult>;
  diff(input: { workspaceId: string }): MaybePromise<WorkspaceGitInspectionResult>;
  changes(input: GitChangesInput): Promise<GitChangesResult>;
}

export interface ProcessToolContext {
  run(input: {
    workspaceId: string;
    logicalExecutable: string;
    argv: string[];
    cwd?: string;
    env?: Record<string, string>;
    background?: boolean;
  }): MaybePromise<WorkspaceProcessOperationResult>;
  status(input: {
    workspaceId: string;
    operationId: string;
  }): MaybePromise<WorkspaceProcessOperationResult>;
  cancel(input: {
    workspaceId: string;
    operationId: string;
  }): MaybePromise<WorkspaceProcessOperationResult>;
}

export interface ArtifactToolContext {
  read(input: { uri: string; offset?: number; maxBytes?: number }): MaybePromise<ArtifactReadResult>;
}

export interface ExtensionToolContext {
  list(input: { limit?: number }): MaybePromise<PublicExtensionMetadata[]>;
}

export interface ProfileToolContext {
  current(input: { workspaceId: string }): MaybePromise<ProfileCurrentResult>;
  inspect(input: { name: "observe" | "develop" | "trusted" }): MaybePromise<JsonObject>;
}

export interface SystemToolContext {
  capabilities(): MaybePromise<JsonObject>;
  health(): MaybePromise<JsonObject>;
}

export interface CodeToolContext {
  search(input: CodeSearchInput): Promise<CodeSearchResult>;
}

export interface FileCapabilityToolContext {
  patch(input: FilePatchInput): Promise<FilePatchResult>;
}

export interface VerifyToolContext {
  list(input: VerifyListInput): Promise<VerifyListResult>;
  run(input: VerifyRunInput): Promise<VerifyRunResult>;
}

export interface ContextToolContext {
  build(input: ContextBuildInput): Promise<ContextBuildResult>;
}

export interface SkillToolContext {
  list(input: {
    limit?: number;
    sourceId?: string;
    compatibility?: SkillCompatibility;
    pinned?: boolean;
  }): Promise<SkillListResult>;
  inspect(input: { skillId: string; fingerprint?: string }): Promise<SkillInspectResult>;
  load(input: {
    skillId: string;
    fingerprint?: string;
    resources?: string[];
    maxBytes?: number;
  }): Promise<SkillLoadResult>;
}

export interface KodegptToolContext {
  workspace: WorkspaceToolContext;
  git: GitToolContext;
  process: ProcessToolContext;
  artifact: ArtifactToolContext;
  extension: ExtensionToolContext;
  profile: ProfileToolContext;
  system: SystemToolContext;
  code: CodeToolContext;
  file: FileCapabilityToolContext;
  verify: VerifyToolContext;
  context: ContextToolContext;
  skill: SkillToolContext;
}

export type WorkspaceManagerToolAdapter = Pick<
  WorkspaceManager,
  | "listWorkspaces"
  | "openWorkspace"
  | "closeWorkspace"
  | "requireReady"
  | "readFile"
  | "writeFile"
  | "editFile"
  | "gitStatus"
  | "gitDiff"
  | "search"
  | "tree"
>;

export type ExecutionManagerToolAdapter = Pick<ExecutionManager, "run" | "status" | "cancel">;
export type ArtifactStoreToolAdapter = Pick<ArtifactStore, "read">;
export type ExtensionRegistryToolAdapter = Pick<ExtensionRegistry, "listEnabled">;

export interface NativeCapabilityToolAdapter {
  inspectWorkspace(input: WorkspaceInspectInput): Promise<WorkspaceInspectResult>;
  searchCode(input: CodeSearchInput): Promise<CodeSearchResult>;
  gitChanges(input: GitChangesInput): Promise<GitChangesResult>;
  listVerifications(input: VerifyListInput): Promise<VerifyListResult>;
  runVerification(input: VerifyRunInput): Promise<VerifyRunResult>;
  patchFile(input: FilePatchInput): Promise<FilePatchResult>;
  buildContext(input: ContextBuildInput): Promise<ContextBuildResult>;
}

export class NativeCapabilityAdapterUnavailableError extends Error {
  readonly code = "CAPABILITY_NOT_IMPLEMENTED" as const;
  readonly capability: string;

  constructor(capability: string) {
    super(`Native capability adapter is not configured: ${capability}`);
    this.name = "NativeCapabilityAdapterUnavailableError";
    this.capability = capability;
  }
}

export function createKodegptToolContext(options: {
  workspaceManager: WorkspaceManagerToolAdapter;
  executionManager: ExecutionManagerToolAdapter;
  artifactStore: ArtifactStoreToolAdapter;
  extensionRegistry: ExtensionRegistryToolAdapter;
  nativeCapabilities?: NativeCapabilityToolAdapter;
  skillCatalog?: SkillCatalogToolAdapter;
  inspectProfile(name: "observe" | "develop" | "trusted"): unknown;
  capabilities(): MaybePromise<unknown>;
  health(): MaybePromise<unknown>;
}): KodegptToolContext {
  const native = options.nativeCapabilities ?? unavailableNativeCapabilities();
  const skill = options.skillCatalog ?? unavailableSkillCatalog();
  return {
    workspace: {
      list: () => options.workspaceManager.listWorkspaces(),
      open: ({ rootPath }) => options.workspaceManager.openWorkspace(rootPath),
      close: async ({ workspaceId }) => {
        await options.workspaceManager.closeWorkspace(workspaceId);
        return { ok: true };
      },
      info: ({ workspaceId }) => options.workspaceManager.requireReady(workspaceId),
      readFile: ({ workspaceId, path, offset, maxBytes }) =>
        options.workspaceManager.readFile(workspaceId, path, { offset, maxBytes }),
      writeFile: ({ workspaceId, path, content }) =>
        options.workspaceManager.writeFile(workspaceId, path, content),
      editFile: ({ workspaceId, path, oldText, newText, expectedReplacements }) =>
        options.workspaceManager.editFile(
          workspaceId,
          path,
          oldText,
          newText,
          expectedReplacements
        ),
      search: ({ workspaceId, query, path }) =>
        options.workspaceManager.search(workspaceId, query, path),
      tree: ({ workspaceId, path }) => options.workspaceManager.tree(workspaceId, path),
      inspect: (input) => native.inspectWorkspace(input)
    },
    git: {
      status: ({ workspaceId }) => options.workspaceManager.gitStatus(workspaceId),
      diff: ({ workspaceId }) => options.workspaceManager.gitDiff(workspaceId),
      changes: (input) => native.gitChanges(input)
    },
    process: {
      run: (input) => options.executionManager.run(input),
      status: ({ workspaceId, operationId }) =>
        options.executionManager.status(workspaceId, operationId),
      cancel: ({ workspaceId, operationId }) =>
        options.executionManager.cancel(workspaceId, operationId)
    },
    artifact: {
      read: ({ uri, offset, maxBytes }) => options.artifactStore.read(uri, { offset, maxBytes })
    },
    extension: {
      list: ({ limit }) => options.extensionRegistry.listEnabled(limit)
    },
    profile: {
      current: ({ workspaceId }) => ({
        workspaceId,
        effectivePolicy: options.workspaceManager.requireReady(workspaceId).effectivePolicy
      }),
      inspect: ({ name }) => requireJsonObject(options.inspectProfile(name), "profile.inspect")
    },
    system: {
      capabilities: async () => requireJsonObject(await options.capabilities(), "system.capabilities"),
      health: async () => requireJsonObject(await options.health(), "system.health")
    },
    code: {
      search: (input) => native.searchCode(input)
    },
    file: {
      patch: (input) => native.patchFile(input)
    },
    verify: {
      list: (input) => native.listVerifications(input),
      run: (input) => native.runVerification(input)
    },
    context: {
      build: (input) => native.buildContext(input)
    },
    skill: {
      list: (input) => skill.list(input),
      inspect: (input) => skill.inspect(input),
      load: (input) => skill.load(input)
    }
  };
}

function requireJsonObject(value: unknown, source: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${source} must return an object`);
  }
  return value as JsonObject;
}

function unavailableSkillCatalog(): SkillCatalogToolAdapter {
  const reject = () => Promise.reject(
    new SkillError("SKILL_SOURCE_UNAVAILABLE", "Skill catalog is unavailable")
  );
  return {
    list: reject,
    inspect: reject,
    load: reject
  };
}

function unavailableNativeCapabilities(): NativeCapabilityToolAdapter {
  return {
    inspectWorkspace: () => unavailable("workspace.inspect"),
    searchCode: () => unavailable("code.search"),
    gitChanges: () => unavailable("git.changes"),
    listVerifications: () => unavailable("verify.list"),
    runVerification: () => unavailable("verify.run"),
    patchFile: () => unavailable("file.patch"),
    buildContext: () => unavailable("context.build")
  };
}

function unavailable<T>(capability: string): Promise<T> {
  return Promise.reject(new NativeCapabilityAdapterUnavailableError(capability));
}
