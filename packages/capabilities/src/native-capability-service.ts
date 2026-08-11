import type { CapabilityExecutionAdapter, CapabilityWorkspaceAdapter } from "./adapters.js";
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
  readonly #workspace: CapabilityWorkspaceAdapter;
  readonly #execution: CapabilityExecutionAdapter;

  constructor(options: {
    workspace: CapabilityWorkspaceAdapter;
    execution: CapabilityExecutionAdapter;
  }) {
    this.#workspace = options.workspace;
    this.#execution = options.execution;
  }

  async inspectWorkspace(input: WorkspaceInspectInput): Promise<WorkspaceInspectResult> {
    void input;
    void this.#workspace;
    throw new CapabilityNotImplementedError("workspace.inspect");
  }

  async searchCode(input: CodeSearchInput): Promise<CodeSearchResult> {
    void input;
    throw new CapabilityNotImplementedError("code.search");
  }

  async gitChanges(input: GitChangesInput): Promise<GitChangesResult> {
    void input;
    throw new CapabilityNotImplementedError("git.changes");
  }

  async listVerifications(input: VerifyListInput): Promise<VerifyListResult> {
    void input;
    throw new CapabilityNotImplementedError("verify.list");
  }

  async runVerification(input: VerifyRunInput): Promise<VerifyRunResult> {
    void input;
    void this.#execution;
    throw new CapabilityNotImplementedError("verify.run");
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
