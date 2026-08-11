import type {
  CodeSearchAdapter,
  GitCheckpointAdapter,
  PatchCommitAdapter,
  PatchWorkspaceAdapter,
  VerificationAvailabilityAdapter,
  VerificationExecutionAdapter,
  VerificationWorkspaceAdapter,
  WorkspaceInspectionAdapter
} from "./adapters.js";
import { searchCode } from "./code-search.js";
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
} from "./contracts.js";
import { CapabilityError } from "./errors.js";
import { buildContext as composeContext } from "./context-build.js";
import { gitChanges } from "./git-changes.js";
import { patchFile } from "./patch.js";
import { listVerifications, runVerification } from "./verification.js";
import { inspectWorkspace } from "./workspace-inspect.js";

export type NativeCapabilityName =
  | "workspace.inspect"
  | "code.search"
  | "git.changes"
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

  async gitChanges(input: GitChangesInput): Promise<GitChangesResult> {
    return gitChanges(this.#dependencies.git, input);
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
