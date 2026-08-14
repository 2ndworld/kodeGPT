import type { GitHistoryAdapter } from "./adapters.js";
import {
  DEFAULT_GIT_LOG_LIMIT,
  DEFAULT_GIT_PATCH_BYTES,
  DEFAULT_GIT_RANGE_LIMIT,
  MAX_GIT_HISTORY_RESPONSE_BYTES,
  type GitDiffHistoryInput,
  type GitDiffHistoryResult,
  type GitLogInput,
  type GitLogResult,
  type GitRangeInput,
  type GitRangeResult,
  type GitShowInput,
  type GitShowResult
} from "./contracts.js";
import { CapabilityError, type CapabilityErrorCode } from "./errors.js";
import {
  GitDiffHistoryInputSchema,
  GitDiffHistoryResultSchema,
  GitLogInputSchema,
  GitLogResultSchema,
  GitRangeInputSchema,
  GitRangeResultSchema,
  GitShowInputSchema,
  GitShowResultSchema
} from "./schemas.js";

const STABLE_HISTORY_CODES = new Set<CapabilityErrorCode>([
  "WORKSPACE_NOT_READY",
  "GIT_UNAVAILABLE",
  "NOT_A_GIT_REPOSITORY",
  "REVISION_INVALID",
  "REVISION_NOT_FOUND",
  "OBJECT_TYPE_UNSUPPORTED",
  "PATH_INVALID",
  "OUTPUT_LIMIT_EXCEEDED",
  "PROCESS_TIMEOUT",
  "GIT_READ_FAILED"
]);

function normalizeError(error: unknown): never {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    STABLE_HISTORY_CODES.has((error as { code: CapabilityErrorCode }).code)
  ) {
    const code = (error as { code: CapabilityErrorCode }).code;
    throw new CapabilityError(code, "Git history operation failed");
  }
  throw new CapabilityError("CAPABILITY_INTERNAL", "Native capability failed");
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const codePoints = Array.from(value);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(codePoints.slice(0, mid).join(""), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return codePoints.slice(0, low).join("");
}

function fitString<T>(candidate: T, get: (value: T) => string, set: (value: T, text: string) => T): T {
  if (serializedBytes(candidate) <= MAX_GIT_HISTORY_RESPONSE_BYTES) return candidate;
  const original = get(candidate);
  let low = 0;
  let high = Buffer.byteLength(original, "utf8");
  let best = set(candidate, "");
  if (serializedBytes(best) > MAX_GIT_HISTORY_RESPONSE_BYTES) return best;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const trial = set(candidate, utf8Prefix(original, mid));
    if (serializedBytes(trial) <= MAX_GIT_HISTORY_RESPONSE_BYTES) {
      best = trial;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function markResponseLimit<T extends { truncated: boolean; truncationReasons: string[] }>(value: T): T {
  return {
    ...value,
    truncated: true,
    truncationReasons: value.truncationReasons.includes("RESPONSE_LIMIT")
      ? value.truncationReasons
      : [...value.truncationReasons, "RESPONSE_LIMIT"]
  };
}

function ensureLogOrRangeBudget<T>(value: T): T {
  if (serializedBytes(value) <= MAX_GIT_HISTORY_RESPONSE_BYTES) return value;
  throw new CapabilityError("OUTPUT_LIMIT_EXCEEDED", "Git history response exceeded the public limit");
}

function ensureShowBudget(value: GitShowResult): GitShowResult {
  if (serializedBytes(value) <= MAX_GIT_HISTORY_RESPONSE_BYTES) return value;
  let candidate = markResponseLimit(value);
  candidate = fitString(
    candidate,
    (current) => current.commit.body,
    (current, body) => ({ ...current, commit: { ...current.commit, body, messageTruncated: true } })
  );
  if (serializedBytes(candidate) <= MAX_GIT_HISTORY_RESPONSE_BYTES) return candidate;
  if (candidate.patch !== null) {
    candidate = fitString(
      candidate,
      (current) => current.patch ?? "",
      (current, patch) => ({ ...current, patch })
    );
  }
  if (serializedBytes(candidate) <= MAX_GIT_HISTORY_RESPONSE_BYTES) return candidate;
  throw new CapabilityError("OUTPUT_LIMIT_EXCEEDED", "Git history response exceeded the public limit");
}

function ensureDiffBudget(value: GitDiffHistoryResult): GitDiffHistoryResult {
  if (serializedBytes(value) <= MAX_GIT_HISTORY_RESPONSE_BYTES) return value;
  let candidate = markResponseLimit(value);
  candidate = fitString(candidate, (current) => current.patch, (current, patch) => ({ ...current, patch }));
  if (serializedBytes(candidate) <= MAX_GIT_HISTORY_RESPONSE_BYTES) return candidate;
  throw new CapabilityError("OUTPUT_LIMIT_EXCEEDED", "Git history response exceeded the public limit");
}

export async function gitLog(adapter: GitHistoryAdapter, input: GitLogInput): Promise<GitLogResult> {
  const parsed = GitLogInputSchema.parse(input);
  try {
    const result = await adapter.log({
      ...parsed,
      revision: parsed.revision ?? { kind: "head" },
      limit: parsed.limit ?? DEFAULT_GIT_LOG_LIMIT
    });
    return ensureLogOrRangeBudget(GitLogResultSchema.parse(result));
  } catch (error) {
    normalizeError(error);
  }
}

export async function gitShow(adapter: GitHistoryAdapter, input: GitShowInput): Promise<GitShowResult> {
  const parsed = GitShowInputSchema.parse(input);
  try {
    const result = await adapter.show({
      ...parsed,
      revision: parsed.revision ?? { kind: "head" },
      includePatch: parsed.includePatch ?? false,
      maxPatchBytes: parsed.maxPatchBytes ?? DEFAULT_GIT_PATCH_BYTES
    });
    return ensureShowBudget(GitShowResultSchema.parse(result));
  } catch (error) {
    normalizeError(error);
  }
}

export async function gitRange(adapter: GitHistoryAdapter, input: GitRangeInput): Promise<GitRangeResult> {
  const parsed = GitRangeInputSchema.parse(input);
  try {
    const result = await adapter.range({
      ...parsed,
      mode: parsed.mode ?? "direct",
      limit: parsed.limit ?? DEFAULT_GIT_RANGE_LIMIT
    });
    return ensureLogOrRangeBudget(GitRangeResultSchema.parse(result));
  } catch (error) {
    normalizeError(error);
  }
}

export async function gitDiffHistory(
  adapter: GitHistoryAdapter,
  input: GitDiffHistoryInput
): Promise<GitDiffHistoryResult> {
  const parsed = GitDiffHistoryInputSchema.parse(input);
  try {
    const result = await adapter.diffHistory({
      ...parsed,
      maxPatchBytes: parsed.maxPatchBytes ?? DEFAULT_GIT_PATCH_BYTES
    });
    return ensureDiffBudget(GitDiffHistoryResultSchema.parse(result));
  } catch (error) {
    normalizeError(error);
  }
}
