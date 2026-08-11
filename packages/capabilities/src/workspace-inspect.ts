import type { CapabilityTreeEntry, WorkspaceInspectionAdapter } from "./adapters.js";
import {
  CAPABILITY_SCHEMA_VERSION,
  DEFAULT_INSPECT_MAX_ENTRIES,
  MAX_INSPECT_MAX_ENTRIES,
  type WorkspaceInspectArea,
  type WorkspaceInspectEntrypoint,
  type WorkspaceInspectInput,
  type WorkspaceInspectManifest,
  type WorkspaceInspectResult
} from "./contracts.js";

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  [".ts", "TypeScript"],
  [".tsx", "TypeScript"],
  [".js", "JavaScript"],
  [".rs", "Rust"],
  [".py", "Python"],
  [".json", "JSON"],
  [".md", "Markdown"]
]);

export async function inspectWorkspace(
  workspace: WorkspaceInspectionAdapter,
  input: WorkspaceInspectInput
): Promise<WorkspaceInspectResult> {
  const maxEntries = input.maxEntries ?? DEFAULT_INSPECT_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || maxEntries > MAX_INSPECT_MAX_ENTRIES) {
    throw new TypeError(`workspace.inspect maxEntries must be between 1 and ${MAX_INSPECT_MAX_ENTRIES}`);
  }

  const root = input.path ?? ".";
  const treeResult = await workspace.tree(input.workspaceId, root, maxEntries);
  const tree = [...treeResult.entries].sort(compareTreeEntries);
  const adapterExceededBound = tree.length > maxEntries;
  const entries = tree.slice(0, maxEntries);

  const warnings: string[] = [];
  const projectTypes = detectProjectTypes(entries, root);
  const languages = countLanguages(entries);
  const entrypoints = detectEntrypoints(entries);
  const workspaceMemberPatterns = await readWorkspaceMemberPatterns(
    workspace,
    input.workspaceId,
    root,
    entries,
    warnings
  );
  const areas = detectAreas(entries, workspaceMemberPatterns);
  const manifests = detectManifests(entries);
  const truncated = treeResult.truncated || adapterExceededBound;

  if (truncated) warnings.push("INSPECT_MAX_ENTRIES_REACHED");

  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    root,
    projectTypes,
    languages,
    entrypoints,
    areas,
    manifests,
    warnings,
    truncated
  };
}

function detectProjectTypes(entries: CapabilityTreeEntry[], root: string): string[] {
  const filePaths = new Set(entries.filter(isFile).map(({ path }) => path));
  const hasPackageJson = filePaths.has(rootManifestPath(root, "package.json"));
  const hasPnpmWorkspace = filePaths.has(rootManifestPath(root, "pnpm-workspace.yaml"));
  const hasCargoManifest = filePaths.has(rootManifestPath(root, "Cargo.toml"));
  const projectTypes: string[] = [];

  if (hasPnpmWorkspace) projectTypes.push("node-pnpm");
  else if (hasPackageJson) projectTypes.push("node");
  if (hasCargoManifest) projectTypes.push("rust-cargo");

  return projectTypes.sort(compareText);
}

const ROOT_MANIFEST_MAX_BYTES = 64 * 1024;

async function readWorkspaceMemberPatterns(
  workspace: WorkspaceInspectionAdapter,
  workspaceId: string,
  root: string,
  entries: CapabilityTreeEntry[],
  warnings: string[]
): Promise<string[]> {
  const packageJsonPath = rootManifestPath(root, "package.json");
  if (!entries.some((entry) => entry.kind === "file" && entry.path === packageJsonPath)) {
    return [];
  }

  try {
    const read = await workspace.readFile(workspaceId, packageJsonPath, {
      offset: 0,
      maxBytes: ROOT_MANIFEST_MAX_BYTES
    });
    if (!read.eof) {
      warnings.push("PACKAGE_JSON_METADATA_TRUNCATED");
      return [];
    }
    const parsed = JSON.parse(read.contents) as unknown;
    if (!isRecord(parsed)) {
      warnings.push("PACKAGE_JSON_METADATA_INVALID");
      return [];
    }
    const workspaceValue = parsed.workspaces;
    const rawPatterns = Array.isArray(workspaceValue)
      ? workspaceValue
      : isRecord(workspaceValue) && Array.isArray(workspaceValue.packages)
        ? workspaceValue.packages
        : [];
    return rawPatterns
      .filter((value): value is string => typeof value === "string")
      .map((pattern) => normalizeWorkspaceMemberPattern(root, pattern))
      .filter((pattern): pattern is string => pattern !== undefined)
      .sort(compareText);
  } catch {
    warnings.push("PACKAGE_JSON_METADATA_INVALID");
    return [];
  }
}

function normalizeWorkspaceMemberPattern(root: string, pattern: string): string | undefined {
  const normalized = pattern.replace(/^\.\//, "").replace(/\/$/, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.startsWith("!") ||
    normalized.split("/").includes("..") ||
    (normalized.includes("*") && !normalized.endsWith("/*")) ||
    normalized.slice(0, -2).includes("*")
  ) {
    return undefined;
  }
  return root === "." ? normalized : `${root.replace(/\/$/, "")}/${normalized}`;
}

function countLanguages(entries: CapabilityTreeEntry[]): Array<{ name: string; fileCount: number }> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!isFile(entry)) continue;
    const language = LANGUAGE_BY_EXTENSION.get(extension(entry.path).toLowerCase());
    if (language === undefined) continue;
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([name, fileCount]) => ({ name, fileCount }))
    .sort((left, right) => compareText(left.name, right.name));
}

function detectEntrypoints(entries: CapabilityTreeEntry[]): WorkspaceInspectEntrypoint[] {
  const found = new Map<string, WorkspaceInspectEntrypoint>();
  for (const entry of entries) {
    if (!isFile(entry)) continue;
    const kind = entrypointKind(entry.path);
    if (kind !== undefined) found.set(`${entry.path}\0${kind}`, { path: entry.path, kind });
  }
  return [...found.values()].sort(comparePathThenKind);
}

function detectManifests(entries: CapabilityTreeEntry[]): WorkspaceInspectManifest[] {
  const found = new Map<string, WorkspaceInspectManifest>();
  for (const entry of entries) {
    if (!isFile(entry)) continue;
    const kind = manifestKind(entry.path);
    if (kind !== undefined) found.set(`${entry.path}\0${kind}`, { path: entry.path, kind });
  }
  return [...found.values()].sort(comparePathThenKind);
}

function detectAreas(
  entries: CapabilityTreeEntry[],
  workspaceMemberPatterns: string[]
): WorkspaceInspectArea[] {
  const areas = new Map<string, WorkspaceInspectArea>();

  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    if (entry.kind === "directory") {
      const conventional = conventionalArea(segments);
      if (conventional !== undefined) {
        areas.set(conventional.path, conventional);
        continue;
      }
      if (workspaceMemberPatterns.some((pattern) => matchesWorkspaceMember(entry.path, pattern))) {
        areas.set(entry.path, { path: entry.path, kind: "package" });
        continue;
      }
      if (segments.length === 1 && !["apps", "packages", "crates", "tests", "docs", ".github"].includes(segments[0]!)) {
        areas.set(entry.path, { path: entry.path, kind: "other" });
      }
      continue;
    }

    if (entry.kind === "file" && isKnownConfig(entry.path)) {
      areas.set(entry.path, { path: entry.path, kind: "config" });
    }
  }

  return [...areas.values()].sort((left, right) => compareText(left.path, right.path));
}

function conventionalArea(segments: string[]): WorkspaceInspectArea | undefined {
  const [top, child] = segments;
  if (top === "apps" && child !== undefined && segments.length === 2) {
    return { path: `apps/${child}`, kind: "app" };
  }
  if (top === "packages" && child !== undefined && segments.length === 2) {
    return { path: `packages/${child}`, kind: "package" };
  }
  if (top === "crates" && child !== undefined && segments.length === 2) {
    return { path: `crates/${child}`, kind: "crate" };
  }
  if (top === "tests" && segments.length <= 2) {
    return { path: child === undefined ? "tests" : `tests/${child}`, kind: "test" };
  }
  if (top === "docs" && segments.length <= 2) {
    return { path: child === undefined ? "docs" : `docs/${child}`, kind: "docs" };
  }
  return undefined;
}

function entrypointKind(path: string): string | undefined {
  const name = basename(path);
  if (name === "package.json") return "node-manifest";
  if (name === "pnpm-workspace.yaml") return "pnpm-workspace";
  if (name === "Cargo.toml") return "cargo-manifest";
  if (isTypeScriptConfig(name)) return "typescript-config";
  if (isVitestConfig(name)) return "vitest-config";
  if (path.startsWith(".github/workflows/")) return "github-workflow";
  return undefined;
}

function manifestKind(path: string): string | undefined {
  const name = basename(path);
  if (name === "package.json") return "node-package";
  if (name === "pnpm-workspace.yaml") return "pnpm-workspace";
  if (name === "Cargo.toml") return "cargo-manifest";
  return undefined;
}

function matchesWorkspaceMember(path: string, pattern: string): boolean {
  if (!pattern.endsWith("/*")) return path === pattern;
  const prefix = pattern.slice(0, -1);
  if (!path.startsWith(prefix)) return false;
  const remainder = path.slice(prefix.length);
  return remainder.length > 0 && !remainder.includes("/");
}

function rootManifestPath(root: string, name: string): string {
  return root === "." ? name : `${root.replace(/\/$/, "")}/${name}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKnownConfig(path: string): boolean {
  const name = basename(path);
  return isTypeScriptConfig(name) || isVitestConfig(name) || path.startsWith(".github/workflows/");
}

function isTypeScriptConfig(name: string): boolean {
  return name === "tsconfig.json" || (name.startsWith("tsconfig.") && name.endsWith(".json"));
}

function isVitestConfig(name: string): boolean {
  return name.startsWith("vitest.config.");
}

function isFile(entry: CapabilityTreeEntry): boolean {
  return entry.kind === "file";
}

function extension(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index);
}

function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

function compareTreeEntries(left: CapabilityTreeEntry, right: CapabilityTreeEntry): number {
  return compareText(left.path, right.path) || compareText(left.kind, right.kind);
}

function comparePathThenKind(
  left: { path: string; kind: string },
  right: { path: string; kind: string }
): number {
  return compareText(left.path, right.path) || compareText(left.kind, right.kind);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
