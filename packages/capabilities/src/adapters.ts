import type {
  CapabilityArtifactMetadata,
  CodeSearchTruncationReason,
  PatchFileAction,
  VerificationOperationResult
} from "./contracts.js";

export type CapabilityTreeEntryKind = "file" | "directory" | "symlink" | "other";

export interface CapabilityTreeEntry {
  path: string;
  kind: CapabilityTreeEntryKind;
}

export interface CapabilityTreeResult {
  entries: CapabilityTreeEntry[];
  truncated: boolean;
}

export interface CapabilitySearchMatch {
  path: string;
  line: number;
  lineText: string;
}

export interface CapabilitySearchResult {
  matches: CapabilitySearchMatch[];
  truncated: boolean;
  truncationReasons: CodeSearchTruncationReason[];
}

export interface CapabilityPathIdentityResult {
  exists: boolean;
  kind?: "file" | "directory" | "symlink" | "other";
  sizeBytes?: number;
  sha256?: string;
  hashTruncated: boolean;
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

export interface WorkspaceInspectionAdapter {
  readFile(
    workspaceId: string,
    path: string,
    options?: { offset?: number; maxBytes?: number }
  ): Promise<{ contents: string; bytesRead: number; eof: boolean }>;
  tree(
    workspaceId: string,
    path: string | undefined,
    maxEntries: number
  ): Promise<CapabilityTreeResult>;
}

export interface CodeSearchAdapter {
  search(
    workspaceId: string,
    query: string,
    path: string | undefined,
    maxMatches: number
  ): Promise<CapabilitySearchResult>;
}

export interface GitInspectionAdapter {
  gitStatus(workspaceId: string): Promise<GitInspectionAdapterResult>;
  gitDiff(workspaceId: string): Promise<GitInspectionAdapterResult>;
}

export interface PatchCommitAdapter {
  commitPatchFile(input: PatchCommitAdapterInput): Promise<PatchCommitAdapterResult>;
}

export interface VerificationWorkspaceAdapter {
  readFile(
    workspaceId: string,
    path: string,
    options?: { offset?: number; maxBytes?: number }
  ): Promise<{ contents: string; bytesRead: number; eof: boolean }>;
  tree(
    workspaceId: string,
    path: string | undefined,
    maxEntries: number
  ): Promise<CapabilityTreeResult>;
  effectivePolicy(workspaceId: string): {
    allowProcess: boolean;
    allowedExecutableNames: string[];
  };
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
