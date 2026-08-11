export const CAPABILITY_SCHEMA_VERSION = 1 as const;
export const DEFAULT_CONTEXT_MAX_BYTES = 256 * 1024;
export const MAX_CONTEXT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_INSPECT_MAX_ENTRIES = 2_000;
export const MAX_INSPECT_MAX_ENTRIES = 10_000;
export const DEFAULT_SEARCH_MAX_RESULTS = 100;
export const MAX_SEARCH_MAX_RESULTS = 500;
export const MAX_PATCH_BYTES = 1024 * 1024;
export const MAX_PATCH_FILES = 64;
export const MAX_PATCH_HUNKS = 256;

export type CodeSearchMode = "text" | "path" | "symbol" | "definition" | "reference";
export type CodeSearchPrecision = "exact" | "lexical" | "heuristic";
export type CodeSearchTruncationReason =
  | "TREE_LIMIT"
  | "FILE_SIZE_LIMIT"
  | "SCAN_BYTE_LIMIT"
  | "MATCH_LIMIT"
  | "SNIPPET_BYTE_LIMIT";
export type ContextIntent = "understand" | "implement" | "debug" | "review" | "verify";
export type VerificationCategory =
  | "test"
  | "lint"
  | "typecheck"
  | "build"
  | "format-check"
  | "custom";
export type VerificationSource = "package-script" | "cargo" | "kodegpt-config";
export type VerificationOperationState = "running" | "completed" | "failed" | "cancelled";
export type WorkspaceInspectAreaKind =
  | "app"
  | "package"
  | "crate"
  | "test"
  | "config"
  | "docs"
  | "other";
export type FilePatchMode = "check" | "apply";
export type PatchFileAction = "create" | "update" | "delete";

export interface CapabilityArtifactMetadata {
  schemaVersion: 1;
  uri: `artifact://${string}`;
  mediaType: string;
  sizeBytes: number;
  sourceTruncated: boolean;
}

export interface WorkspaceInspectInput {
  workspaceId: string;
  path?: string;
  maxEntries?: number;
}

export interface WorkspaceInspectLanguage {
  name: string;
  fileCount: number;
}

export interface WorkspaceInspectEntrypoint {
  path: string;
  kind: string;
}

export interface WorkspaceInspectArea {
  path: string;
  kind: WorkspaceInspectAreaKind;
}

export interface WorkspaceInspectManifest {
  path: string;
  kind: string;
}

export interface WorkspaceInspectResult {
  schemaVersion: 1;
  workspaceId: string;
  root: string;
  projectTypes: string[];
  languages: WorkspaceInspectLanguage[];
  entrypoints: WorkspaceInspectEntrypoint[];
  areas: WorkspaceInspectArea[];
  manifests: WorkspaceInspectManifest[];
  warnings: string[];
  truncated: boolean;
}

export interface CodeSearchInput {
  workspaceId: string;
  query: string;
  mode?: CodeSearchMode;
  path?: string;
  maxResults?: number;
}

export interface CodeSearchMatch {
  path: string;
  line?: number;
  column?: number;
  kind: CodeSearchMode;
  preview?: string;
}

export interface CodeSearchResult {
  schemaVersion: 1;
  mode: CodeSearchMode;
  precision: CodeSearchPrecision;
  matches: CodeSearchMatch[];
  truncated: boolean;
  truncationReasons: CodeSearchTruncationReason[];
}

export interface GitChangesInput {
  workspaceId: string;
  includePatch?: boolean;
}

export interface GitChangedPath {
  path: string;
  indexStatus?: string;
  worktreeStatus?: string;
}

export interface GitChangesSummary {
  changedFiles: number;
  insertions?: number;
  deletions?: number;
}

export interface GitPatchArtifact {
  uri: string;
  bytes: number;
}

export interface GitPatchCoverage {
  staged: true;
  worktree: true;
  untracked: false;
}

export interface GitChangesResult {
  schemaVersion: 1;
  workspaceId: string;
  clean: boolean;
  changedPaths: GitChangedPath[];
  summary: GitChangesSummary;
  patchPreview?: string;
  patchArtifact?: GitPatchArtifact;
  patchCoverage?: GitPatchCoverage;
  truncated: boolean;
  fingerprint: string;
}

export interface VerificationRecipe {
  id: string;
  label: string;
  category: VerificationCategory;
  logicalExecutable?: string;
  argv?: string[];
  cwd?: string;
  source: VerificationSource;
  allowed: boolean;
  blockedReason?: string;
}

export interface VerifyListInput {
  workspaceId: string;
}

export interface VerifyListResult {
  schemaVersion: 1;
  workspaceId: string;
  recipes: VerificationRecipe[];
}

export interface VerifyRunInput {
  workspaceId: string;
  recipeId: string;
  background?: boolean;
}

export interface VerificationOperationResult {
  schemaVersion: 1;
  operationId: string;
  state: VerificationOperationState;
  exitCode?: number;
  stdoutPreview: string;
  stderrPreview: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  sourceTruncated: boolean;
  bytesSpooled: number;
  artifact: CapabilityArtifactMetadata;
}

export interface VerifyRunResult {
  schemaVersion: 1;
  workspaceId: string;
  recipe: VerificationRecipe;
  operation: VerificationOperationResult;
}

export interface FilePatchInput {
  workspaceId: string;
  patch: string;
  mode?: FilePatchMode;
}

export interface FilePatchFileResult {
  path: string;
  action: PatchFileAction;
  expectedSha256: string | null;
  resultingSha256: string | null;
  bytes: number;
  committed: boolean;
}

export interface FilePatchResult {
  schemaVersion: 1;
  workspaceId: string;
  mode: FilePatchMode;
  files: FilePatchFileResult[];
  committedPaths: string[];
}

export interface ContextBuildInput {
  workspaceId: string;
  intent: ContextIntent;
  target?: string;
  maxBytes?: number;
}

export interface ContextSelectedFile {
  path: string;
  reason: string;
  content?: string;
  truncated: boolean;
}

export interface ContextBuildResult {
  schemaVersion: 1;
  intent: ContextIntent;
  target?: string;
  workspace: WorkspaceInspectResult;
  git: GitChangesResult;
  selectedFiles: ContextSelectedFile[];
  relevantMatches: CodeSearchResult["matches"];
  verifications: VerificationRecipe[];
  warnings: string[];
  totalBytes: number;
  truncated: boolean;
}
