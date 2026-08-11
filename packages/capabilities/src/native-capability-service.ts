import type {
  CapabilityExecutionAdapter,
  CodeSearchAdapter,
  GitInspectionAdapter,
  VerificationWorkspaceAdapter,
  WorkspaceInspectionAdapter
} from "./adapters.js";
import { searchCode } from "./code-search.js";
import { gitChanges } from "./git-changes.js";
import { listVerifications, runVerification } from "./verification.js";
import { inspectWorkspace } from "./workspace-inspect.js";
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

export type NativeCapabilityName =
  | "workspace.inspect"
  | "code.search"
  | "git.changes"
  | "verify.list"
  | "verify.run"
  | "file.patch"
  | "context.build";

export class CapabilityNotImplementedError extends Error {
  readonly code = "CAPABILITY_NOT_IMPLEMENTED" as const;
  readonly capability: NativeCapabilityName;

  constructor(capability: NativeCapabilityName) {
    super(`Native capability is not implemented yet: ${capability}`);
    this.name = "CapabilityNotImplementedError";
    this.capability = capability;
  }
}

export class NativeCapabilityService {
  readonly #workspaceInspection: WorkspaceInspectionAdapter;
  readonly #codeSearch: CodeSearchAdapter;
  readonly #gitInspection: GitInspectionAdapter;
  readonly #verificationWorkspace: VerificationWorkspaceAdapter;
  readonly #execution: CapabilityExecutionAdapter;

  constructor(options: {
    workspaceInspection: WorkspaceInspectionAdapter;
    codeSearch: CodeSearchAdapter;
    gitInspection: GitInspectionAdapter;
    verificationWorkspace: VerificationWorkspaceAdapter;
    execution: CapabilityExecutionAdapter;
  }) {
    this.#workspaceInspection = options.workspaceInspection;
    this.#codeSearch = options.codeSearch;
    this.#gitInspection = options.gitInspection;
    this.#verificationWorkspace = options.verificationWorkspace;
    this.#execution = options.execution;
  }

  async inspectWorkspace(input: WorkspaceInspectInput): Promise<WorkspaceInspectResult> {
    return inspectWorkspace(this.#workspaceInspection, input);
  }

  async searchCode(input: CodeSearchInput): Promise<CodeSearchResult> {
    return searchCode(this.#workspaceInspection, this.#codeSearch, input);
  }

  async gitChanges(input: GitChangesInput): Promise<GitChangesResult> {
    return gitChanges(this.#gitInspection, input);
  }

  async listVerifications(input: VerifyListInput): Promise<VerifyListResult> {
    return listVerifications(this.#verificationWorkspace, input);
  }

  async runVerification(input: VerifyRunInput): Promise<VerifyRunResult> {
    return runVerification(this.#verificationWorkspace, this.#execution, input);
  }

  async patchFile(input: FilePatchInput): Promise<FilePatchResult> {
    void input;
    throw new CapabilityNotImplementedError("file.patch");
  }

  async buildContext(input: ContextBuildInput): Promise<ContextBuildResult> {
    void input;
    throw new CapabilityNotImplementedError("context.build");
  }
}
