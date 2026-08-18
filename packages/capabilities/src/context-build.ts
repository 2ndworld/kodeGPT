import {
  DEFAULT_CONTEXT_MAX_BYTES,
  MAX_CONTEXT_MAX_BYTES,
  type CodeSearchInput,
  type CodeSearchResult,
  type ContextBuildInput,
  type ContextBuildResult,
  type ContextEvidenceState,
  type ContextIntent,
  type ContextSelectedFile,
  type GitChangesInput,
  type GitChangesResult,
  type VerificationRecipe,
  type VerifyListInput,
  type VerifyListResult,
  type WorkspaceInspectInput,
  type WorkspaceInspectResult
} from "./contracts.js";
import { CapabilityError } from "./errors.js";
import { isSemanticDiscoveryPath } from "./semantic-scope.js";

export const INTENT_WEIGHTS = {
  understand: { target: 100, changed: 40, tests: 20, config: 50, search: 30 },
  implement: { target: 100, changed: 60, tests: 70, config: 50, search: 40 },
  debug: { target: 100, changed: 80, tests: 80, config: 40, search: 60 },
  review: { target: 80, changed: 100, tests: 60, config: 40, search: 50 },
  verify: { target: 60, changed: 80, tests: 100, config: 60, search: 40 }
} as const;

type CandidateKind = "target" | "changed" | "config" | "search" | "tests";

type Candidate = {
  path: string;
  reason: string;
  kind: CandidateKind;
  score: number;
};

type EvidenceResult<T> =
  | { state: Exclude<ContextEvidenceState, "unavailable">; value: T }
  | { state: "unavailable" };

const GIT_EVIDENCE_UNAVAILABLE_CODES = new Set([
  "GIT_INSPECTION_FAILED",
  "GIT_UNAVAILABLE",
  "NOT_A_GIT_REPOSITORY"
]);
const SEARCH_EVIDENCE_UNAVAILABLE_CODES = new Set(["CAPABILITY_SOURCE_INCOMPLETE"]);
const VERIFICATION_EVIDENCE_UNAVAILABLE_CODES = new Set(["VERIFICATION_DISCOVERY_INVALID"]);

const TIER_BASE: Record<CandidateKind, number> = {
  target: 5_000,
  changed: 4_000,
  config: 3_000,
  search: 2_000,
  tests: 1_000
};

export interface ContextBuildAdapter {
  inspect(input: WorkspaceInspectInput): Promise<WorkspaceInspectResult>;
  git(input: GitChangesInput): Promise<GitChangesResult>;
  search(input: CodeSearchInput): Promise<CodeSearchResult>;
  verify(input: VerifyListInput): Promise<VerifyListResult>;
  readFile(
    workspaceId: string,
    path: string,
    options?: { offset?: number; maxBytes?: number }
  ): Promise<{ contents: string; bytesRead: number; eof: boolean }>;
}

export async function buildContext(
  adapter: ContextBuildAdapter,
  input: ContextBuildInput
): Promise<ContextBuildResult> {
  validateInput(input);
  const maxBytes = input.maxBytes ?? DEFAULT_CONTEXT_MAX_BYTES;

  const workspace = await adapter.inspect({ workspaceId: input.workspaceId });
  const gitEvidence = await collectGitEvidence(adapter, input.workspaceId);
  const searchEvidence = await collectSearchEvidence(adapter, input);
  const verificationEvidence = await collectVerificationEvidence(adapter, input.workspaceId);
  const git = gitEvidence.state === "unavailable" ? undefined : gitEvidence.value;
  const search = searchEvidence.state === "unavailable" ? emptySearchResult() : searchEvidence.value;
  const verifications =
    verificationEvidence.state === "unavailable" ? [] : verificationEvidence.value.recipes;

  const candidates = selectCandidates(workspace, git, search, input.intent, input.target);
  const relevantMatches = sortedMatches(
    search.matches.filter(
      (match) => match.path === input.target || isSemanticDiscoveryPath(match.path)
    )
  );
  const warnings = [...workspace.warnings];
  if (gitEvidence.state === "unavailable") warnings.push("git-evidence-unavailable");
  else if (gitEvidence.value.truncated) warnings.push("git-change-evidence-truncated");
  if (searchEvidence.state === "unavailable") warnings.push("search-evidence-unavailable");
  else if (searchEvidence.value.truncated) warnings.push("search-evidence-truncated");
  if (verificationEvidence.state === "unavailable") {
    warnings.push("verification-evidence-unavailable");
  }

  let totalBytes = 0;
  let truncated =
    workspace.truncated ||
    gitEvidence.state !== "available" ||
    searchEvidence.state !== "available" ||
    verificationEvidence.state !== "available";
  const selectedFiles: ContextSelectedFile[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const remaining = maxBytes - totalBytes;
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    try {
      const read = await adapter.readFile(input.workspaceId, candidate.path, {
        offset: 0,
        maxBytes: remaining
      });
      const actualBytes = Buffer.byteLength(read.contents, "utf8");
      if (actualBytes !== read.bytesRead || actualBytes > remaining) {
        warnings.push(`invalid-read-result:${candidate.path}`);
        truncated = true;
        continue;
      }
      selectedFiles.push({
        path: candidate.path,
        reason: candidate.reason,
        content: read.contents,
        truncated: !read.eof
      });
      totalBytes += actualBytes;
      if (!read.eof) truncated = true;
    } catch {
      selectedFiles.push({
        path: candidate.path,
        reason: candidate.reason,
        truncated: false
      });
      warnings.push(`unreadable:${candidate.path}`);
      truncated = true;
    }

    if (totalBytes >= maxBytes && index + 1 < candidates.length) {
      truncated = true;
      break;
    }
  }

  return {
    schemaVersion: 1,
    intent: input.intent,
    ...(input.target === undefined ? {} : { target: input.target }),
    evidenceStatus: {
      workspace: workspace.truncated ? "incomplete" : "available",
      git: gitEvidence.state,
      search: searchEvidence.state,
      verification: verificationEvidence.state
    },
    workspace,
    ...(git === undefined ? {} : { git }),
    selectedFiles,
    relevantMatches,
    verifications: sortedVerifications(verifications),
    warnings: [...new Set(warnings)],
    totalBytes,
    truncated
  };
}

async function collectGitEvidence(
  adapter: ContextBuildAdapter,
  workspaceId: string
): Promise<EvidenceResult<GitChangesResult>> {
  try {
    const value = await adapter.git({ workspaceId, includePatch: false });
    return { state: value.truncated ? "incomplete" : "available", value };
  } catch (error) {
    if (isKnownSourceFailure(error, GIT_EVIDENCE_UNAVAILABLE_CODES)) return { state: "unavailable" };
    throw error;
  }
}

async function collectSearchEvidence(
  adapter: ContextBuildAdapter,
  input: ContextBuildInput
): Promise<EvidenceResult<CodeSearchResult>> {
  if (input.target === undefined) return { state: "available", value: emptySearchResult() };
  try {
    const value = await adapter.search({
      workspaceId: input.workspaceId,
      query: targetQuery(input.target),
      mode: "path",
      maxResults: 100
    });
    return { state: value.truncated ? "incomplete" : "available", value };
  } catch (error) {
    if (isKnownSourceFailure(error, SEARCH_EVIDENCE_UNAVAILABLE_CODES)) {
      return { state: "unavailable" };
    }
    throw error;
  }
}

async function collectVerificationEvidence(
  adapter: ContextBuildAdapter,
  workspaceId: string
): Promise<EvidenceResult<VerifyListResult>> {
  try {
    const value = await adapter.verify({ workspaceId });
    return { state: "available", value };
  } catch (error) {
    if (isKnownSourceFailure(error, VERIFICATION_EVIDENCE_UNAVAILABLE_CODES)) {
      return { state: "unavailable" };
    }
    throw error;
  }
}

function isKnownSourceFailure(error: unknown, codes: ReadonlySet<string>): boolean {
  return error instanceof CapabilityError && codes.has(error.code);
}

function selectCandidates(
  workspace: WorkspaceInspectResult,
  git: GitChangesResult | undefined,
  search: CodeSearchResult,
  intent: ContextIntent,
  target: string | undefined
): Candidate[] {
  const byPath = new Map<string, Candidate>();
  const targetArea = target === undefined ? undefined : resolveTargetArea(workspace, target);

  const add = (path: string, reason: string, kind: CandidateKind) => {
    if (!isSafeRelativePath(path)) return;
    if (kind !== "target" && !isSemanticDiscoveryPath(path)) return;
    const candidate = {
      path,
      reason,
      kind,
      score: TIER_BASE[kind] + INTENT_WEIGHTS[intent][kind]
    };
    const current = byPath.get(path);
    if (
      current === undefined ||
      candidate.score > current.score ||
      (candidate.score === current.score && candidate.reason < current.reason)
    ) {
      byPath.set(path, candidate);
    }
  };

  if (target !== undefined) add(target, "exact-target", "target");

  for (const changed of git?.changedPaths ?? []) {
    if (target === undefined || sameArea(changed.path, targetArea)) {
      add(changed.path, "changed-same-area", "changed");
    }
  }

  for (const manifest of workspace.manifests) {
    if (target === undefined || governsTarget(manifest.path, target)) {
      add(manifest.path, "governing-manifest", "config");
    }
  }

  for (const match of search.matches) {
    if (target !== undefined && match.path === target) continue;
    if (isTestPath(match.path)) {
      add(match.path, "nearby-test", "tests");
    } else {
      add(match.path, "exact-search-hit", "search");
    }
  }

  return [...byPath.values()].sort(
    (left, right) => right.score - left.score || compareLexical(left.path, right.path)
  );
}

function resolveTargetArea(workspace: WorkspaceInspectResult, target: string): string {
  const matches = workspace.areas
    .map((area) => area.path)
    .filter((area) => target === area || target.startsWith(`${area}/`))
    .sort((left, right) => right.length - left.length || compareLexical(left, right));
  return matches[0] ?? dirname(target);
}

function sameArea(path: string, area: string | undefined): boolean {
  if (area === undefined || area === ".") return true;
  return path === area || path.startsWith(`${area}/`);
}

function governsTarget(manifestPath: string, target: string): boolean {
  const directory = dirname(manifestPath);
  return directory === "." || target === directory || target.startsWith(`${directory}/`);
}

function targetQuery(target: string): string {
  const name = target.slice(target.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "." : path.slice(0, index);
}

function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__)(\/|$)/.test(path) || /\.(test|spec)\.[^/]+$/.test(path);
}

function sortedMatches(matches: CodeSearchResult["matches"]): CodeSearchResult["matches"] {
  return [...matches].sort(
    (left, right) =>
      compareLexical(left.path, right.path) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      (left.column ?? 0) - (right.column ?? 0) ||
      compareLexical(left.kind, right.kind)
  );
}

function sortedVerifications(recipes: VerificationRecipe[]): VerificationRecipe[] {
  return [...recipes].sort((left, right) => compareLexical(left.id, right.id));
}

function emptySearchResult(): CodeSearchResult {
  return {
    schemaVersion: 1,
    mode: "path",
    precision: "lexical",
    matches: [],
    truncated: false,
    truncationReasons: []
  };
}

function validateInput(input: ContextBuildInput): void {
  if (input.workspaceId.length === 0) {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Context workspaceId must not be empty");
  }
  if (!["understand", "implement", "debug", "review", "verify"].includes(input.intent)) {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Context intent is unsupported");
  }
  if (input.target !== undefined && !isSafeRelativePath(input.target)) {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Context target must be a safe relative path");
  }
  if (
    input.maxBytes !== undefined &&
    (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0 || input.maxBytes > MAX_CONTEXT_MAX_BYTES)
  ) {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Context maxBytes is outside the supported range");
  }
}

function isSafeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\0") &&
    !path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  );
}

function compareLexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
