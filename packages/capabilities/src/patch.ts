import { createHash } from "node:crypto";

import type { PatchCommitAdapter, PatchWorkspaceAdapter } from "./adapters.js";
import {
  MAX_PATCH_BYTES,
  MAX_PATCH_FILES,
  MAX_PATCH_HUNKS,
  type FilePatchFileResult,
  type FilePatchInput,
  type FilePatchResult,
  type PatchFileAction
} from "./contracts.js";
import { CapabilityError } from "./errors.js";

type PatchLine = { kind: "context" | "remove" | "add"; text: string };

type ParsedHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: PatchLine[];
};

type ParsedFile = {
  path: string;
  action: PatchFileAction;
  hunks: ParsedHunk[];
};

type PreflightFile = {
  path: string;
  action: PatchFileAction;
  expectedSha256: string | null;
  postImage: string | null;
  resultingSha256: string | null;
  bytes: number;
};

export async function patchFile(
  workspace: PatchWorkspaceAdapter,
  commit: PatchCommitAdapter,
  input: FilePatchInput
): Promise<FilePatchResult> {
  if (input.workspaceId.length === 0 || input.patch.length === 0) {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Patch input must not be empty");
  }
  if (Buffer.byteLength(input.patch, "utf8") > MAX_PATCH_BYTES) {
    throw new CapabilityError("CAPABILITY_LIMIT_EXCEEDED", "Patch exceeds the maximum byte limit");
  }

  const mode = input.mode ?? "check";
  if (mode !== "check" && mode !== "apply") {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Patch mode must be check or apply");
  }
  const parsed = parseUnifiedPatch(input.patch);
  const plans = await preflightAll(workspace, input.workspaceId, parsed);
  const files: FilePatchFileResult[] = plans.map((plan) => ({
    path: plan.path,
    action: plan.action,
    expectedSha256: plan.expectedSha256,
    resultingSha256: plan.resultingSha256,
    bytes: plan.bytes,
    committed: false
  }));

  if (mode === "check") {
    return {
      schemaVersion: 1,
      workspaceId: input.workspaceId,
      mode,
      files,
      committedPaths: []
    };
  }

  const committedPaths: string[] = [];
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index]!;
    try {
      const result = await commit.commitPatchFile({
        workspaceId: input.workspaceId,
        path: plan.path,
        action: plan.action,
        expectedSha256: plan.expectedSha256,
        content: plan.postImage
      });
      if (
        result.schemaVersion !== 1 ||
        result.action !== plan.action ||
        result.bytesWritten !== plan.bytes ||
        result.sha256 !== plan.resultingSha256
      ) {
        throw new Error("Patch commit result did not match the preflight plan");
      }
      files[index] = { ...files[index]!, committed: true };
      committedPaths.push(plan.path);
    } catch {
      throw new CapabilityError(
        "PATCH_COMMIT_INCOMPLETE",
        "Patch commit stopped before all files were committed",
        { committedPaths: [...committedPaths], failedPath: plan.path }
      );
    }
  }

  return {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    mode,
    files,
    committedPaths
  };
}

function parseUnifiedPatch(patch: string): ParsedFile[] {
  for (const marker of ["GIT binary patch", "Binary files ", "rename from ", "rename to ", "copy from ", "copy to "]) {
    if (patch.includes(marker)) {
      throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Patch contains unsupported metadata");
    }
  }

  const lines = splitLinesPreservingEndings(patch);
  const files: ParsedFile[] = [];
  const seenPaths = new Set<string>();
  let totalHunks = 0;
  let index = 0;

  while (index < lines.length) {
    const control = controlText(lines[index]!);
    if (control.length === 0) {
      index += 1;
      continue;
    }
    if (control.startsWith("diff --git ")) {
      index += 1;
      continue;
    }
    if (!control.startsWith("--- ")) {
      throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Patch file header is malformed");
    }
    const oldPath = parseHeaderPath(control, "--- ", "old");
    index += 1;
    if (index >= lines.length || !controlText(lines[index]!).startsWith("+++ ")) {
      throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Patch is missing the new-file header");
    }
    const newPath = parseHeaderPath(controlText(lines[index]!), "+++ ", "new");
    index += 1;

    const { path, action } = resolveFileAction(oldPath, newPath);
    if (seenPaths.has(path)) {
      throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Patch contains the same path more than once");
    }
    seenPaths.add(path);
    if (files.length + 1 > MAX_PATCH_FILES) {
      throw new CapabilityError("CAPABILITY_LIMIT_EXCEEDED", "Patch exceeds the maximum file count");
    }

    const hunks: ParsedHunk[] = [];
    while (index < lines.length && controlText(lines[index]!).startsWith("@@")) {
      if (totalHunks + 1 > MAX_PATCH_HUNKS) {
        throw new CapabilityError("CAPABILITY_LIMIT_EXCEEDED", "Patch exceeds the maximum hunk count");
      }
      const parsed = parseHunk(lines, index);
      hunks.push(parsed.hunk);
      totalHunks += 1;
      index = parsed.nextIndex;
    }
    if (hunks.length === 0) {
      throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Patch file contains no hunks");
    }
    files.push({ path, action, hunks });
  }

  if (files.length === 0) {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Patch contains no files");
  }
  return files;
}

function parseHunk(lines: string[], startIndex: number): { hunk: ParsedHunk; nextIndex: number } {
  const header = controlText(lines[startIndex]!);
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(header);
  if (match === null) {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Patch hunk range is malformed");
  }
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  if (
    ![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger) ||
    oldCount < 0 ||
    newCount < 0 ||
    (oldCount === 0 ? oldStart < 0 : oldStart < 1) ||
    (newCount === 0 ? newStart < 0 : newStart < 1)
  ) {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Patch hunk range is invalid");
  }

  let oldSeen = 0;
  let newSeen = 0;
  let index = startIndex + 1;
  const body: PatchLine[] = [];
  while (oldSeen < oldCount || newSeen < newCount) {
    if (index >= lines.length) {
      throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Patch hunk body is truncated");
    }
    const raw = lines[index]!;
    if (raw.startsWith("\\ No newline at end of file")) {
      throw new CapabilityError("CAPABILITY_INPUT_INVALID", "No-newline patch markers are unsupported in v1");
    }
    const prefix = raw[0];
    const text = raw.slice(1);
    if (prefix === " ") {
      oldSeen += 1;
      newSeen += 1;
      body.push({ kind: "context", text });
    } else if (prefix === "-") {
      oldSeen += 1;
      body.push({ kind: "remove", text });
    } else if (prefix === "+") {
      newSeen += 1;
      body.push({ kind: "add", text });
    } else {
      throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Patch hunk contains an invalid line prefix");
    }
    if (oldSeen > oldCount || newSeen > newCount) {
      throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Patch hunk line counts exceed the declared range");
    }
    index += 1;
  }
  return {
    hunk: { oldStart, oldCount, newStart, newCount, lines: body },
    nextIndex: index
  };
}

async function preflightAll(
  workspace: PatchWorkspaceAdapter,
  workspaceId: string,
  parsedFiles: ParsedFile[]
): Promise<PreflightFile[]> {
  const plans: PreflightFile[] = [];
  for (const parsed of parsedFiles) {
    let identity;
    try {
      identity = await workspace.pathIdentity(workspaceId, parsed.path);
    } catch {
      throw precondition(parsed.path);
    }

    let current = "";
    let expectedSha256: string | null = null;
    if (parsed.action === "create") {
      if (identity.exists) throw precondition(parsed.path);
    } else {
      if (
        !identity.exists ||
        identity.kind !== "file" ||
        identity.hashTruncated ||
        (identity.sizeBytes !== undefined && identity.sizeBytes > MAX_PATCH_BYTES)
      ) {
        throw precondition(parsed.path);
      }
      let read;
      try {
        read = await workspace.readFile(workspaceId, parsed.path, { offset: 0, maxBytes: MAX_PATCH_BYTES });
      } catch {
        throw precondition(parsed.path);
      }
      if (!read.eof || read.bytesRead !== Buffer.byteLength(read.contents, "utf8")) {
        throw precondition(parsed.path);
      }
      current = read.contents;
      expectedSha256 = sha256(current);
    }

    let next: string;
    try {
      next = applyHunks(current, parsed.hunks);
    } catch (error) {
      if (error instanceof CapabilityError) throw error;
      throw precondition(parsed.path);
    }
    if (parsed.action === "delete" && next !== "") {
      throw precondition(parsed.path);
    }

    const postImage = parsed.action === "delete" ? null : next;
    plans.push({
      path: parsed.path,
      action: parsed.action,
      expectedSha256,
      postImage,
      resultingSha256: postImage === null ? null : sha256(postImage),
      bytes: postImage === null ? 0 : Buffer.byteLength(postImage, "utf8")
    });
  }
  return plans.sort((left, right) => compareBytes(left.path, right.path));
}

function applyHunks(current: string, hunks: ParsedHunk[]): string {
  const source = splitLinesPreservingEndings(current);
  const output: string[] = [];
  let sourceCursor = 0;
  let cumulativeDelta = 0;

  for (const hunk of hunks) {
    const oldTarget = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    const newTarget = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    if (newTarget !== oldTarget + cumulativeDelta || oldTarget < sourceCursor || oldTarget > source.length) {
      throw preconditionError("Patch hunk position does not match current content");
    }
    output.push(...source.slice(sourceCursor, oldTarget));
    sourceCursor = oldTarget;

    for (const line of hunk.lines) {
      if (line.kind === "add") {
        output.push(line.text);
        continue;
      }
      if (source[sourceCursor] !== line.text) {
        throw preconditionError("Patch hunk text does not match current content");
      }
      if (line.kind === "context") output.push(line.text);
      sourceCursor += 1;
    }
    cumulativeDelta += hunk.newCount - hunk.oldCount;
  }
  output.push(...source.slice(sourceCursor));
  return output.join("");
}

function parseHeaderPath(line: string, prefix: "--- " | "+++ ", side: "old" | "new"): string | null {
  const raw = line.slice(prefix.length);
  if (raw.includes("\t")) {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Patch header timestamps are unsupported in v1");
  }
  if (raw === "/dev/null") return null;
  const expectedPrefix = side === "old" ? "a/" : "b/";
  if (!raw.startsWith(expectedPrefix)) {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Patch path must use canonical a/ and b/ prefixes");
  }
  const path = raw.slice(2);
  validatePatchPath(path);
  return path;
}

function resolveFileAction(
  oldPath: string | null,
  newPath: string | null
): { path: string; action: PatchFileAction } {
  if (oldPath === null && newPath !== null) return { path: newPath, action: "create" };
  if (oldPath !== null && newPath === null) return { path: oldPath, action: "delete" };
  if (oldPath !== null && newPath !== null && oldPath === newPath) {
    return { path: oldPath, action: "update" };
  }
  throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Patch rename/copy operations are unsupported in v1");
}

function validatePatchPath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Patch path is not a safe relative path");
  }
}

function splitLinesPreservingEndings(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") {
      result.push(value.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < value.length) result.push(value.slice(start));
  return result;
}

function controlText(line: string): string {
  if (line.endsWith("\r\n")) return line.slice(0, -2);
  return line.endsWith("\n") ? line.slice(0, -1) : line;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareBytes(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function precondition(path: string): CapabilityError {
  return preconditionError(`Patch precondition failed for ${path}`);
}

function preconditionError(message: string): CapabilityError {
  return new CapabilityError("PATCH_PRECONDITION_FAILED", message, {
    reason: "STALE_EXPECTED_STATE",
    retryable: false,
    suggestedAction: "refresh-state"
  });
}
