import { createHash } from "node:crypto";

import type { GitInspectionAdapter, GitInspectionAdapterResult } from "./adapters.js";
import {
  CAPABILITY_SCHEMA_VERSION,
  type GitChangedPath,
  type GitChangesInput,
  type GitChangesResult
} from "./contracts.js";

export async function gitChanges(
  adapter: GitInspectionAdapter,
  input: GitChangesInput
): Promise<GitChangesResult> {
  validateInput(input);

  const status = await adapter.gitStatus(input.workspaceId);
  requireSuccessfulInspection(status, "git.status");
  const statusTruncated = status.stdoutTruncated || status.sourceTruncated;
  const changedPaths = parsePorcelainStatus(status.stdoutPreview, status.stdoutTruncated).sort(
    compareChangedPath
  );

  let patchPreview: string | undefined;
  let patchArtifact: GitChangesResult["patchArtifact"];
  let patchTruncated = false;

  if (input.includePatch === true) {
    const diff = await adapter.gitDiff(input.workspaceId);
    requireSuccessfulInspection(diff, "git.diff");
    patchPreview = diff.stdoutPreview;
    patchArtifact = {
      uri: diff.artifact.uri,
      bytes: diff.artifact.sizeBytes
    };
    patchTruncated = diff.stdoutTruncated || diff.sourceTruncated;
  }

  const truncated = statusTruncated || patchTruncated;
  const normalized = {
    changedPaths,
    ...(input.includePatch === true ? { patchPreview } : {}),
    sourceTruncated: truncated
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(normalized), "utf8")
    .digest("hex");

  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    clean: changedPaths.length === 0 && !statusTruncated,
    changedPaths,
    summary: { changedFiles: changedPaths.length },
    ...(patchPreview !== undefined ? { patchPreview } : {}),
    ...(patchArtifact !== undefined ? { patchArtifact } : {}),
    truncated,
    fingerprint
  };
}

function parsePorcelainStatus(stdout: string, trailingPartialAllowed: boolean): GitChangedPath[] {
  const lines = stdout.split("\n");
  if (trailingPartialAllowed && !stdout.endsWith("\n")) {
    lines.pop();
  }

  const changedPaths: GitChangedPath[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.length < 4 || line[2] !== " ") {
      throw new Error("git.status returned malformed porcelain output");
    }

    const indexCode = line[0]!;
    const worktreeCode = line[1]!;
    if (indexCode === "!" && worktreeCode === "!") continue;

    const rawPath = line.slice(3);
    const path = normalizedPorcelainPath(rawPath, indexCode, worktreeCode);
    if (path.length === 0) {
      throw new Error("git.status returned an empty porcelain path");
    }

    if (indexCode === "?" && worktreeCode === "?") {
      changedPaths.push({ path, worktreeStatus: "?" });
      continue;
    }

    changedPaths.push({
      path,
      ...(indexCode !== " " ? { indexStatus: indexCode } : {}),
      ...(worktreeCode !== " " ? { worktreeStatus: worktreeCode } : {})
    });
  }
  return changedPaths;
}

function normalizedPorcelainPath(
  rawPath: string,
  indexCode: string,
  worktreeCode: string
): string {
  const renamed =
    indexCode === "R" || indexCode === "C" || worktreeCode === "R" || worktreeCode === "C";
  return decodeGitQuotedPath(renamed ? renameDestination(rawPath) : rawPath);
}

function renameDestination(rawPath: string): string {
  const separator = rawPath.lastIndexOf(" -> ");
  return separator >= 0 ? rawPath.slice(separator + 4) : rawPath;
}

function decodeGitQuotedPath(rawPath: string): string {
  if (!(rawPath.startsWith('"') && rawPath.endsWith('"'))) {
    return rawPath;
  }

  const body = rawPath.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }

    index += 1;
    if (index >= body.length) {
      throw new Error("git.status returned malformed quoted path");
    }
    const escaped = body[index]!;
    if (escaped >= "0" && escaped <= "7") {
      let octal = escaped;
      for (let count = 0; count < 2; count++) {
        const next = body[index + 1];
        if (next === undefined || next < "0" || next > "7") break;
        octal += next;
        index += 1;
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }

    const mapped = escaped === "t" ? "\t" : escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped;
    bytes.push(...Buffer.from(mapped, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

function compareChangedPath(left: GitChangedPath, right: GitChangedPath): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function requireSuccessfulInspection(result: GitInspectionAdapterResult, operation: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`${operation} failed with exit code ${result.exitCode}`);
  }
}

function validateInput(input: GitChangesInput): void {
  if (input.workspaceId.length === 0) {
    throw new TypeError("git.changes workspaceId must not be empty");
  }
}
