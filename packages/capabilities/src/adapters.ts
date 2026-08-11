import type {
  CapabilityArtifactMetadata,
  PatchFileAction,
  VerificationOperationResult
} from "./contracts.js";

export interface CapabilityWorkspaceInfo {
  id: string;
  canonicalRoot: string;
  effectivePolicy: unknown;
}

export type CapabilityTreeEntryKind = "file" | "directory" | "symlink" | "other";

export interface CapabilityTreeEntry {
  path: string;
  kind: CapabilityTreeEntryKind;
}

export interface CapabilitySearchMatch {
  path: string;
  line: number;
  lineText: string;
}

export interface GitInspectionAdapterResult {
  schemaVersion: 1;
  exitCode: number;
  stdoutPreview: string;
  stderrPreview: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  sourceTruncated: boolean;
  bytesSpooled: number;
  artifact: CapabilityArtifactMetadata;
}

export interface PatchCommitAdapterInput {
  workspaceId: string;
  path: string;
  action: PatchFileAction;
  expectedSha256: string | null;
  content: string | null;
}

export interface PatchCommitAdapterResult {
  schemaVersion: 1;
  action: PatchFileAction;
  bytesWritten: number;
  sha256: string | null;
}

export interface CapabilityWorkspaceAdapter {
  info(workspaceId: string): CapabilityWorkspaceInfo;
  readFile(
    workspaceId: string,
    path: string,
    options?: { offset?: number; maxBytes?: number }
  ): Promise<{ contents: string; bytesRead: number; eof: boolean }>;
  tree(workspaceId: string, path?: string): Promise<CapabilityTreeEntry[]>;
  search(workspaceId: string, query: string, path?: string): Promise<CapabilitySearchMatch[]>;
  gitStatus(workspaceId: string): Promise<GitInspectionAdapterResult>;
  gitDiff(workspaceId: string): Promise<GitInspectionAdapterResult>;
  commitPatchFile(input: PatchCommitAdapterInput): Promise<PatchCommitAdapterResult>;
}

export interface CapabilityExecutionAdapter {
  run(input: {
    workspaceId: string;
    logicalExecutable: string;
    argv: string[];
    cwd?: string;
    background?: boolean;
  }): Promise<VerificationOperationResult>;
}
