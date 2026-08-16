import type {
  CapabilityArtifactMetadata,
  CodeSearchTruncationReason,
  PatchFileAction,
  VerificationOperationResult,
  GitRevision,
  GitLogResult,
  GitShowResult,
  GitRangeResult,
  GitDiffHistoryResult,
  GitLocalMutationResult,
  GitRemoteMutationResult
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
    maxEntries: number,
    scope: "literal" | "semantic"
  ): Promise<CapabilityTreeResult>;
}

export interface CodeSearchAdapter {
  search(
    workspaceId: string,
    query: string,
    path: string | undefined,
    maxMatches: number,
    scope: "literal" | "semantic"
  ): Promise<CapabilitySearchResult>;
}

export interface GitInspectionAdapter {
  gitStatus(workspaceId: string): Promise<GitInspectionAdapterResult>;
  gitDiff(workspaceId: string): Promise<GitInspectionAdapterResult>;
}

export interface RemoteCiReadyWorkspace {
  id: string;
}

export interface RemoteCiWorkspaceSelectionAdapter {
  listReady(): Promise<RemoteCiReadyWorkspace[]>;
}

export interface RemoteCiRepositoryInspection {
  headOid: string;
  branch: string | null;
  remotes: Array<{ name: string; fetchUrl: string }>;
}

export interface RemoteCiRepositoryInspectionAdapter {
  inspect(workspaceId: string): Promise<RemoteCiRepositoryInspection>;
}

export interface RemoteCiCredentialCommandInput {
  executable: string;
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export interface RemoteCiCredentialCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutOverflow: boolean;
  stderrOverflow: boolean;
  timedOut: boolean;
}

export interface RemoteCiCredentialCommandRunner {
  run(input: RemoteCiCredentialCommandInput): Promise<RemoteCiCredentialCommandResult>;
}

export interface GitLocalAuthorityAdapter {
  effectivePolicy(workspaceId: string): { name: string; allowWrite: boolean };
}

export interface GitLocalMutationAdapter {
  stage(workspaceId: string, paths: string[]): Promise<GitLocalMutationResult>;
  commit(workspaceId: string, message: string): Promise<GitLocalMutationResult>;
  branchCreate(workspaceId: string, name: string): Promise<GitLocalMutationResult>;
  branchSwitch(workspaceId: string, name: string): Promise<GitLocalMutationResult>;
  branchDelete(workspaceId: string, name: string): Promise<GitLocalMutationResult>;
}

export interface GitRemoteAuthorityAdapter {
  effectivePolicy(workspaceId: string): { name: string; allowWrite: boolean; network: string };
}

export interface GitRemoteMutationAdapter {
  fetch(workspaceId: string, remote: string, ref: string): Promise<GitRemoteMutationResult>;
  pull(workspaceId: string, remote: string, ref: string): Promise<GitRemoteMutationResult>;
  push(workspaceId: string, remote: string, ref: string): Promise<GitRemoteMutationResult>;
}

export interface GitHistoryLogAdapterInput {
  workspaceId: string;
  revision: GitRevision;
  path?: string;
  limit: number;
}

export interface GitHistoryShowAdapterInput {
  workspaceId: string;
  revision: GitRevision;
  path?: string;
  includePatch: boolean;
  maxPatchBytes: number;
}

export interface GitHistoryRangeAdapterInput {
  workspaceId: string;
  baseRevision: GitRevision;
  headRevision: GitRevision;
  mode: "direct" | "symmetric";
  limit: number;
}

export interface GitHistoryDiffAdapterInput {
  workspaceId: string;
  baseRevision: GitRevision;
  headRevision: GitRevision;
  path?: string;
  maxPatchBytes: number;
}

export interface GitHistoryAdapter {
  log(input: GitHistoryLogAdapterInput): Promise<GitLogResult>;
  show(input: GitHistoryShowAdapterInput): Promise<GitShowResult>;
  range(input: GitHistoryRangeAdapterInput): Promise<GitRangeResult>;
  diffHistory(input: GitHistoryDiffAdapterInput): Promise<GitDiffHistoryResult>;
}

export interface CapabilityGitCheckpointRecord {
  recordType: "ordinary" | "rename" | "unmerged" | "untracked";
  path: string;
  originalPath?: string;
  indexStatus?: string;
  worktreeStatus?: string;
  headMode?: string;
  indexMode?: string;
  worktreeMode?: string;
  headOid?: string;
  indexOid?: string;
  stage1Oid?: string;
  stage2Oid?: string;
  stage3Oid?: string;
  currentIdentity?: CapabilityPathIdentityResult;
}

export interface CapabilityGitCheckpointResult {
  schemaVersion: 1;
  records: CapabilityGitCheckpointRecord[];
  truncated: boolean;
}

export interface GitCheckpointAdapter {
  checkpoint(workspaceId: string): Promise<CapabilityGitCheckpointResult>;
  checkpointPatch(workspaceId: string): Promise<GitInspectionAdapterResult>;
}

export interface PatchWorkspaceAdapter {
  readFile(
    workspaceId: string,
    path: string,
    options?: { offset?: number; maxBytes?: number }
  ): Promise<{ contents: string; bytesRead: number; eof: boolean }>;
  pathIdentity(workspaceId: string, path: string): Promise<CapabilityPathIdentityResult>;
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
    maxEntries: number,
    scope: "literal" | "semantic"
  ): Promise<CapabilityTreeResult>;
  pathIdentity(workspaceId: string, path: string): Promise<CapabilityPathIdentityResult>;
  effectivePolicy(workspaceId: string): {
    allowProcess: boolean;
    allowedExecutableNames: string[];
  };
}

export interface VerificationAvailabilityAdapter {
  inspectExecutable(
    workspaceId: string,
    logicalExecutable: string
  ): Promise<{ schemaVersion: 1; executableAvailable: boolean; sandboxAvailable: boolean }>;
}

export interface VerificationExecutionAdapter {
  run(input: {
    workspaceId: string;
    recipeId: string;
    logicalExecutable: string;
    argv: string[];
    cwd: string;
    background?: boolean;
  }): Promise<VerificationOperationResult>;
}
