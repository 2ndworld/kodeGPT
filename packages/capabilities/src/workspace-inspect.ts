import type { CapabilityTreeEntry, CapabilityWorkspaceAdapter } from "./adapters.js";
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
  workspace: CapabilityWorkspaceAdapter,
  input: WorkspaceInspectInput
): Promise<WorkspaceInspectResult> {
  const maxEntries = input.maxEntries ?? DEFAULT_INSPECT_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || maxEntries > MAX_INSPECT_MAX_ENTRIES) {
    throw new TypeError(`workspace.inspect maxEntries must be between 1 and ${MAX_INSPECT_MAX_ENTRIES}`);
  }

  const root = input.path ?? ".";
  workspace.info(input.workspaceId);

  const tree = [...(await workspace.tree(input.workspaceId, root))].sort(compareTreeEntries);
  const inspectBoundReached = tree.length > maxEntries;
  const workspaceTreeBoundReached =
    tree.length >= DEFAULT_INSPECT_MAX_ENTRIES && maxEntries >= DEFAULT_INSPECT_MAX_ENTRIES;
  const entries = tree.slice(0, maxEntries);

  const projectTypes = detectProjectTypes(entries);
  const languages = countLanguages(entries);
  const entrypoints = detectEntrypoints(entries);
  const areas = detectAreas(entries);
  const manifests = detectManifests(entries);
  const warnings: string[] = [];

  if (inspectBoundReached) warnings.push("INSPECT_MAX_ENTRIES_REACHED");
  if (workspaceTreeBoundReached) warnings.push("WORKSPACE_TREE_LIMIT_REACHED");

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
    truncated: inspectBoundReached || workspaceTreeBoundReached
  };
}

function detectProjectTypes(entries: CapabilityTreeEntry[]): string[] {
  const filePaths = new Set(entries.filter(isFile).map(({ path }) => path));
  const hasPackageJson = [...filePaths].some((path) => basename(path) === "package.json");
  const hasPnpmWorkspace = [...filePaths].some((path) => basename(path) === "pnpm-workspace.yaml");
  const hasCargoManifest = [...filePaths].some((path) => basename(path) === "Cargo.toml");
  const projectTypes: string[] = [];

  if (hasPnpmWorkspace) projectTypes.push("node-pnpm");
  else if (hasPackageJson) projectTypes.push("node");
  if (hasCargoManifest) projectTypes.push("rust-cargo");

  return projectTypes.sort(compareText);
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

function detectAreas(entries: CapabilityTreeEntry[]): WorkspaceInspectArea[] {
  const areas = new Map<string, WorkspaceInspectArea>();

  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    if (entry.kind === "directory") {
      const conventional = conventionalArea(segments);
      if (conventional !== undefined) {
        areas.set(conventional.path, conventional);
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
