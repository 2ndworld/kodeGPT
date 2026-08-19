import type {
  CodeSearchAdapter,
  GitCheckpointAdapter,
  GitHistoryAdapter,
  GitLocalAuthorityAdapter,
  GitLocalMutationAdapter,
  GitWorktreeMutationAdapter,
  GitRemoteAuthorityAdapter,
  GitRemoteCredentialSource,
  GitRemoteMutationAdapter,
  PatchCommitAdapter,
  PatchWorkspaceAdapter,
  VerificationAvailabilityAdapter,
  VerificationExecutionAdapter,
  VerificationWorkspaceAdapter,
  WorkspaceInspectionAdapter
} from "./adapters.js";
import { impactCode } from "./code-impact.js";
import { searchCode } from "./code-search.js";
import type {
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
  GitLogInput,
  GitLogResult,
  GitShowInput,
  GitShowResult,
  GitRangeInput,
  GitRangeResult,
  GitDiffHistoryInput,
  GitDiffHistoryResult,
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
  VerifyListInput,
  VerifyListResult,
  VerifyRunInput,
  VerifyRunResult,
  WorkspaceInspectInput,
  WorkspaceInspectResult
} from "./contracts.js";
import { CapabilityError } from "./errors.js";
import { buildContext as composeContext } from "./context-build.js";
import { gitChanges } from "./git-changes.js";
import { gitDiffHistory, gitLog, gitRange, gitShow } from "./git-history.js";
import {
  gitBranchCreate,
  gitBranchDelete,
  gitBranchSwitch,
  gitCommit,
  gitStage,
  gitWorktreeCreate,
  gitWorktreeRemove
} from "./git-local.js";
import { gitFetch, gitPull, gitPush } from "./git-remote.js";
import { patchFile } from "./patch.js";
import { listVerifications, runVerification } from "./verification.js";
import { inspectWorkspace } from "./workspace-inspect.js";

export type NativeCapabilityName =
  | "workspace.inspect"
  | "code.search"
  | "code.impact"
  | "git.changes"
  | "git.stage"
  | "git.commit"
  | "git.branchCreate"
  | "git.branchSwitch"
  | "git.branchDelete"
  | "git.worktreeCreate"
  | "git.worktreeRemove"
  | "git.fetch"
  | "git.pull"
  | "git.push"
  | "git.log"
  | "git.show"
  | "git.range"
  | "git.diffHistory"
  | "verify.list"
  | "verify.run"
  | "file.patch"
  | "context.build";

export interface NativeCapabilityDependencies {
  workspace: {
    inspection: WorkspaceInspectionAdapter;
    search: CodeSearchAdapter;
  };
  git: GitCheckpointAdapter;
  gitLocal: {
    authority: GitLocalAuthorityAdapter;
    mutation: GitLocalMutationAdapter;
  };
  gitWorktree: {
    authority: GitLocalAuthorityAdapter;
    mutation: GitWorktreeMutationAdapter;
  };
  gitRemote: {
    authority: GitRemoteAuthorityAdapter;
    mutation: GitRemoteMutationAdapter;
    credentials?: GitRemoteCredentialSource;
  };
  gitHistory: GitHistoryAdapter;
  patch: {
    workspace: PatchWorkspaceAdapter;
    commit: PatchCommitAdapter;
  };
  verification: {
    workspace: VerificationWorkspaceAdapter;
    availability: VerificationAvailabilityAdapter;
    execution: VerificationExecutionAdapter;
  };
}

export class CapabilityNotImplementedError extends CapabilityError {
  readonly capability: NativeCapabilityName;

  constructor(capability: NativeCapabilityName) {
    super("CAPABILITY_NOT_IMPLEMENTED", `Native capability is not implemented yet: ${capability}`);
    this.name = "CapabilityNotImplementedError";
    this.capability = capability;
  }
}

export class NativeCapabilityService {
  readonly #dependencies: NativeCapabilityDependencies;

  constructor(dependencies: NativeCapabilityDependencies) {
    this.#dependencies = dependencies;
  }

  async inspectWorkspace(input: WorkspaceInspectInput): Promise<WorkspaceInspectResult> {
    return inspectWorkspace(this.#dependencies.workspace.inspection, input);
  }

  async searchCode(input: CodeSearchInput): Promise<CodeSearchResult> {
    return searchCode(
      this.#dependencies.workspace.inspection,
      this.#dependencies.workspace.search,
      input
    );
  }

  async impactCode(input: CodeImpactInput): Promise<CodeImpactResult> {
    return impactCode(
      this.#dependencies.workspace.inspection,
      this.#dependencies.workspace.search,
      input
    );
  }

  async gitChanges(input: GitChangesInput): Promise<GitChangesResult> {
    return gitChanges(this.#dependencies.git, input);
  }

  async gitStage(input: GitStageInput): Promise<GitLocalMutationResult> {
    return gitStage(this.#dependencies.gitLocal.authority, this.#dependencies.gitLocal.mutation, input);
  }

  async gitCommit(input: GitCommitInput): Promise<GitLocalMutationResult> {
    return gitCommit(this.#dependencies.gitLocal.authority, this.#dependencies.gitLocal.mutation, input);
  }

  async gitBranchCreate(input: GitBranchInput): Promise<GitLocalMutationResult> {
    return gitBranchCreate(this.#dependencies.gitLocal.authority, this.#dependencies.gitLocal.mutation, input);
  }

  async gitBranchSwitch(input: GitBranchInput): Promise<GitLocalMutationResult> {
    return gitBranchSwitch(this.#dependencies.gitLocal.authority, this.#dependencies.gitLocal.mutation, input);
  }

  async gitBranchDelete(input: GitBranchInput): Promise<GitLocalMutationResult> {
    return gitBranchDelete(this.#dependencies.gitLocal.authority, this.#dependencies.gitLocal.mutation, input);
  }

  async gitWorktreeCreate(input: GitWorktreeCreateInput): Promise<GitWorktreeCreateResult> {
    return gitWorktreeCreate(
      this.#dependencies.gitWorktree.authority,
      this.#dependencies.gitWorktree.mutation,
      input
    );
  }

  async gitWorktreeRemove(input: GitWorktreeRemoveInput): Promise<GitWorktreeRemoveResult> {
    return gitWorktreeRemove(
      this.#dependencies.gitWorktree.authority,
      this.#dependencies.gitWorktree.mutation,
      input
    );
  }

  async gitFetch(input: GitRemoteInput): Promise<GitRemoteMutationResult> {
    return gitFetch(
      this.#dependencies.gitRemote.authority,
      this.#dependencies.gitRemote.mutation,
      input,
      this.#dependencies.gitRemote.credentials
    );
  }

  async gitPull(input: GitRemoteInput): Promise<GitRemoteMutationResult> {
    return gitPull(
      this.#dependencies.gitRemote.authority,
      this.#dependencies.gitRemote.mutation,
      input,
      this.#dependencies.gitRemote.credentials
    );
  }

  async gitPush(input: GitRemoteInput): Promise<GitRemoteMutationResult> {
    return gitPush(
      this.#dependencies.gitRemote.authority,
      this.#dependencies.gitRemote.mutation,
      input,
      this.#dependencies.gitRemote.credentials
    );
  }

  async gitLog(input: GitLogInput): Promise<GitLogResult> {
    return gitLog(this.#dependencies.gitHistory, input);
  }

  async gitShow(input: GitShowInput): Promise<GitShowResult> {
    return gitShow(this.#dependencies.gitHistory, input);
  }

  async gitRange(input: GitRangeInput): Promise<GitRangeResult> {
    return gitRange(this.#dependencies.gitHistory, input);
  }

  async gitDiffHistory(input: GitDiffHistoryInput): Promise<GitDiffHistoryResult> {
    return gitDiffHistory(this.#dependencies.gitHistory, input);
  }

  async listVerifications(input: VerifyListInput): Promise<VerifyListResult> {
    return listVerifications(
      this.#dependencies.verification.workspace,
      this.#dependencies.verification.availability,
      input
    );
  }

  async runVerification(input: VerifyRunInput): Promise<VerifyRunResult> {
    return runVerification(
      this.#dependencies.verification.workspace,
      this.#dependencies.verification.availability,
      this.#dependencies.verification.execution,
      input
    );
  }

  async patchFile(input: FilePatchInput): Promise<FilePatchResult> {
    return patchFile(this.#dependencies.patch.workspace, this.#dependencies.patch.commit, input);
  }

  async buildContext(input: ContextBuildInput): Promise<ContextBuildResult> {
    return composeContext(
      {
        inspect: (inspectInput) => this.inspectWorkspace(inspectInput),
        git: (gitInput) => this.gitChanges(gitInput),
        search: (searchInput) => this.searchCode(searchInput),
        verify: (verifyInput) => this.listVerifications(verifyInput),
        readFile: (workspaceId, path, options) =>
          this.#dependencies.workspace.inspection.readFile(workspaceId, path, options)
      },
      input
    );
  }
}
