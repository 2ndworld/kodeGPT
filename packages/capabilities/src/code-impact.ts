import type { CodeSearchAdapter, WorkspaceInspectionAdapter } from "./adapters.js";
import {
  CAPABILITY_SCHEMA_VERSION,
  DEFAULT_IMPACT_MAX_RESULTS,
  MAX_IMPACT_MAX_RESULTS,
  MAX_INSPECT_MAX_ENTRIES,
  type CodeImpactDependent,
  type CodeImpactInput,
  type CodeImpactResult,
  type CodeImpactTargetKind,
  type CodeImpactTruncationReason,
  type WorkspaceInspectArea,
  type WorkspaceInspectResult
} from "./contracts.js";
import { CapabilityError } from "./errors.js";
import { searchCode } from "./code-search.js";
import { inspectWorkspace } from "./workspace-inspect.js";

export async function impactCode(
  workspaceInspection: WorkspaceInspectionAdapter,
  codeSearch: CodeSearchAdapter,
  input: CodeImpactInput
): Promise<CodeImpactResult> {
  validateInput(input);
  const maxResults = input.maxResults ?? DEFAULT_IMPACT_MAX_RESULTS;
  const kind = resolveKind(input.kind ?? "auto", input.target);
  const inspection = await inspectWorkspace(workspaceInspection, {
    workspaceId: input.workspaceId,
    ...(input.path === undefined ? {} : { path: input.path }),
    maxEntries: MAX_INSPECT_MAX_ENTRIES
  });

  const reasons = new Set<CodeImpactTruncationReason>();
  if (inspection.truncated || inspection.warnings.some((warning) => warning.includes("LIMIT_REACHED"))) {
    reasons.add("SEARCH_LIMIT");
  }

  let resolvedPaths: string[];
  let dependents: CodeImpactDependent[];
  let relatedTests: string[];

  if (kind === "file") {
    resolvedPaths = [normalizeRelativePath(input.target)];
    const target = resolvedPaths[0]!;
    dependents = inspection.relationships
      .filter(
        (relationship) =>
          relationship.to === target &&
          (relationship.kind === "imports" || relationship.kind === "module")
      )
      .map((relationship) => ({
        path: relationship.from,
        relationship: relationship.kind === "imports" ? ("imports" as const) : ("module" as const)
      }));
    relatedTests = inspection.relationships
      .filter((relationship) => relationship.kind === "tests" && relationship.to === target)
      .map((relationship) => relationship.from);
  } else {
    const [definitions, references] = await Promise.all([
      searchCode(workspaceInspection, codeSearch, {
        workspaceId: input.workspaceId,
        query: input.target,
        mode: "definition",
        ...(input.path === undefined ? {} : { path: input.path }),
        maxResults: MAX_IMPACT_MAX_RESULTS
      }),
      searchCode(workspaceInspection, codeSearch, {
        workspaceId: input.workspaceId,
        query: input.target,
        mode: "reference",
        ...(input.path === undefined ? {} : { path: input.path }),
        maxResults: MAX_IMPACT_MAX_RESULTS
      })
    ]);
    if (definitions.truncated || references.truncated) reasons.add("SEARCH_LIMIT");
    resolvedPaths = uniqueSorted(definitions.matches.map((match) => match.path));
    dependents = references.matches.map((match) => ({
      path: match.path,
      relationship: "reference" as const,
      ...(match.line === undefined ? {} : { line: match.line })
    }));
    const sourcePaths = new Set(resolvedPaths);
    relatedTests = uniqueSorted([
      ...inspection.relationships
        .filter((relationship) => relationship.kind === "tests" && sourcePaths.has(relationship.to))
        .map((relationship) => relationship.from),
      ...references.matches.filter((match) => isTestPath(match.path)).map((match) => match.path)
    ]);
  }

  resolvedPaths = uniqueSorted(resolvedPaths);
  dependents = uniqueDependents(dependents);
  relatedTests = uniqueSorted(relatedTests);
  const affectedEvidencePaths = uniqueSorted([
    ...resolvedPaths,
    ...dependents.map((dependent) => dependent.path),
    ...relatedTests
  ]);
  const affectedAreas = bound(
    deriveAffectedAreas(inspection, affectedEvidencePaths),
    maxResults,
    "AREA_LIMIT",
    reasons
  );

  resolvedPaths = bound(resolvedPaths, maxResults, "TARGET_LIMIT", reasons);
  dependents = bound(dependents, maxResults, "DEPENDENT_LIMIT", reasons);
  relatedTests = bound(relatedTests, maxResults, "TEST_LIMIT", reasons);
  const truncationReasons = orderedReasons(reasons);

  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    target: {
      kind,
      value: input.target,
      resolvedPaths
    },
    dependents,
    relatedTests,
    affectedAreas,
    truncated: truncationReasons.length > 0,
    truncationReasons
  };
}

function validateInput(input: CodeImpactInput): void {
  if (input.workspaceId.length === 0) {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "code.impact workspaceId must not be empty");
  }
  if (input.target.length === 0 || input.target.length > 512 || input.target.includes("\0")) {
    throw new CapabilityError(
      "CAPABILITY_INPUT_INVALID",
      "code.impact target must contain between 1 and 512 safe characters"
    );
  }
  if (input.path !== undefined) normalizeRelativePath(input.path);
  if (
    input.maxResults !== undefined &&
    (!Number.isSafeInteger(input.maxResults) || input.maxResults <= 0 || input.maxResults > MAX_IMPACT_MAX_RESULTS)
  ) {
    throw new CapabilityError(
      "CAPABILITY_LIMIT_EXCEEDED",
      `code.impact maxResults must be between 1 and ${MAX_IMPACT_MAX_RESULTS}`
    );
  }
  if (input.kind === "file") normalizeRelativePath(input.target);
}

function resolveKind(kind: CodeImpactTargetKind, target: string): "file" | "symbol" {
  if (kind !== "auto") return kind;
  return target.includes("/") || /\.[A-Za-z0-9]{1,12}$/.test(target) ? "file" : "symbol";
}

function normalizeRelativePath(path: string): string {
  const normalized = path.replace(/^\.\//, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "code.impact path must be workspace-relative");
  }
  return normalized;
}

function deriveAffectedAreas(inspection: WorkspaceInspectResult, paths: string[]): string[] {
  return uniqueSorted(
    paths.map((path) => areaForPath(path, inspection.areas)).filter((area): area is string => area !== undefined)
  );
}

function areaForPath(path: string, areas: WorkspaceInspectArea[]): string | undefined {
  const matching = areas
    .filter((area) => path === area.path || path.startsWith(`${area.path}/`))
    .sort((left, right) => right.path.length - left.path.length || compareText(left.path, right.path));
  if (matching[0] !== undefined) return matching[0].path;

  const [top, child] = path.split("/");
  if (["apps", "packages", "crates"].includes(top ?? "") && child !== undefined) return `${top}/${child}`;
  if (top === "tests" || top === "docs") return top;
  return top;
}

function isTestPath(path: string): boolean {
  return (
    path.startsWith("tests/") ||
    /(?:^|\/)[^/]+\.(?:test|spec)\.[^.]+$/.test(path) ||
    /(?:^|\/)tests?\//.test(path)
  );
}

function uniqueDependents(values: CodeImpactDependent[]): CodeImpactDependent[] {
  const unique = new Map<string, CodeImpactDependent>();
  for (const value of values) {
    const key = `${value.path}\0${value.relationship}\0${value.line ?? 0}`;
    unique.set(key, value);
  }
  return [...unique.values()].sort(
    (left, right) =>
      compareText(left.path, right.path) ||
      compareText(left.relationship, right.relationship) ||
      (left.line ?? 0) - (right.line ?? 0)
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function bound<T>(
  values: T[],
  maxResults: number,
  reason: CodeImpactTruncationReason,
  reasons: Set<CodeImpactTruncationReason>
): T[] {
  if (values.length > maxResults) reasons.add(reason);
  return values.slice(0, maxResults);
}

const REASON_ORDER: CodeImpactTruncationReason[] = [
  "TARGET_LIMIT",
  "DEPENDENT_LIMIT",
  "TEST_LIMIT",
  "AREA_LIMIT",
  "SEARCH_LIMIT"
];

function orderedReasons(reasons: Set<CodeImpactTruncationReason>): CodeImpactTruncationReason[] {
  return REASON_ORDER.filter((reason) => reasons.has(reason));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
