import { posix } from "node:path";

import type { CapabilityTreeEntry, WorkspaceInspectionAdapter } from "./adapters.js";
import type {
  WorkspaceInspectRelationship,
  WorkspaceInspectSymbol,
  WorkspaceInspectSymbolKind
} from "./contracts.js";

const MAX_ANALYSIS_FILES = 256;
const MAX_ANALYSIS_FILE_BYTES = 128 * 1024;
const MAX_ANALYSIS_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_ANALYSIS_SYMBOLS = 1_000;
const MAX_ANALYSIS_RELATIONSHIPS = 1_000;

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;
const SOURCE_EXTENSIONS = new Set<string>([...TS_EXTENSIONS, ".rs"]);
const JS_LIKE_EXTENSIONS = new Set<string>([".js", ".jsx", ".mjs", ".cjs"]);

const WARNING_ORDER = [
  "INSPECT_ANALYSIS_FILE_LIMIT_REACHED",
  "INSPECT_ANALYSIS_BYTE_LIMIT_REACHED",
  "INSPECT_ANALYSIS_FILE_SKIPPED",
  "INSPECT_SYMBOL_LIMIT_REACHED",
  "INSPECT_RELATIONSHIP_LIMIT_REACHED"
] as const;

type AnalysisWarning = (typeof WARNING_ORDER)[number];

export interface RepositoryAnalysisResult {
  symbols: WorkspaceInspectSymbol[];
  relationships: WorkspaceInspectRelationship[];
  warnings: string[];
}

export async function analyzeRepository(
  workspace: WorkspaceInspectionAdapter,
  workspaceId: string,
  entries: CapabilityTreeEntry[]
): Promise<RepositoryAnalysisResult> {
  const knownFiles = new Set(entries.filter((entry) => entry.kind === "file").map((entry) => entry.path));
  const candidates = [...knownFiles].filter(isSourcePath).sort(compareText);
  const selected = candidates.slice(0, MAX_ANALYSIS_FILES);
  const warnings = new Set<AnalysisWarning>();
  const symbols: WorkspaceInspectSymbol[] = [];
  const relationships = new Map<string, WorkspaceInspectRelationship>();
  let totalBytes = 0;

  if (candidates.length > selected.length) warnings.add("INSPECT_ANALYSIS_FILE_LIMIT_REACHED");

  for (const path of selected) {
    let read: Awaited<ReturnType<WorkspaceInspectionAdapter["readFile"]>>;
    try {
      read = await workspace.readFile(workspaceId, path, { offset: 0, maxBytes: MAX_ANALYSIS_FILE_BYTES });
    } catch {
      warnings.add("INSPECT_ANALYSIS_FILE_SKIPPED");
      continue;
    }

    if (totalBytes + read.bytesRead > MAX_ANALYSIS_TOTAL_BYTES) {
      warnings.add("INSPECT_ANALYSIS_BYTE_LIMIT_REACHED");
      break;
    }
    totalBytes += read.bytesRead;

    if (!read.eof) {
      warnings.add("INSPECT_ANALYSIS_FILE_SKIPPED");
      continue;
    }

    if (path.endsWith(".rs")) {
      analyzeRust(path, read.contents, knownFiles, symbols, relationships, warnings);
    } else {
      analyzeTypeScript(path, read.contents, knownFiles, symbols, relationships, warnings);
      addTestRelationship(path, knownFiles, relationships, warnings);
    }
  }

  return {
    symbols: symbols.slice(0, MAX_ANALYSIS_SYMBOLS).sort(compareSymbols),
    relationships: [...relationships.values()].slice(0, MAX_ANALYSIS_RELATIONSHIPS).sort(compareRelationships),
    warnings: WARNING_ORDER.filter((warning) => warnings.has(warning))
  };
}

function analyzeTypeScript(
  path: string,
  contents: string,
  knownFiles: Set<string>,
  symbols: WorkspaceInspectSymbol[],
  relationships: Map<string, WorkspaceInspectRelationship>,
  warnings: Set<AnalysisWarning>
): void {
  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.length > 0 && /^\s/.test(line)) continue;

    const symbol = parseTypeScriptSymbol(line, path, index + 1);
    if (symbol !== undefined) addSymbol(symbols, symbol, warnings);

    const specifier = importSpecifier(line);
    if (specifier === undefined) continue;
    const target = resolveTypeScriptImport(path, specifier, knownFiles);
    if (target !== undefined) addRelationship(relationships, { from: path, to: target, kind: "imports" }, warnings);
  }
}

function analyzeRust(
  path: string,
  contents: string,
  knownFiles: Set<string>,
  symbols: WorkspaceInspectSymbol[],
  relationships: Map<string, WorkspaceInspectRelationship>,
  warnings: Set<AnalysisWarning>
): void {
  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.length > 0 && /^\s/.test(line)) continue;

    const symbol = parseRustSymbol(line, path, index + 1);
    if (symbol !== undefined) addSymbol(symbols, symbol, warnings);

    const module = line.match(/^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;\s*$/)?.[1];
    if (module === undefined) continue;
    const target = resolveRustModule(path, module, knownFiles);
    if (target !== undefined) addRelationship(relationships, { from: path, to: target, kind: "module" }, warnings);
  }
}

function parseTypeScriptSymbol(line: string, path: string, lineNumber: number): WorkspaceInspectSymbol | undefined {
  const exported = line.startsWith("export ");
  let value = exported ? line.slice("export ".length) : line;
  if (value.startsWith("default ")) value = value.slice("default ".length);
  if (value.startsWith("declare ")) value = value.slice("declare ".length);
  const asyncValue = value.startsWith("async ") ? value.slice("async ".length) : value;

  const definitions: Array<[WorkspaceInspectSymbolKind, RegExp, string]> = [
    ["function", /^function\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/, asyncValue],
    ["class", /^class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/, value],
    ["interface", /^interface\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/, value],
    ["type", /^type\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/, value],
    ["enum", /^enum\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/, value],
    ["variable", /^(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/, value]
  ];

  for (const [kind, pattern, candidate] of definitions) {
    const name = candidate.match(pattern)?.[1];
    if (name !== undefined) return { name, kind, path, line: lineNumber, exported };
  }
  return undefined;
}

function parseRustSymbol(line: string, path: string, lineNumber: number): WorkspaceInspectSymbol | undefined {
  const visibility = line.match(/^(pub(?:\([^)]*\))?\s+)?/)?.[1];
  const exported = visibility !== undefined;
  let value = visibility === undefined ? line : line.slice(visibility.length);
  if (value.startsWith("async ")) value = value.slice("async ".length);

  const definitions: Array<[WorkspaceInspectSymbolKind, RegExp]> = [
    ["function", /^fn\s+([A-Za-z_][A-Za-z0-9_]*)\b/],
    ["struct", /^struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/],
    ["enum", /^enum\s+([A-Za-z_][A-Za-z0-9_]*)\b/],
    ["trait", /^trait\s+([A-Za-z_][A-Za-z0-9_]*)\b/],
    ["module", /^mod\s+([A-Za-z_][A-Za-z0-9_]*)\b/]
  ];

  for (const [kind, pattern] of definitions) {
    const name = value.match(pattern)?.[1];
    if (name !== undefined) return { name, kind, path, line: lineNumber, exported };
  }
  return undefined;
}

function importSpecifier(line: string): string | undefined {
  return (
    line.match(/^import\s+(?:.+?\s+from\s+)?["']([^"']+)["']\s*;?\s*$/)?.[1] ??
    line.match(/^export\s+.+?\s+from\s+["']([^"']+)["']\s*;?\s*$/)?.[1]
  );
}

function resolveTypeScriptImport(fromPath: string, specifier: string, knownFiles: Set<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  const candidates: string[] = [base];
  const extension = posix.extname(base);

  if (JS_LIKE_EXTENSIONS.has(extension)) {
    const stem = base.slice(0, -extension.length);
    for (const sourceExtension of TS_EXTENSIONS) candidates.push(`${stem}${sourceExtension}`);
  } else if (extension.length === 0) {
    for (const sourceExtension of TS_EXTENSIONS) candidates.push(`${base}${sourceExtension}`);
  }
  for (const sourceExtension of TS_EXTENSIONS) candidates.push(`${base}/index${sourceExtension}`);

  return candidates.find((candidate) => knownFiles.has(candidate));
}

function resolveRustModule(fromPath: string, module: string, knownFiles: Set<string>): string | undefined {
  const directory = posix.dirname(fromPath);
  const candidates = [posix.join(directory, `${module}.rs`), posix.join(directory, module, "mod.rs")];
  return candidates.find((candidate) => knownFiles.has(candidate));
}

function addTestRelationship(
  path: string,
  knownFiles: Set<string>,
  relationships: Map<string, WorkspaceInspectRelationship>,
  warnings: Set<AnalysisWarning>
): void {
  const source = path.replace(/\.(?:test|spec)(?=\.[^.]+$)/, "");
  if (source === path || !knownFiles.has(source)) return;
  addRelationship(relationships, { from: path, to: source, kind: "tests" }, warnings);
}

function addSymbol(
  symbols: WorkspaceInspectSymbol[],
  symbol: WorkspaceInspectSymbol,
  warnings: Set<AnalysisWarning>
): void {
  if (symbols.length >= MAX_ANALYSIS_SYMBOLS) {
    warnings.add("INSPECT_SYMBOL_LIMIT_REACHED");
    return;
  }
  symbols.push(symbol);
}

function addRelationship(
  relationships: Map<string, WorkspaceInspectRelationship>,
  relationship: WorkspaceInspectRelationship,
  warnings: Set<AnalysisWarning>
): void {
  const key = `${relationship.from}\0${relationship.to}\0${relationship.kind}`;
  if (relationships.has(key)) return;
  if (relationships.size >= MAX_ANALYSIS_RELATIONSHIPS) {
    warnings.add("INSPECT_RELATIONSHIP_LIMIT_REACHED");
    return;
  }
  relationships.set(key, relationship);
}

function isSourcePath(path: string): boolean {
  return SOURCE_EXTENSIONS.has(posix.extname(path).toLowerCase());
}

function compareSymbols(left: WorkspaceInspectSymbol, right: WorkspaceInspectSymbol): number {
  return (
    compareText(left.path, right.path) ||
    left.line - right.line ||
    compareText(left.kind, right.kind) ||
    compareText(left.name, right.name)
  );
}

function compareRelationships(left: WorkspaceInspectRelationship, right: WorkspaceInspectRelationship): number {
  return compareText(left.from, right.from) || compareText(left.to, right.to) || compareText(left.kind, right.kind);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
