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
  type ContextWorkspaceSummary,
  type GitChangesInput,
  type GitChangesResult,
  type SourceRegion,
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

type CandidateKind =
  | "target"
  | "relatedTest"
  | "dependency"
  | "dependent"
  | "changed"
  | "config"
  | "search"
  | "tests";

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
  target: 8_000,
  relatedTest: 7_000,
  dependency: 6_500,
  dependent: 6_000,
  changed: 5_000,
  config: 4_000,
  search: 3_000,
  tests: 2_000
};
const TARGET_FILE_BUDGET_SHARE = 0.5;
const NON_TARGET_FILE_BUDGET_SHARE = 0.25;
const MAX_CONTEXT_REGION_SOURCE_BYTES = 128 * 1024;

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
  const targetArea =
    input.target === undefined ? undefined : resolveTargetArea(workspace, input.target);
  const gitEvidence = await collectGitEvidence(adapter, input.workspaceId);
  const searchEvidence = await collectSearchEvidence(adapter, input, targetArea);
  const focusEvidence = await collectFocusReferenceEvidence(adapter, input, targetArea);
  const verificationEvidence = await collectVerificationEvidence(adapter, input.workspaceId, input.target);
  const git = gitEvidence.state === "unavailable" ? undefined : gitEvidence.value;
  const search = scopeSearchEvidence(
    searchEvidence.state === "unavailable" ? emptySearchResult() : searchEvidence.value,
    input.target,
    targetArea
  );
  const focusReferences =
    focusEvidence === undefined || focusEvidence.state === "unavailable" ? [] : focusEvidence.value.matches;
  const searchState = mergeEvidenceStates(searchEvidence.state, focusEvidence?.state);
  const verifications =
    verificationEvidence.state === "unavailable" ? [] : verificationEvidence.value.recipes;

  const candidates = selectCandidates(workspace, git, search, input.intent, input.target);
  const relevantMatches = sortedMatches([
    ...search.matches.filter(
      (match) => match.path === input.target || isSemanticDiscoveryPath(match.path)
    ),
    ...focusReferences.filter(
      (match) => match.path === input.target || isSemanticDiscoveryPath(match.path)
    )
  ]);
  const workspaceSummary = summarizeWorkspace(workspace, input.target, targetArea);
  const warnings = [...workspace.warnings];
  if (gitEvidence.state === "unavailable") warnings.push("git-evidence-unavailable");
  else if (gitEvidence.value.truncated) warnings.push("git-change-evidence-truncated");
  if (searchEvidence.state === "unavailable") warnings.push("search-evidence-unavailable");
  else if (searchEvidence.value.truncated) warnings.push("search-evidence-truncated");
  if (focusEvidence?.state === "unavailable") warnings.push("focus-search-evidence-unavailable");
  else if (focusEvidence?.state === "incomplete") warnings.push("focus-search-evidence-truncated");
  if (verificationEvidence.state === "unavailable") {
    warnings.push("verification-evidence-unavailable");
  }

  let totalBytes = 0;
  let truncated =
    workspace.truncated ||
    gitEvidence.state !== "available" ||
    searchState !== "available" ||
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
      const readLimit = candidateReadLimit(candidate, maxBytes, remaining, input.target !== undefined);
      const region = selectFocusRegion(candidate, workspace, input, focusEvidence);
      const sourceReadLimit =
        region === undefined
          ? readLimit
          : Math.min(MAX_CONTEXT_MAX_BYTES, Math.max(readLimit, MAX_CONTEXT_REGION_SOURCE_BYTES));
      let read = await adapter.readFile(input.workspaceId, candidate.path, {
        offset: 0,
        maxBytes: sourceReadLimit
      });
      let actualBytes = Buffer.byteLength(read.contents, "utf8");
      if (actualBytes !== read.bytesRead) {
        warnings.push(`invalid-read-result:${candidate.path}`);
        truncated = true;
        continue;
      }

      if (region !== undefined && read.eof) {
        const content = sliceLineRegion(read.contents, region);
        const regionBytes = content === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(content, "utf8");
        if (content !== undefined && regionBytes <= readLimit && regionBytes <= remaining) {
          selectedFiles.push({
            path: candidate.path,
            reason: candidate.reason,
            content,
            region,
            truncated: false
          });
          totalBytes += regionBytes;
          continue;
        }
      }

      if (sourceReadLimit !== readLimit) {
        read = await adapter.readFile(input.workspaceId, candidate.path, { offset: 0, maxBytes: readLimit });
        actualBytes = Buffer.byteLength(read.contents, "utf8");
      }
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
      search: searchState,
      verification: verificationEvidence.state
    },
    workspace: workspaceSummary,
    ...(git === undefined ? {} : { git }),
    selectedFiles,
    relevantMatches,
    verifications,
    warnings: [...new Set(warnings)],
    totalBytes,
    truncated
  };
}

function candidateReadLimit(
  candidate: Candidate,
  maxBytes: number,
  remaining: number,
  targetScoped: boolean
): number {
  if (!targetScoped) return remaining;
  const share = candidate.kind === "target" ? TARGET_FILE_BUDGET_SHARE : NON_TARGET_FILE_BUDGET_SHARE;
  return Math.min(remaining, Math.max(1, Math.floor(maxBytes * share)));
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
  input: ContextBuildInput,
  targetArea: string | undefined
): Promise<EvidenceResult<CodeSearchResult>> {
  if (input.target === undefined) return { state: "available", value: emptySearchResult() };
  try {
    const value = await adapter.search({
      workspaceId: input.workspaceId,
      query: targetQuery(input.target),
      mode: "path",
      ...(targetArea === undefined || targetArea === "." ? {} : { path: targetArea }),
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

async function collectFocusReferenceEvidence(
  adapter: ContextBuildAdapter,
  input: ContextBuildInput,
  targetArea: string | undefined
): Promise<EvidenceResult<CodeSearchResult> | undefined> {
  if (input.focus === undefined) return undefined;
  try {
    const value = await adapter.search({
      workspaceId: input.workspaceId,
      query: input.focus,
      mode: "reference",
      ...(targetArea === undefined || targetArea === "." ? {} : { path: targetArea }),
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

function mergeEvidenceStates(
  primary: ContextEvidenceState,
  secondary: ContextEvidenceState | undefined
): ContextEvidenceState {
  if (secondary === undefined) return primary;
  if (primary === "available" && secondary === "available") return "available";
  if (primary === "unavailable" && secondary === "unavailable") return "unavailable";
  return "incomplete";
}

async function collectVerificationEvidence(
  adapter: ContextBuildAdapter,
  workspaceId: string,
  target: string | undefined
): Promise<EvidenceResult<VerifyListResult>> {
  try {
    const value = await adapter.verify({ workspaceId, ...(target === undefined ? {} : { target }) });
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

function scopeSearchEvidence(
  search: CodeSearchResult,
  target: string | undefined,
  targetArea: string | undefined
): CodeSearchResult {
  if (target === undefined || targetArea === undefined || targetArea === ".") return search;
  return {
    ...search,
    matches: search.matches.filter(
      (match) => match.path === target || sameArea(match.path, targetArea)
    )
  };
}

function selectFocusRegion(
  candidate: Candidate,
  workspace: WorkspaceInspectResult,
  input: ContextBuildInput,
  focusEvidence: EvidenceResult<CodeSearchResult> | undefined
): SourceRegion | undefined {
  if (input.target === undefined || input.focus === undefined) return undefined;

  if (candidate.path === input.target) {
    return uniqueRegion(
      workspace.symbols
        .filter(
          (symbol) =>
            symbol.path === candidate.path &&
            symbol.name === input.focus &&
            symbol.region !== undefined
        )
        .map((symbol) => symbol.region!)
    );
  }

  if (
    focusEvidence === undefined ||
    focusEvidence.state === "unavailable" ||
    focusEvidence.value.precision !== "structural"
  ) {
    return undefined;
  }

  const regions: SourceRegion[] = [];
  for (const match of focusEvidence.value.matches) {
    if (match.path !== candidate.path || match.line === undefined) continue;
    regions.push(enclosingSymbolRegion(workspace, candidate.path, match.line) ?? {
      startLine: match.line,
      endLine: match.line
    });
  }
  return uniqueRegion(regions);
}

function enclosingSymbolRegion(
  workspace: WorkspaceInspectResult,
  path: string,
  line: number
): SourceRegion | undefined {
  return workspace.symbols
    .filter(
      (symbol) =>
        symbol.path === path &&
        symbol.region !== undefined &&
        symbol.region.startLine <= line &&
        symbol.region.endLine >= line
    )
    .sort((left, right) => {
      const leftRegion = left.region!;
      const rightRegion = right.region!;
      return (
        leftRegion.endLine - leftRegion.startLine - (rightRegion.endLine - rightRegion.startLine) ||
        leftRegion.startLine - rightRegion.startLine ||
        compareLexical(left.name, right.name)
      );
    })[0]?.region;
}

function uniqueRegion(regions: SourceRegion[]): SourceRegion | undefined {
  const unique = new Map<string, SourceRegion>();
  for (const region of regions) unique.set(`${region.startLine}:${region.endLine}`, region);
  return unique.size === 1 ? [...unique.values()][0] : undefined;
}

function sliceLineRegion(contents: string, region: SourceRegion): string | undefined {
  const starts = [0];
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] === "\n") starts.push(index + 1);
  }
  if (region.startLine > starts.length || region.endLine > starts.length) return undefined;
  const start = starts[region.startLine - 1]!;
  const end = region.endLine < starts.length ? starts[region.endLine]! : contents.length;
  return contents.slice(start, end);
}

function summarizeWorkspace(
  workspace: WorkspaceInspectResult,
  target: string | undefined,
  targetArea: string | undefined
): ContextWorkspaceSummary {
  if (target === undefined) {
    return {
      schemaVersion: 1,
      workspaceId: workspace.workspaceId,
      root: workspace.root,
      scope: { kind: "workspace" },
      projectTypes: [...workspace.projectTypes],
      languages: [...workspace.languages],
      entrypoints: [...workspace.entrypoints],
      areas: [...workspace.areas],
      manifests: [...workspace.manifests],
      warnings: [...workspace.warnings],
      truncated: workspace.truncated
    };
  }

  const area = targetArea ?? dirname(target);
  return {
    schemaVersion: 1,
    workspaceId: workspace.workspaceId,
    root: workspace.root,
    scope: { kind: "target", area },
    projectTypes: [...workspace.projectTypes],
    languages: [...workspace.languages],
    entrypoints: workspace.entrypoints.filter(
      (entrypoint) => sameArea(entrypoint.path, area) || governsTarget(entrypoint.path, target)
    ),
    areas: workspace.areas.filter(
      (candidate) =>
        candidate.path === area ||
        (candidate.kind === "config" &&
          (sameArea(candidate.path, area) || governsTarget(candidate.path, target)))
    ),
    manifests: workspace.manifests.filter((manifest) => governsTarget(manifest.path, target)),
    warnings: [...workspace.warnings],
    truncated: workspace.truncated
  };
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
      score: TIER_BASE[kind] + intentWeight(intent, kind)
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

  if (target !== undefined) {
    for (const candidate of relationshipCandidates(workspace, target)) {
      add(candidate.path, candidate.reason, candidate.kind);
    }
  }

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

function relationshipCandidates(
  workspace: WorkspaceInspectResult,
  target: string
): Array<{ path: string; reason: string; kind: CandidateKind }> {
  const candidates: Array<{ path: string; reason: string; kind: CandidateKind }> = [];
  for (const relationship of workspace.relationships) {
    if (relationship.kind === "tests" && relationship.to === target) {
      candidates.push({ path: relationship.from, reason: "related-test", kind: "relatedTest" });
      continue;
    }
    if (relationship.kind === "imports" && relationship.from === target) {
      candidates.push({ path: relationship.to, reason: "direct-dependency", kind: "dependency" });
      continue;
    }
    if (relationship.kind === "imports" && relationship.to === target) {
      candidates.push({ path: relationship.from, reason: "direct-dependent", kind: "dependent" });
    }
  }
  return candidates;
}

function intentWeight(intent: ContextIntent, kind: CandidateKind): number {
  switch (kind) {
    case "relatedTest":
      return INTENT_WEIGHTS[intent].tests;
    case "dependency":
    case "dependent":
      return INTENT_WEIGHTS[intent].search;
    default:
      return INTENT_WEIGHTS[intent][kind];
  }
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
  if (input.focus !== undefined) {
    if (input.target === undefined) {
      throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Context focus requires an explicit target");
    }
    if (input.focus.length === 0 || input.focus.length > 512 || input.focus.includes("\0")) {
      throw new CapabilityError(
        "CAPABILITY_INPUT_INVALID",
        "Context focus must contain between 1 and 512 safe characters"
      );
    }
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
