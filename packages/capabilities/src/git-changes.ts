import { createHash } from "node:crypto";

import type {
  CapabilityGitCheckpointRecord,
  GitCheckpointAdapter,
  GitInspectionAdapterResult
} from "./adapters.js";
import {
  CAPABILITY_SCHEMA_VERSION,
  type GitChangedPath,
  type GitChangesInput,
  type GitChangesResult
} from "./contracts.js";
import { CapabilityError } from "./errors.js";

export async function gitChanges(
  adapter: GitCheckpointAdapter,
  input: GitChangesInput
): Promise<GitChangesResult> {
  validateInput(input);

  const checkpoint = await checkpointOrStableError(adapter, input.workspaceId);
  const records = [...checkpoint.records].sort(compareCheckpointRecord);
  const changedPaths = records.map(changedPathFromRecord);
  const canonical = {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    records: records.map(canonicalRecord)
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");

  let patchPreview: string | undefined;
  let patchArtifact: GitChangesResult["patchArtifact"];
  let patchCoverage: GitChangesResult["patchCoverage"];
  let patchTruncated = false;

  if (input.includePatch === true) {
    const patch = await checkpointPatchOrStableError(adapter, input.workspaceId);
    patchPreview = patch.stdoutPreview;
    patchArtifact = {
      uri: patch.artifact.uri,
      bytes: patch.artifact.sizeBytes
    };
    patchCoverage = { staged: true, worktree: true, untracked: false };
    patchTruncated = patch.stdoutTruncated || patch.sourceTruncated;
  }

  const truncated = checkpoint.truncated || patchTruncated;
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    clean: records.length === 0 && !checkpoint.truncated,
    changedPaths,
    summary: { changedFiles: changedPaths.length },
    ...(patchPreview !== undefined ? { patchPreview } : {}),
    ...(patchArtifact !== undefined ? { patchArtifact } : {}),
    ...(patchCoverage !== undefined ? { patchCoverage } : {}),
    truncated,
    fingerprint,
    sourceState: {
      headOid: checkpoint.headOid,
      changesFingerprint: fingerprint
    }
  };
}

async function checkpointOrStableError(
  adapter: GitCheckpointAdapter,
  workspaceId: string
) {
  try {
    return await adapter.checkpoint(workspaceId);
  } catch (error) {
    if (
      isErrorWithCode(error, "RUNTIME_PROTOCOL_INVALID") ||
      isErrorWithCode(error, "GIT_STATUS_INVALID")
    ) {
      throw new CapabilityError("GIT_STATUS_INVALID", "Git checkpoint status is invalid");
    }
    throw new CapabilityError("GIT_INSPECTION_FAILED", "Git checkpoint inspection failed");
  }
}

async function checkpointPatchOrStableError(
  adapter: GitCheckpointAdapter,
  workspaceId: string
): Promise<GitInspectionAdapterResult> {
  try {
    const result = await adapter.checkpointPatch(workspaceId);
    if (result.exitCode !== 0) {
      throw new CapabilityError("GIT_INSPECTION_FAILED", "Git checkpoint patch failed");
    }
    return result;
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw new CapabilityError("GIT_INSPECTION_FAILED", "Git checkpoint patch failed");
  }
}

function changedPathFromRecord(record: CapabilityGitCheckpointRecord): GitChangedPath {
  return {
    path: record.path,
    ...(record.indexStatus !== undefined ? { indexStatus: record.indexStatus } : {}),
    ...(record.worktreeStatus !== undefined ? { worktreeStatus: record.worktreeStatus } : {})
  };
}

function canonicalRecord(record: CapabilityGitCheckpointRecord) {
  return {
    recordType: record.recordType,
    path: record.path,
    originalPath: record.originalPath,
    indexStatus: record.indexStatus,
    worktreeStatus: record.worktreeStatus,
    headMode: record.headMode,
    indexMode: record.indexMode,
    worktreeMode: record.worktreeMode,
    headOid: record.headOid,
    indexOid: record.indexOid,
    stage1Oid: record.stage1Oid,
    stage2Oid: record.stage2Oid,
    stage3Oid: record.stage3Oid,
    currentIdentity: record.currentIdentity
      ? {
          exists: record.currentIdentity.exists,
          kind: record.currentIdentity.kind,
          sizeBytes: record.currentIdentity.sizeBytes,
          sha256: record.currentIdentity.sha256,
          hashTruncated: record.currentIdentity.hashTruncated
        }
      : undefined
  };
}

function compareCheckpointRecord(
  left: CapabilityGitCheckpointRecord,
  right: CapabilityGitCheckpointRecord
): number {
  const path = compareText(left.path, right.path);
  if (path !== 0) return path;
  return compareText(left.recordType, right.recordType);
}

function compareText(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function validateInput(input: GitChangesInput): void {
  if (input.workspaceId.length === 0) {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "git.changes workspaceId must not be empty");
  }
}
