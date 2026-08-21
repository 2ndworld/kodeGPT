import type { ArtifactReadResult, ArtifactStore } from "../../artifacts/src/index.js";
import { searchPublicActions } from "@kodegpt/capabilities";
import type {
  CiCancelInput,
  CiDispatchInput,
  CiFailureInput,
  CiFailureResult,
  CiMutationResult,
  CiRepositoryInput,
  CiRerunInput,
  CiRepositoryResult,
  CiRunInput,
  CiRunResult,
  CiRunsInput,
  CiRunsResult,
  CiStatusInput,
  CiStatusResult,
  CodeImpactInput,
  CodeImpactResult,
  CodeSearchInput,
  CodeSearchResult,
  ContextBuildInput,
  ContextBuildResult,
  FilePatchInput,
  FilePatchResult,
  GitChangesInput,
  GitChangesResult,
  GitStageInput,
  GitCommitInput,
  GitBranchInput,
  GitLocalMutationResult,
  GitWorktreeCreateInput,
  GitWorktreeCreateResult,
  GitWorktreeRemoveInput,
  GitWorktreeRemoveResult,
  GitRemoteInput,
  GitRemoteMutationResult,
  GitLogInput,
  GitLogResult,
  GitShowInput,
  GitShowResult,
  GitRangeInput,
  GitRangeResult,
  GitDiffHistoryInput,
  GitDiffHistoryResult,
  GitHubReadToolAdapter,
  GitHubWriteToolAdapter,
  VerifyListInput,
  VerifyListResult,
  VerifyRunInput,
  VerifyRunResult,
  WorkspaceInspectInput,
  WorkspaceInspectResult
} from "@kodegpt/capabilities";
import type {
  BrowserManager,
  ExecutionManager,
  OpenWorkspace,
  PreviewLookupInput,
  PreviewStartInput,
  PreviewStatusResult,
  TrustedWorkspaceSummary,
  VisualVerificationManager,
  WorkspaceFileReadResult,
  WorkspaceFileWritePrecondition,
  WorkspaceManager,
  WorkspaceCheckpointMutationInput,
  WorkspaceCheckpointMutationResult,
  WorkspaceInfo,
  WorkspaceTreeEntry
} from "../../core/src/index.js";
import {
  rankSkillsForQuery,
  resolveSkillCapabilityPlan,
  type SkillCatalogToolAdapter,
  type SkillCompatibility,
  type SkillInspectResult,
  type SkillListResult,
  type SkillLoadResult
} from "@kodegpt/skills";
import { SkillError } from "@kodegpt/skills/errors";
import {
  discoverKodegpt,
  type SystemDiscoverInput,
  type SystemDiscoverResult
} from "./discovery.js";

export type JsonObject = Record<string, unknown>;
export type MaybePromise<T> = Promise<T> | T;

export type WorkspaceFileWriteResult = Awaited<ReturnType<WorkspaceManager["writeFile"]>>;
export type WorkspaceFileEditResult = Awaited<ReturnType<WorkspaceManager["editFile"]>>;
export type WorkspaceGitInspectionResult = Awaited<ReturnType<WorkspaceManager["gitStatus"]>>;
export type WorkspaceProcessOperationResult = Awaited<ReturnType<ExecutionManager["run"]>>;

export interface WorkspaceCloseResult {
  ok: true;
}

export interface WorkspaceUntrustResult {
  trustId: string;
  removed: boolean;
}

export interface ProfileCurrentResult {
  workspaceId: string;
  effectivePolicy: OpenWorkspace["effectivePolicy"];
}

export interface WorkspaceToolContext {
  list(): MaybePromise<OpenWorkspace[]>;
  open(input: { rootPath: string }): MaybePromise<OpenWorkspace>;
  trust(input: {
    rootPath: string;
    profile?: "observe" | "develop" | "trusted";
  }): MaybePromise<TrustedWorkspaceSummary>;
  untrust(input: { trustId: string }): MaybePromise<WorkspaceUntrustResult>;
  close(input: { workspaceId: string }): MaybePromise<WorkspaceCloseResult>;
  checkpoint(input: WorkspaceCheckpointMutationInput): MaybePromise<WorkspaceCheckpointMutationResult>;
  info(input: { workspaceId: string }): MaybePromise<WorkspaceInfo>;
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
    precondition?: WorkspaceFileWritePrecondition;
  }): MaybePromise<WorkspaceFileWriteResult>;
  editFile(input: {
    workspaceId: string;
    path: string;
    oldText: string;
    newText: string;
    expectedReplacements: number;
  }): MaybePromise<WorkspaceFileEditResult>;
  tree(input: { workspaceId: string; path?: string }): MaybePromise<WorkspaceTreeEntry[]>;
  inspect(input: WorkspaceInspectInput): Promise<WorkspaceInspectResult>;
}

export interface TrustToolContext {
  list(): MaybePromise<TrustedWorkspaceSummary[]>;
}

export interface GitToolContext {
  status(input: { workspaceId: string }): MaybePromise<WorkspaceGitInspectionResult>;
  diff(input: { workspaceId: string }): MaybePromise<WorkspaceGitInspectionResult>;
  changes(input: GitChangesInput): Promise<GitChangesResult>;
  stage(input: GitStageInput): Promise<GitLocalMutationResult>;
  commit(input: GitCommitInput): Promise<GitLocalMutationResult>;
  branchCreate(input: GitBranchInput): Promise<GitLocalMutationResult>;
  branchSwitch(input: GitBranchInput): Promise<GitLocalMutationResult>;
  branchDelete(input: GitBranchInput): Promise<GitLocalMutationResult>;
  worktreeCreate(input: GitWorktreeCreateInput): Promise<GitWorktreeCreateResult>;
  worktreeRemove(input: GitWorktreeRemoveInput): Promise<GitWorktreeRemoveResult>;
  fetch(input: GitRemoteInput): Promise<GitRemoteMutationResult>;
  pull(input: GitRemoteInput): Promise<GitRemoteMutationResult>;
  push(input: GitRemoteInput): Promise<GitRemoteMutationResult>;
  log(input: GitLogInput): Promise<GitLogResult>;
  show(input: GitShowInput): Promise<GitShowResult>;
  range(input: GitRangeInput): Promise<GitRangeResult>;
  diffHistory(input: GitDiffHistoryInput): Promise<GitDiffHistoryResult>;
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
    waitMs?: number;
  }): MaybePromise<WorkspaceProcessOperationResult>;
  cancel(input: {
    workspaceId: string;
    operationId: string;
  }): MaybePromise<WorkspaceProcessOperationResult>;
}

export interface PreviewToolContext {
  start(input: PreviewStartInput): MaybePromise<PreviewStatusResult>;
  inspect(input: PreviewLookupInput): MaybePromise<PreviewStatusResult>;
  stop(input: PreviewLookupInput): MaybePromise<PreviewStatusResult>;
}

export type BrowserToolContext = Pick<
  BrowserManager,
  | "openPreview"
  | "inspect"
  | "click"
  | "type"
  | "screenshot"
  | "console"
  | "networkFailures"
  | "releasePreview"
  | "releaseWorkspace"
>;

export type VisualToolContext = Pick<VisualVerificationManager, "captureMatrix" | "compare">;

export interface ArtifactToolContext {
  read(input: { uri: string; offset?: number; maxBytes?: number }): MaybePromise<ArtifactReadResult>;
}

export interface ProfileToolContext {
  current(input: { workspaceId: string }): MaybePromise<ProfileCurrentResult>;
  inspect(input: { name: "observe" | "develop" | "trusted" }): MaybePromise<JsonObject>;
}

export interface SystemToolContext {
  capabilities(): MaybePromise<JsonObject>;
  discover(input: SystemDiscoverInput): Promise<SystemDiscoverResult>;
  health(): MaybePromise<JsonObject>;
}

export interface CodeToolContext {
  search(input: CodeSearchInput): Promise<CodeSearchResult>;
  impact(input: CodeImpactInput): Promise<CodeImpactResult>;
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

export interface CiToolContext {
  repository(input: CiRepositoryInput): Promise<CiRepositoryResult>;
  status(input: CiStatusInput): Promise<CiStatusResult>;
  runs(input: CiRunsInput): Promise<CiRunsResult>;
  run(input: CiRunInput): Promise<CiRunResult>;
  failure(input: CiFailureInput): Promise<CiFailureResult>;
  rerun(input: CiRerunInput): Promise<CiMutationResult>;
  cancel(input: CiCancelInput): Promise<CiMutationResult>;
  dispatch(input: CiDispatchInput): Promise<CiMutationResult>;
}

export interface GitHubToolContext extends GitHubReadToolAdapter, GitHubWriteToolAdapter {}

export interface SkillToolContext {
  list(input: {
    limit?: number;
    sourceId?: string;
    compatibility?: SkillCompatibility;
    pinned?: boolean;
    workspaceId?: string;
    query?: string;
  }): Promise<SkillListResult>;
  inspect(input: { skillId: string; fingerprint?: string; workspaceId?: string }): Promise<SkillInspectResult>;
  load(input: {
    skillId: string;
    fingerprint?: string;
    resources?: string[];
    maxBytes?: number;
    workspaceId?: string;
  }): Promise<SkillLoadResult>;
}

export interface KodegptToolContext {
  workspace: WorkspaceToolContext;
  trust: TrustToolContext;
  git: GitToolContext;
  process: ProcessToolContext;
  preview: PreviewToolContext;
  browser: BrowserToolContext;
  visual: VisualToolContext;
  artifact: ArtifactToolContext;
  profile: ProfileToolContext;
  system: SystemToolContext;
  code: CodeToolContext;
  file: FileCapabilityToolContext;
  verify: VerifyToolContext;
  context: ContextToolContext;
  ci: CiToolContext;
  github: GitHubToolContext;
  skill: SkillToolContext;
}

export type WorkspaceManagerToolAdapter = Pick<
  WorkspaceManager,
  | "listWorkspaces"
  | "listTrustedWorkspaces"
  | "openWorkspace"
  | "trustWorkspace"
  | "untrustWorkspace"
  | "closeWorkspace"
  | "checkpointWorkspace"
  | "workspaceInfo"
  | "requireReady"
  | "readFile"
  | "writeFile"
  | "editFile"
  | "gitStatus"
  | "gitDiff"
  | "gitStage"
  | "gitCommit"
  | "gitBranchCreate"
  | "gitBranchSwitch"
  | "gitBranchDelete"
  | "inspectExecutable"
  | "tree"
>;

export type ExecutionManagerToolAdapter = Pick<ExecutionManager, "run" | "status" | "cancel">;
export type ArtifactStoreToolAdapter = Pick<ArtifactStore, "read">;

export interface NativeCapabilityToolAdapter {
  inspectWorkspace(input: WorkspaceInspectInput): Promise<WorkspaceInspectResult>;
  searchCode(input: CodeSearchInput): Promise<CodeSearchResult>;
  impactCode(input: CodeImpactInput): Promise<CodeImpactResult>;
  gitChanges(input: GitChangesInput): Promise<GitChangesResult>;
  gitStage(input: GitStageInput): Promise<GitLocalMutationResult>;
  gitCommit(input: GitCommitInput): Promise<GitLocalMutationResult>;
  gitBranchCreate(input: GitBranchInput): Promise<GitLocalMutationResult>;
  gitBranchSwitch(input: GitBranchInput): Promise<GitLocalMutationResult>;
  gitBranchDelete(input: GitBranchInput): Promise<GitLocalMutationResult>;
  gitWorktreeCreate(input: GitWorktreeCreateInput): Promise<GitWorktreeCreateResult>;
  gitWorktreeRemove(input: GitWorktreeRemoveInput): Promise<GitWorktreeRemoveResult>;
  gitFetch(input: GitRemoteInput): Promise<GitRemoteMutationResult>;
  gitPull(input: GitRemoteInput): Promise<GitRemoteMutationResult>;
  gitPush(input: GitRemoteInput): Promise<GitRemoteMutationResult>;
  gitLog(input: GitLogInput): Promise<GitLogResult>;
  gitShow(input: GitShowInput): Promise<GitShowResult>;
  gitRange(input: GitRangeInput): Promise<GitRangeResult>;
  gitDiffHistory(input: GitDiffHistoryInput): Promise<GitDiffHistoryResult>;
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
  preview?: PreviewToolContext & { releaseWorkspace?(workspaceId: string): MaybePromise<void> };
  browser?: BrowserToolContext;
  visual?: VisualToolContext;
  artifactStore: ArtifactStoreToolAdapter;
  nativeCapabilities?: NativeCapabilityToolAdapter;
  remoteCi?: CiToolContext;
  githubRead?: GitHubReadToolAdapter;
  githubWrite?: GitHubWriteToolAdapter;
  skillCatalog?: SkillCatalogToolAdapter;
  inspectProfile(name: "observe" | "develop" | "trusted"): unknown;
  capabilities(): MaybePromise<unknown>;
  health(): MaybePromise<unknown>;
}): KodegptToolContext {
  const native = options.nativeCapabilities ?? unavailableNativeCapabilities();
  const remoteCi = options.remoteCi ?? unavailableRemoteCi();
  const githubRead = options.githubRead ?? unavailableGitHubRead();
  const githubWrite = options.githubWrite ?? unavailableGitHubWrite();
  const preview = options.preview ?? unavailablePreview();
  const browser = options.browser ?? unavailableBrowser();
  const visual = options.visual ?? unavailableVisual();
  const skill = options.skillCatalog ?? unavailableSkillCatalog();
  const inspectSkill: SkillToolContext["inspect"] = async ({ skillId, fingerprint, workspaceId }) => {
    const inspection = await skill.inspect({
      skillId,
      fingerprint,
      ...(workspaceId === undefined ? {} : { workspaceId })
    });
    if (workspaceId === undefined) return inspection;
    const ready = options.workspaceManager.requireReady(workspaceId);
    const capabilityPlan = await resolveSkillCapabilityPlan(inspection.capabilityPlan, {
      workspaceId,
      allowProcess: ready.effectivePolicy.allowProcess,
      allowDynamicExecutables: ready.effectivePolicy.allowDynamicExecutables,
      allowedExecutableNames: ready.effectivePolicy.allowedExecutableNames,
      inspectExecutable: async (executable) => {
        const availability = await options.workspaceManager.inspectExecutable(workspaceId, executable);
        return {
          executableAvailable: availability.executableAvailable,
          sandboxAvailable: availability.sandboxAvailable
        };
      }
    });
    return { ...inspection, capabilityPlan };
  };
  return {
    workspace: {
      list: () => options.workspaceManager.listWorkspaces(),
      open: ({ rootPath }) => options.workspaceManager.openWorkspace(rootPath),
      trust: ({ rootPath, profile }) => options.workspaceManager.trustWorkspace(rootPath, profile),
      untrust: async ({ trustId }) => ({
        trustId,
        removed: await options.workspaceManager.untrustWorkspace(trustId)
      }),
      close: async ({ workspaceId }) => {
        await options.workspaceManager.closeWorkspace(workspaceId);
        await browser.releaseWorkspace(workspaceId);
        await options.preview?.releaseWorkspace?.(workspaceId);
        return { ok: true };
      },
      checkpoint: (input) => options.workspaceManager.checkpointWorkspace(input),
      info: ({ workspaceId }) => options.workspaceManager.workspaceInfo(workspaceId),
      readFile: ({ workspaceId, path, offset, maxBytes }) =>
        options.workspaceManager.readFile(workspaceId, path, { offset, maxBytes }),
      writeFile: ({ workspaceId, path, content, precondition }) =>
        options.workspaceManager.writeFile(workspaceId, path, content, { precondition }),
      editFile: ({ workspaceId, path, oldText, newText, expectedReplacements }) =>
        options.workspaceManager.editFile(
          workspaceId,
          path,
          oldText,
          newText,
          expectedReplacements
        ),
      tree: ({ workspaceId, path }) => options.workspaceManager.tree(workspaceId, path),
      inspect: (input) => native.inspectWorkspace(input)
    },
    trust: {
      list: () => options.workspaceManager.listTrustedWorkspaces()
    },
    git: {
      status: ({ workspaceId }) => options.workspaceManager.gitStatus(workspaceId),
      diff: ({ workspaceId }) => options.workspaceManager.gitDiff(workspaceId),
      changes: (input) => native.gitChanges(input),
      stage: (input) => native.gitStage(input),
      commit: (input) => native.gitCommit(input),
      branchCreate: (input) => native.gitBranchCreate(input),
      branchSwitch: (input) => native.gitBranchSwitch(input),
      branchDelete: (input) => native.gitBranchDelete(input),
      worktreeCreate: (input) => native.gitWorktreeCreate(input),
      worktreeRemove: (input) => native.gitWorktreeRemove(input),
      fetch: (input) => native.gitFetch(input),
      pull: (input) => native.gitPull(input),
      push: (input) => native.gitPush(input),
      log: (input) => native.gitLog(input),
      show: (input) => native.gitShow(input),
      range: (input) => native.gitRange(input),
      diffHistory: (input) => native.gitDiffHistory(input)
    },
    process: {
      run: (input) => options.executionManager.run(input),
      status: ({ workspaceId, operationId, waitMs }) =>
        options.executionManager.status(workspaceId, operationId, waitMs),
      cancel: ({ workspaceId, operationId }) =>
        options.executionManager.cancel(workspaceId, operationId)
    },
    preview: {
      start: (input) => preview.start(input),
      inspect: (input) => preview.inspect(input),
      stop: async (input) => {
        await browser.releasePreview(input.workspaceId, input.previewId);
        return preview.stop(input);
      }
    },
    browser: {
      openPreview: (input) => browser.openPreview(input),
      inspect: (input) => browser.inspect(input),
      click: (input) => browser.click(input),
      type: (input) => browser.type(input),
      screenshot: (input) => browser.screenshot(input),
      console: (input) => browser.console(input),
      networkFailures: (input) => browser.networkFailures(input),
      releasePreview: (workspaceId, previewId) => browser.releasePreview(workspaceId, previewId),
      releaseWorkspace: (workspaceId) => browser.releaseWorkspace(workspaceId)
    },
    visual: {
      captureMatrix: (input) => visual.captureMatrix(input),
      compare: (input) => visual.compare(input)
    },
    artifact: {
      read: ({ uri, offset, maxBytes }) => options.artifactStore.read(uri, { offset, maxBytes })
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
      discover: (input) =>
        discoverKodegpt(input, {
          searchActions: searchPublicActions,
          rankSkills: rankSkillsForQuery,
          listSkills: (listInput) => skill.list(listInput),
          inspectSkill,
          workspaceInfo: ({ workspaceId }) => options.workspaceManager.workspaceInfo(workspaceId)
        }),
      health: async () => requireJsonObject(await options.health(), "system.health")
    },
    code: {
      search: (input) => native.searchCode(input),
      impact: (input) => native.impactCode(input)
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
    ci: {
      repository: (input) => remoteCi.repository(input),
      status: (input) => remoteCi.status(input),
      runs: (input) => remoteCi.runs(input),
      run: (input) => remoteCi.run(input),
      failure: (input) => remoteCi.failure(input),
      rerun: (input) => remoteCi.rerun(input),
      cancel: (input) => remoteCi.cancel(input),
      dispatch: (input) => remoteCi.dispatch(input)
    },
    github: {
      ...githubRead,
      ...githubWrite
    },
    skill: {
      list: (input) => skill.list(input),
      inspect: inspectSkill,
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

function unavailablePreview(): PreviewToolContext {
  return {
    start: () => unavailable("preview.start"),
    inspect: () => unavailable("preview.inspect"),
    stop: () => unavailable("preview.stop")
  };
}

function unavailableBrowser(): BrowserToolContext {
  return {
    openPreview: () => unavailable("browser.openPreview"),
    inspect: () => unavailable("browser.inspect"),
    click: () => unavailable("browser.click"),
    type: () => unavailable("browser.type"),
    screenshot: () => unavailable("browser.screenshot"),
    console: () => unavailable("browser.console"),
    networkFailures: () => unavailable("browser.networkFailures"),
    releasePreview: async () => undefined,
    releaseWorkspace: async () => undefined
  };
}

function unavailableVisual(): VisualToolContext {
  return {
    captureMatrix: () => unavailable("visual.captureMatrix"),
    compare: () => unavailable("visual.compare")
  };
}

function unavailableRemoteCi(): CiToolContext {
  return {
    repository: () => unavailable("ci.repository"),
    status: () => unavailable("ci.status"),
    runs: () => unavailable("ci.runs"),
    run: () => unavailable("ci.run"),
    failure: () => unavailable("ci.failure"),
    rerun: () => unavailable("ci.rerun"),
    cancel: () => unavailable("ci.cancel"),
    dispatch: () => unavailable("ci.dispatch")
  };
}

function unavailableGitHubRead(): GitHubReadToolAdapter {
  return {
    repositoryInspect: () => unavailable("github.repository.inspect"),
    prInspect: () => unavailable("github.pr.inspect"),
    prList: () => unavailable("github.pr.list"),
    issueInspect: () => unavailable("github.issue.inspect"),
    issueList: () => unavailable("github.issue.list")
  };
}

function unavailableGitHubWrite(): GitHubWriteToolAdapter {
  return {
    prCreate: () => unavailable("github.pr.create"),
    prMerge: () => unavailable("github.pr.merge")
  };
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
    impactCode: () => unavailable("code.impact"),
    gitChanges: () => unavailable("git.changes"),
    gitStage: () => unavailable("git.stage"),
    gitCommit: () => unavailable("git.commit"),
    gitBranchCreate: () => unavailable("git.branchCreate"),
    gitBranchSwitch: () => unavailable("git.branchSwitch"),
    gitBranchDelete: () => unavailable("git.branchDelete"),
    gitWorktreeCreate: () => unavailable("git.worktreeCreate"),
    gitWorktreeRemove: () => unavailable("git.worktreeRemove"),
    gitFetch: () => unavailable("git.fetch"),
    gitPull: () => unavailable("git.pull"),
    gitPush: () => unavailable("git.push"),
    gitLog: () => unavailable("git.log"),
    gitShow: () => unavailable("git.show"),
    gitRange: () => unavailable("git.range"),
    gitDiffHistory: () => unavailable("git.diffHistory"),
    listVerifications: () => unavailable("verify.list"),
    runVerification: () => unavailable("verify.run"),
    patchFile: () => unavailable("file.patch"),
    buildContext: () => unavailable("context.build")
  };
}

function unavailable<T>(capability: string): Promise<T> {
  return Promise.reject(new NativeCapabilityAdapterUnavailableError(capability));
}
