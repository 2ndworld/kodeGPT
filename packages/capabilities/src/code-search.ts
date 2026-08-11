import type {
  CapabilitySearchMatch,
  CodeSearchAdapter,
  WorkspaceInspectionAdapter
} from "./adapters.js";
import {
  CAPABILITY_SCHEMA_VERSION,
  DEFAULT_SEARCH_MAX_RESULTS,
  MAX_INSPECT_MAX_ENTRIES,
  MAX_SEARCH_MAX_RESULTS,
  type CodeSearchInput,
  type CodeSearchMatch,
  type CodeSearchMode,
  type CodeSearchResult
} from "./contracts.js";

export async function searchCode(
  workspaceInspection: WorkspaceInspectionAdapter,
  codeSearch: CodeSearchAdapter,
  input: CodeSearchInput
): Promise<CodeSearchResult> {
  validateInput(input);
  const mode = input.mode ?? "text";
  const maxResults = input.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS;

  if (mode === "path") {
    return searchPaths(workspaceInspection, input, maxResults);
  }

  const lowLevelMax = mode === "text" ? maxResults : MAX_SEARCH_MAX_RESULTS;
  const lowLevel = await codeSearch.search(
    input.workspaceId,
    input.query,
    input.path,
    lowLevelMax
  );
  const classified = classifyMatches(lowLevel.matches, input.query, mode);

  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    mode,
    precision: mode === "text" ? "exact" : "heuristic",
    matches: classified.slice(0, maxResults),
    truncated: lowLevel.truncated || classified.length > maxResults
  };
}

async function searchPaths(
  workspace: WorkspaceInspectionAdapter,
  input: CodeSearchInput,
  maxResults: number
): Promise<CodeSearchResult> {
  const tree = await workspace.tree(
    input.workspaceId,
    input.path ?? ".",
    MAX_INSPECT_MAX_ENTRIES
  );
  const matchingPaths = tree.entries
    .map(({ path }) => path)
    .filter((path) => path.includes(input.query))
    .sort(compareText);

  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    mode: "path",
    precision: "lexical",
    matches: matchingPaths.slice(0, maxResults).map((path) => ({ path, kind: "path" })),
    truncated: tree.truncated || matchingPaths.length > maxResults
  };
}

function classifyMatches(
  matches: CapabilitySearchMatch[],
  query: string,
  mode: Exclude<CodeSearchMode, "path">
): CodeSearchMatch[] {
  const result: CodeSearchMatch[] = [];
  for (const match of matches) {
    if (mode === "text") {
      const index = match.lineText.indexOf(query);
      if (index >= 0) result.push(toMatch(match, mode, index + 1));
      continue;
    }

    const column = identifierColumn(match.lineText, query);
    if (column === undefined) continue;
    const definition = isDefinitionLine(match.lineText, query);
    if (mode === "definition" && !definition) continue;
    if (mode === "reference" && definition) continue;
    result.push(toMatch(match, mode, column));
  }
  return result;
}

function toMatch(match: CapabilitySearchMatch, kind: CodeSearchMode, column: number): CodeSearchMatch {
  return {
    path: match.path,
    line: match.line,
    column,
    kind,
    preview: match.lineText
  };
}

function identifierColumn(line: string, query: string): number | undefined {
  let offset = 0;
  while (offset <= line.length - query.length) {
    const index = line.indexOf(query, offset);
    if (index < 0) return undefined;
    const before = index === 0 ? undefined : line[index - 1];
    const afterIndex = index + query.length;
    const after = afterIndex >= line.length ? undefined : line[afterIndex];
    if (!isIdentifierChar(before) && !isIdentifierChar(after)) return index + 1;
    offset = index + 1;
  }
  return undefined;
}

function isIdentifierChar(value: string | undefined): boolean {
  if (value === undefined) return false;
  return (
    (value >= "a" && value <= "z") ||
    (value >= "A" && value <= "Z") ||
    (value >= "0" && value <= "9") ||
    value === "_" ||
    value === "$"
  );
}

function isDefinitionLine(line: string, query: string): boolean {
  let normalized = line.trimStart();
  normalized = stripPrefix(normalized, "export ");
  normalized = stripPrefix(normalized, "default ");

  const typeScript = stripPrefix(normalized, "async ");
  if (startsWithIdentifier(typeScript, `function ${query}`, query)) return true;
  if (startsWithIdentifier(normalized, `class ${query}`, query)) return true;
  if (startsWithIdentifier(normalized, `const ${query}`, query)) return true;
  if (startsWithIdentifier(normalized, `let ${query}`, query)) return true;
  if (startsWithIdentifier(normalized, `var ${query}`, query)) return true;

  normalized = stripRustVisibility(normalized);
  const rust = stripPrefix(normalized, "async ");
  if (startsWithIdentifier(rust, `fn ${query}`, query)) return true;
  if (startsWithIdentifier(normalized, `struct ${query}`, query)) return true;
  return startsWithIdentifier(normalized, `trait ${query}`, query);
}

function startsWithIdentifier(line: string, prefix: string, query: string): boolean {
  if (!line.startsWith(prefix)) return false;
  const after = line[prefix.length];
  return query.length > 0 && !isIdentifierChar(after);
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function stripRustVisibility(value: string): string {
  if (value.startsWith("pub ")) return value.slice(4);
  if (!value.startsWith("pub(")) return value;
  const end = value.indexOf(") ");
  return end >= 0 ? value.slice(end + 2) : value;
}

function validateInput(input: CodeSearchInput): void {
  if (input.workspaceId.length === 0) {
    throw new TypeError("code.search workspaceId must not be empty");
  }
  if (input.query.length === 0 || input.query.length > 512) {
    throw new TypeError("code.search query must contain between 1 and 512 characters");
  }
  if (input.path !== undefined && input.path.length === 0) {
    throw new TypeError("code.search path must not be empty");
  }
  if (
    input.maxResults !== undefined &&
    (!Number.isSafeInteger(input.maxResults) ||
      input.maxResults <= 0 ||
      input.maxResults > MAX_SEARCH_MAX_RESULTS)
  ) {
    throw new TypeError("code.search maxResults must be between 1 and 500");
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
