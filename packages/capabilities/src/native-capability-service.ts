import type { CodeSearchAdapter, WorkspaceInspectionAdapter } from "./adapters.js";
import { searchCode } from "./code-search.js";
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

  constructor(options: {
    workspaceInspection: WorkspaceInspectionAdapter;
    codeSearch: CodeSearchAdapter;
  }) {
    this.#workspaceInspection = options.workspaceInspection;
    this.#codeSearch = options.codeSearch;
  }

  async inspectWorkspace(input: WorkspaceInspectInput): Promise<WorkspaceInspectResult> {
    return inspectWorkspace(this.#workspaceInspection, input);
  }

  async searchCode(input: CodeSearchInput): Promise<CodeSearchResult> {
    return searchCode(this.#workspaceInspection, this.#codeSearch, input);
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
