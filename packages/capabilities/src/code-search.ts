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
  type CodeSearchResult,
  type CodeSearchTruncationReason
} from "./contracts.js";
import { CapabilityError } from "./errors.js";
import { analyzeStructuralFile } from "./structural-analysis.js";

const MAX_STRUCTURAL_SEARCH_FILES = 64;
const MAX_STRUCTURAL_SEARCH_FILE_BYTES = 128 * 1024;
const MAX_STRUCTURAL_SEARCH_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_CONTEXT_LINES = 8;
const MAX_SEARCH_SNIPPET_SOURCE_BYTES = 128 * 1024;
const MAX_SEARCH_SNIPPET_TOTAL_BYTES = 16 * 1024;

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
    lowLevelMax,
    "semantic"
  );
  if (mode === "text") {
    const classified = classifyMatches(lowLevel.matches, input.query, mode);
    const visible = classified.slice(0, maxResults);
    const enriched = await attachSurroundingSnippets(
      workspaceInspection,
      input.workspaceId,
      visible,
      input.contextLines
    );
    const truncationReasons = orderedReasons([
      ...lowLevel.truncationReasons,
      ...(classified.length > maxResults ? (["MATCH_LIMIT"] as const) : []),
      ...enriched.truncationReasons
    ]);
    return {
      schemaVersion: CAPABILITY_SCHEMA_VERSION,
      mode,
      precision: "exact",
      matches: enriched.matches,
      truncated: truncationReasons.length > 0,
      truncationReasons
    };
  }

  const structural = await classifyStructuralMatches(
    workspaceInspection,
    input.workspaceId,
    input.query,
    mode,
    lowLevel.matches
  );
  const visible = structural.matches.slice(0, maxResults);
  const enriched = await attachSurroundingSnippets(
    workspaceInspection,
    input.workspaceId,
    visible,
    input.contextLines
  );
  const truncationReasons = orderedReasons([
    ...lowLevel.truncationReasons,
    ...structural.truncationReasons,
    ...(structural.matches.length > maxResults ? (["MATCH_LIMIT"] as const) : []),
    ...enriched.truncationReasons
  ]);

  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    mode,
    precision: structural.fullyStructural ? "structural" : "heuristic",
    matches: enriched.matches,
    truncated: truncationReasons.length > 0,
    truncationReasons
  };
}

async function attachSurroundingSnippets(
  workspace: WorkspaceInspectionAdapter,
  workspaceId: string,
  matches: CodeSearchMatch[],
  contextLines: number | undefined
): Promise<{ matches: CodeSearchMatch[]; truncationReasons: CodeSearchTruncationReason[] }> {
  if (contextLines === undefined) return { matches, truncationReasons: [] };

  type ReadResult = Awaited<ReturnType<WorkspaceInspectionAdapter["readFile"]>>;
  const reads = new Map<string, ReadResult | null>();
  const enriched: CodeSearchMatch[] = [];
  let snippetBytes = 0;
  let snippetTruncated = false;

  for (const match of matches) {
    if (match.line === undefined) {
      enriched.push(match);
      continue;
    }

    let read = reads.get(match.path);
    if (read === undefined) {
      try {
        read = await workspace.readFile(workspaceId, match.path, {
          offset: 0,
          maxBytes: MAX_SEARCH_SNIPPET_SOURCE_BYTES
        });
        reads.set(match.path, read);
      } catch {
        reads.set(match.path, null);
        snippetTruncated = true;
        enriched.push(match);
        continue;
      }
    }
    if (read === null) {
      snippetTruncated = true;
      enriched.push(match);
      continue;
    }

    const starts = lineStarts(read.contents);
    if (match.line > starts.length) {
      snippetTruncated = true;
      enriched.push(match);
      continue;
    }

    const startLine = Math.max(1, match.line - contextLines);
    const requestedEndLine = match.line + contextLines;
    if (!read.eof && requestedEndLine >= starts.length) {
      snippetTruncated = true;
      enriched.push(match);
      continue;
    }
    const endLine = Math.min(requestedEndLine, starts.length);
    const text = sliceLines(read.contents, starts, startLine, endLine);
    const bytes = Buffer.byteLength(text, "utf8");
    if (snippetBytes + bytes > MAX_SEARCH_SNIPPET_TOTAL_BYTES) {
      snippetTruncated = true;
      enriched.push(match);
      continue;
    }

    snippetBytes += bytes;
    enriched.push({ ...match, snippet: { startLine, endLine, text } });
  }

  return {
    matches: enriched,
    truncationReasons: snippetTruncated ? ["SNIPPET_BYTE_LIMIT"] : []
  };
}

function lineStarts(contents: string): number[] {
  const starts = [0];
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] === "\n") starts.push(index + 1);
  }
  if (starts.length > 1 && starts[starts.length - 1] === contents.length) starts.pop();
  return starts;
}

function sliceLines(contents: string, starts: number[], startLine: number, endLine: number): string {
  const start = starts[startLine - 1]!;
  const end = endLine < starts.length ? starts[endLine]! : contents.length;
  return contents.slice(start, end);
}

async function searchPaths(
  workspace: WorkspaceInspectionAdapter,
  input: CodeSearchInput,
  maxResults: number
): Promise<CodeSearchResult> {
  const tree = await workspace.tree(
    input.workspaceId,
    input.path ?? ".",
    MAX_INSPECT_MAX_ENTRIES,
    "semantic"
  );
  const matchingPaths = tree.entries
    .map(({ path }) => path)
    .filter((path) => path.includes(input.query))
    .sort(compareText);
  const truncationReasons = orderedReasons([
    ...(tree.truncated ? (["TREE_LIMIT"] as const) : []),
    ...(matchingPaths.length > maxResults ? (["MATCH_LIMIT"] as const) : [])
  ]);

  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    mode: "path",
    precision: "lexical",
    matches: matchingPaths.slice(0, maxResults).map((path) => ({ path, kind: "path" })),
    truncated: truncationReasons.length > 0,
    truncationReasons
  };
}

async function classifyStructuralMatches(
  workspace: WorkspaceInspectionAdapter,
  workspaceId: string,
  query: string,
  mode: "symbol" | "definition" | "reference",
  lowLevelMatches: CapabilitySearchMatch[]
): Promise<{
  matches: CodeSearchMatch[];
  fullyStructural: boolean;
  truncationReasons: CodeSearchTruncationReason[];
}> {
  if (lowLevelMatches.length === 0) {
    return { matches: [], fullyStructural: false, truncationReasons: [] };
  }

  const byPath = new Map<string, CapabilitySearchMatch[]>();
  for (const match of lowLevelMatches) {
    const existing = byPath.get(match.path);
    if (existing === undefined) byPath.set(match.path, [match]);
    else existing.push(match);
  }

  const matches: CodeSearchMatch[] = [];
  const reasons = new Set<CodeSearchTruncationReason>();
  let fullyStructural = true;
  let analyzedFiles = 0;
  let totalBytes = 0;

  for (const [path, pathMatches] of byPath) {
    const remainingBytes = MAX_STRUCTURAL_SEARCH_TOTAL_BYTES - totalBytes;
    if (analyzedFiles >= MAX_STRUCTURAL_SEARCH_FILES || remainingBytes <= 0) {
      reasons.add("SCAN_BYTE_LIMIT");
      fullyStructural = false;
      matches.push(...classifyMatches(pathMatches, query, mode));
      continue;
    }

    let read: Awaited<ReturnType<WorkspaceInspectionAdapter["readFile"]>>;
    try {
      read = await workspace.readFile(workspaceId, path, {
        offset: 0,
        maxBytes: Math.min(MAX_STRUCTURAL_SEARCH_FILE_BYTES, remainingBytes)
      });
    } catch {
      fullyStructural = false;
      matches.push(...classifyMatches(pathMatches, query, mode));
      continue;
    }
    analyzedFiles += 1;
    totalBytes += read.bytesRead;

    if (!read.eof) {
      reasons.add("FILE_SIZE_LIMIT");
      fullyStructural = false;
      matches.push(...classifyMatches(pathMatches, query, mode));
      continue;
    }
    if (!sourceMatchesCandidateEvidence(read.contents, pathMatches)) {
      fullyStructural = false;
      matches.push(...classifyMatches(pathMatches, query, mode));
      continue;
    }

    const analysis = analyzeStructuralFile({ path, contents: read.contents });
    if (analysis === undefined || analysis.precision !== "structural") {
      fullyStructural = false;
      matches.push(...classifyMatches(pathMatches, query, mode));
      continue;
    }

    matches.push(...structuralMatches(analysis, read.contents, query, mode));
  }

  return {
    matches,
    fullyStructural,
    truncationReasons: orderedReasons([...reasons])
  };
}

function sourceMatchesCandidateEvidence(contents: string, matches: CapabilitySearchMatch[]): boolean {
  const lines = contents.split(/\r?\n/);
  return matches.every((match) => match.line > 0 && lines[match.line - 1] === match.lineText);
}

function structuralMatches(
  analysis: ReturnType<typeof analyzeStructuralFile> & {},
  contents: string,
  query: string,
  mode: "symbol" | "definition" | "reference"
): CodeSearchMatch[] {
  if (analysis === undefined) return [];
  const lines = contents.split(/\r?\n/);
  const result: CodeSearchMatch[] = [];

  if (mode !== "reference") {
    for (const symbol of analysis.symbols) {
      if (symbol.name !== query) continue;
      const preview = lines[symbol.line - 1] ?? "";
      const column = identifierColumn(preview, query);
      if (column === undefined) continue;
      result.push({ path: symbol.path, line: symbol.line, column, kind: mode, preview });
    }
  }

  if (mode !== "definition") {
    for (const reference of analysis.references) {
      if (reference.name !== query) continue;
      result.push({
        path: reference.path,
        line: reference.line,
        column: reference.column,
        kind: mode,
        preview: lines[reference.line - 1] ?? ""
      });
    }
  }

  return result.sort(
    (left, right) =>
      compareText(left.path, right.path) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      (left.column ?? 0) - (right.column ?? 0)
  );
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
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "code.search workspaceId must not be empty");
  }
  if (input.query.length === 0 || input.query.length > 512) {
    throw new CapabilityError(
      "CAPABILITY_INPUT_INVALID",
      "code.search query must contain between 1 and 512 characters"
    );
  }
  if (input.path !== undefined && input.path.length === 0) {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "code.search path must not be empty");
  }
  if (
    input.maxResults !== undefined &&
    (!Number.isSafeInteger(input.maxResults) ||
      input.maxResults <= 0 ||
      input.maxResults > MAX_SEARCH_MAX_RESULTS)
  ) {
    throw new CapabilityError(
      "CAPABILITY_LIMIT_EXCEEDED",
      "code.search maxResults must be between 1 and 500"
    );
  }
  if (
    input.contextLines !== undefined &&
    (!Number.isSafeInteger(input.contextLines) ||
      input.contextLines < 0 ||
      input.contextLines > MAX_SEARCH_CONTEXT_LINES)
  ) {
    throw new CapabilityError(
      "CAPABILITY_LIMIT_EXCEEDED",
      "code.search contextLines must be between 0 and 8"
    );
  }
}

const TRUNCATION_REASON_ORDER: CodeSearchTruncationReason[] = [
  "TREE_LIMIT",
  "FILE_SIZE_LIMIT",
  "SCAN_BYTE_LIMIT",
  "MATCH_LIMIT",
  "SNIPPET_BYTE_LIMIT"
];

function orderedReasons(reasons: readonly CodeSearchTruncationReason[]): CodeSearchTruncationReason[] {
  const present = new Set(reasons);
  return TRUNCATION_REASON_ORDER.filter((reason) => present.has(reason));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
