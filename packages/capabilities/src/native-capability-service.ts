import type {
  CapabilityExecutionAdapter,
  CodeSearchAdapter,
  GitInspectionAdapter,
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
import { gitChanges } from "./git-changes.js";
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
  git: GitInspectionAdapter;
  verification: {
    workspace: VerificationWorkspaceAdapter;
    execution: CapabilityExecutionAdapter;
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
    return listVerifications(this.#dependencies.verification.workspace, input);
  }

  async runVerification(input: VerifyRunInput): Promise<VerifyRunResult> {
    return runVerification(
      this.#dependencies.verification.workspace,
      this.#dependencies.verification.execution,
      input
    );
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
