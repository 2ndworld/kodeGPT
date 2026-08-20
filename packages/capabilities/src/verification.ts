import type {
  VerificationAvailabilityAdapter,
  VerificationExecutionAdapter,
  VerificationWorkspaceAdapter
} from "./adapters.js";
import {
  CAPABILITY_SCHEMA_VERSION,
  type VerificationCategory,
  type VerificationRecipe,
  type VerifyListInput,
  type VerifyListResult,
  type VerifyRunInput,
  type VerifyRunResult
} from "./contracts.js";
import { CapabilityError } from "./errors.js";
import { isSemanticDiscoveryPath } from "./semantic-scope.js";
import { readVerificationConfig } from "./verification-config.js";

const PACKAGE_JSON = "package.json";
const CARGO_TOML = "Cargo.toml";
const MANIFEST_READ_MAX_BYTES = 64 * 1024;
const MAX_VERIFICATION_PROJECT_MANIFESTS = 128;
const VERIFICATION_TREE_MAX_ENTRIES = 10_000;
const ROOT_EVIDENCE_PATHS = [
  "package.json",
  "Cargo.toml",
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb"
] as const;

const PACKAGE_RECIPES = [
  { script: "test", label: "Package test", category: "test" },
  { script: "lint", label: "Package lint", category: "lint" },
  { script: "typecheck", label: "Package typecheck", category: "typecheck" },
  { script: "build", label: "Package build", category: "build" }
] as const satisfies ReadonlyArray<{
  script: string;
  label: string;
  category: VerificationCategory;
}>;

const CARGO_RECIPES = [
  {
    id: "cargo:test",
    label: "Cargo test",
    category: "test",
    logicalExecutable: "cargo",
    argv: ["test", "--workspace"],
    cwd: ".",
    source: "cargo"
  },
  {
    id: "cargo:check",
    label: "Cargo check",
    category: "typecheck",
    logicalExecutable: "cargo",
    argv: ["check", "--workspace"],
    cwd: ".",
    source: "cargo"
  },
  {
    id: "cargo:fmt-check",
    label: "Cargo fmt check",
    category: "format-check",
    logicalExecutable: "cargo",
    argv: ["fmt", "--all", "--", "--check"],
    cwd: ".",
    source: "cargo"
  }
] as const satisfies ReadonlyArray<RecipeLaunchDefinition>;

const CARGO_PROJECT_RECIPES = [
  { suffix: "test", label: "Cargo test", category: "test", argv: ["test", "--manifest-path", CARGO_TOML] },
  { suffix: "check", label: "Cargo check", category: "typecheck", argv: ["check", "--manifest-path", CARGO_TOML] }
] as const satisfies ReadonlyArray<{
  suffix: "test" | "check";
  label: string;
  category: VerificationCategory;
  argv: readonly string[];
}>;

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";
type RecipeLaunchDefinition = Omit<VerificationRecipe, "allowed" | "blockedReason"> & {
  logicalExecutable: string;
  argv: string[];
  cwd: string;
};
type PolicySnapshot = {
  allowProcess: boolean;
  allowDynamicExecutables: boolean;
  allowedExecutableNames: ReadonlySet<string>;
};
type ManagerResolution =
  | { kind: "resolved"; manager: PackageManager }
  | { kind: "unknown" }
  | { kind: "conflict" };
type ProjectKind = "package" | "cargo";
type ProjectManifests = {
  packagePaths: string[];
  cargoPaths: string[];
};

export async function listVerifications(
  workspace: VerificationWorkspaceAdapter,
  availability: VerificationAvailabilityAdapter,
  input: VerifyListInput
): Promise<VerifyListResult> {
  validateListInput(input);

  const evidence = new Map<string, boolean>();
  try {
    for (const path of ROOT_EVIDENCE_PATHS) {
      const identity = await workspace.pathIdentity(input.workspaceId, path);
      evidence.set(path, identity.exists && identity.kind === "file");
    }
  } catch {
    throw discoveryError();
  }

  const manifests = await discoverProjectManifests(workspace, input.workspaceId);
  if (
    (evidence.get(PACKAGE_JSON) === true) !== manifests.packagePaths.includes(PACKAGE_JSON) ||
    (evidence.get(CARGO_TOML) === true) !== manifests.cargoPaths.includes(CARGO_TOML)
  ) {
    throw discoveryError();
  }

  const activeKinds = activeProjectKinds(input.target, manifests);
  const effectivePolicy = workspace.effectivePolicy(input.workspaceId);
  const policy: PolicySnapshot = {
    allowProcess: effectivePolicy.allowProcess,
    allowDynamicExecutables: effectivePolicy.allowDynamicExecutables,
    allowedExecutableNames: new Set(effectivePolicy.allowedExecutableNames)
  };
  const configuredRecipes = await readVerificationConfig(workspace, input.workspaceId);
  const recipes: VerificationRecipe[] = [];
  const packagePaths = scopedManifestPaths(
    "package",
    manifests.packagePaths,
    input.target,
    activeKinds
  );
  const cargoPaths = scopedManifestPaths("cargo", manifests.cargoPaths, input.target, activeKinds);
  const rootPackageJson = packagePaths.includes(PACKAGE_JSON)
    ? await readPackageManifest(workspace, input.workspaceId, PACKAGE_JSON)
    : undefined;
  const rootManager = resolvePackageManager(rootPackageJson ?? {}, evidence);

  for (const manifestPath of packagePaths) {
    const projectDir = manifestDirectory(manifestPath);
    const packageJson =
      manifestPath === PACKAGE_JSON
        ? rootPackageJson!
        : await readPackageManifest(workspace, input.workspaceId, manifestPath);
    const manager =
      manifestPath === PACKAGE_JSON
        ? rootManager
        : resolveNestedPackageManager(packageJson, evidence, rootManager);
    const scripts = packageScripts(packageJson);
    recipes.push(
      ...(await packageRecipes(
        input.workspaceId,
        scripts,
        manager,
        policy,
        availability,
        projectDir
      ))
    );
  }

  for (const manifestPath of cargoPaths) {
    if (manifestPath === CARGO_TOML) {
      recipes.push(
        ...(await Promise.all(
          CARGO_RECIPES.map((recipe) =>
            withStaticAvailability(
              input.workspaceId,
              { ...recipe, argv: [...recipe.argv] },
              policy,
              availability
            )
          )
        ))
      );
      continue;
    }
    const projectDir = manifestDirectory(manifestPath);
    recipes.push(...(await cargoProjectRecipes(input.workspaceId, projectDir, policy, availability)));
  }

  recipes.push(
    ...(await Promise.all(
      configuredRecipes.map((recipe) =>
        withStaticAvailability(
          input.workspaceId,
          { ...recipe, argv: [...recipe.argv] },
          policy,
          availability
        )
      )
    ))
  );

  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    recipes
  };
}

export async function runVerification(
  workspace: VerificationWorkspaceAdapter,
  availability: VerificationAvailabilityAdapter,
  execution: VerificationExecutionAdapter,
  input: VerifyRunInput
): Promise<VerifyRunResult> {
  validateRunInput(input);
  const current = await listVerifications(workspace, availability, {
    workspaceId: input.workspaceId
  });
  const recipe = current.recipes.find((candidate) => candidate.id === input.recipeId);
  if (recipe === undefined) {
    throw new CapabilityError("VERIFICATION_NOT_FOUND", "Verification recipe was not found");
  }
  if (
    !recipe.allowed ||
    recipe.logicalExecutable === undefined ||
    recipe.argv === undefined ||
    recipe.cwd === undefined
  ) {
    throw new CapabilityError("VERIFICATION_NOT_ALLOWED", "Verification recipe is not allowed");
  }

  const operation = await execution.run({
    workspaceId: input.workspaceId,
    recipeId: recipe.id,
    logicalExecutable: recipe.logicalExecutable,
    argv: [...recipe.argv],
    cwd: recipe.cwd,
    ...(input.background === undefined ? {} : { background: input.background })
  });

  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    recipe,
    operation
  };
}

async function discoverProjectManifests(
  workspace: VerificationWorkspaceAdapter,
  workspaceId: string
): Promise<ProjectManifests> {
  let tree;
  try {
    tree = await workspace.tree(workspaceId, ".", VERIFICATION_TREE_MAX_ENTRIES, "semantic");
  } catch {
    throw discoveryError();
  }
  if (tree.truncated) throw discoveryError();

  const manifestPaths = [...new Set(
    tree.entries
      .filter(
        (entry) =>
          entry.kind === "file" &&
          (basename(entry.path) === PACKAGE_JSON || basename(entry.path) === CARGO_TOML)
      )
      .map((entry) => entry.path)
      .filter(isSemanticDiscoveryPath)
  )].sort(compareText);
  if (manifestPaths.length > MAX_VERIFICATION_PROJECT_MANIFESTS) throw discoveryError();

  const packagePaths = manifestPaths.filter((path) => basename(path) === PACKAGE_JSON);
  const cargoPaths = manifestPaths.filter((path) => basename(path) === CARGO_TOML);
  moveRootFirst(packagePaths, PACKAGE_JSON);
  moveRootFirst(cargoPaths, CARGO_TOML);
  return { packagePaths, cargoPaths };
}

async function readPackageManifest(
  workspace: VerificationWorkspaceAdapter,
  workspaceId: string,
  path: string
): Promise<Record<string, unknown>> {
  let manifest;
  try {
    manifest = await workspace.readFile(workspaceId, path, {
      offset: 0,
      maxBytes: MANIFEST_READ_MAX_BYTES
    });
  } catch {
    throw discoveryError();
  }
  const actualBytes = Buffer.byteLength(manifest.contents, "utf8");
  if (
    !manifest.eof ||
    manifest.bytesRead !== actualBytes ||
    actualBytes > MANIFEST_READ_MAX_BYTES
  ) {
    throw discoveryError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.contents);
  } catch {
    throw discoveryError();
  }
  if (!isRecord(parsed)) throw discoveryError();
  return parsed;
}

function packageScripts(packageJson: Record<string, unknown>): Record<string, unknown> {
  return isRecord(packageJson.scripts) ? packageJson.scripts : {};
}

async function packageRecipes(
  workspaceId: string,
  scripts: Record<string, unknown>,
  manager: ManagerResolution,
  policy: PolicySnapshot,
  availability: VerificationAvailabilityAdapter,
  projectDir: string
): Promise<VerificationRecipe[]> {
  const definitions = PACKAGE_RECIPES.filter(
    (definition) => typeof scripts[definition.script] === "string"
  );

  if (manager.kind !== "resolved") {
    const blockedReason =
      manager.kind === "conflict" ? "PACKAGE_MANAGER_CONFLICT" : "PACKAGE_MANAGER_UNKNOWN";
    return definitions.map((definition) => ({
      id: packageRecipeId(projectDir, definition.script),
      label: definition.label,
      category: definition.category,
      source: "package-script",
      allowed: false,
      blockedReason
    }));
  }

  return Promise.all(
    definitions.map((definition) =>
      withStaticAvailability(
        workspaceId,
        {
          id: packageRecipeId(projectDir, definition.script),
          label: definition.label,
          category: definition.category,
          logicalExecutable: manager.manager,
          argv: ["run", definition.script],
          cwd: projectDir,
          source: "package-script"
        },
        policy,
        availability
      )
    )
  );
}

async function cargoProjectRecipes(
  workspaceId: string,
  projectDir: string,
  policy: PolicySnapshot,
  availability: VerificationAvailabilityAdapter
): Promise<VerificationRecipe[]> {
  return Promise.all(
    CARGO_PROJECT_RECIPES.map((definition) =>
      withStaticAvailability(
        workspaceId,
        {
          id: `cargo:${projectDir}:${definition.suffix}`,
          label: `${definition.label} (${projectDir})`,
          category: definition.category,
          logicalExecutable: "cargo",
          argv: [...definition.argv],
          cwd: projectDir,
          source: "cargo"
        },
        policy,
        availability
      )
    )
  );
}

function activeProjectKinds(
  target: string | undefined,
  manifests: ProjectManifests
): ReadonlySet<ProjectKind> | undefined {
  if (target === undefined) return undefined;
  const candidates = [
    ...manifests.packagePaths.map((path) => ({ kind: "package" as const, dir: manifestDirectory(path) })),
    ...manifests.cargoPaths.map((path) => ({ kind: "cargo" as const, dir: manifestDirectory(path) }))
  ].filter(({ dir }) => projectContainsTarget(dir, target));
  if (candidates.length === 0) return new Set<ProjectKind>();
  const maxDepth = Math.max(...candidates.map(({ dir }) => projectDepth(dir)));
  return new Set(candidates.filter(({ dir }) => projectDepth(dir) === maxDepth).map(({ kind }) => kind));
}

function scopedManifestPaths(
  kind: ProjectKind,
  paths: readonly string[],
  target: string | undefined,
  activeKinds: ReadonlySet<ProjectKind> | undefined
): string[] {
  if (target === undefined) return [...paths];
  if (activeKinds?.has(kind) !== true) return [];
  return paths
    .filter((path) => projectContainsTarget(manifestDirectory(path), target))
    .sort((left, right) => {
      const depth = projectDepth(manifestDirectory(right)) - projectDepth(manifestDirectory(left));
      return depth === 0 ? compareText(left, right) : depth;
    });
}

function projectContainsTarget(projectDir: string, target: string): boolean {
  return projectDir === "." || target === projectDir || target.startsWith(`${projectDir}/`);
}

function projectDepth(projectDir: string): number {
  return projectDir === "." ? 0 : projectDir.split("/").length;
}

function moveRootFirst(paths: string[], rootManifest: string): void {
  const rootIndex = paths.indexOf(rootManifest);
  if (rootIndex > 0) {
    paths.splice(rootIndex, 1);
    paths.unshift(rootManifest);
  }
}

function resolvePackageManager(
  packageJson: Record<string, unknown>,
  evidence: ReadonlyMap<string, boolean>
): ManagerResolution {
  const explicit = parseExplicitManager(packageJson.packageManager);
  const lockManagers = new Set<PackageManager>();
  if (evidence.get("pnpm-lock.yaml") === true) lockManagers.add("pnpm");
  if (
    evidence.get("package-lock.json") === true ||
    evidence.get("npm-shrinkwrap.json") === true
  ) {
    lockManagers.add("npm");
  }
  if (evidence.get("yarn.lock") === true) lockManagers.add("yarn");
  if (evidence.get("bun.lock") === true || evidence.get("bun.lockb") === true) {
    lockManagers.add("bun");
  }

  if (explicit !== undefined) {
    if (lockManagers.size > 1 || (lockManagers.size === 1 && !lockManagers.has(explicit))) {
      return { kind: "conflict" };
    }
    return { kind: "resolved", manager: explicit };
  }
  if (lockManagers.size > 1) return { kind: "conflict" };
  const [manager] = [...lockManagers];
  return manager === undefined ? { kind: "unknown" } : { kind: "resolved", manager };
}

function resolveNestedPackageManager(
  packageJson: Record<string, unknown>,
  evidence: ReadonlyMap<string, boolean>,
  rootManager: ManagerResolution
): ManagerResolution {
  const local = resolvePackageManager(packageJson, evidence);
  if (local.kind !== "unknown") return local;
  return rootManager.kind === "resolved" ? rootManager : local;
}

function packageRecipeId(projectDir: string, script: string): string {
  return projectDir === "." ? `package:${script}` : `package:${projectDir}:${script}`;
}

function manifestDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "." : path.slice(0, index);
}

function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseExplicitManager(value: unknown): PackageManager | undefined {
  if (typeof value !== "string") return undefined;
  const separator = value.indexOf("@");
  const name = separator === -1 ? value : value.slice(0, separator);
  return isPackageManager(name) ? name : undefined;
}

function isPackageManager(value: string): value is PackageManager {
  return value === "pnpm" || value === "npm" || value === "yarn" || value === "bun";
}

async function withStaticAvailability(
  workspaceId: string,
  recipe: RecipeLaunchDefinition,
  policy: PolicySnapshot,
  availability: VerificationAvailabilityAdapter
): Promise<VerificationRecipe> {
  if (!policy.allowProcess) {
    return { ...recipe, allowed: false, blockedReason: "PROCESS_NOT_ALLOWED" };
  }
  if (
    !policy.allowedExecutableNames.has(recipe.logicalExecutable) &&
    !policy.allowDynamicExecutables
  ) {
    return { ...recipe, allowed: false, blockedReason: "EXECUTABLE_NOT_ALLOWED" };
  }

  let available;
  try {
    available = await availability.inspectExecutable(workspaceId, recipe.logicalExecutable);
  } catch {
    return { ...recipe, allowed: false, blockedReason: "EXECUTABLE_UNAVAILABLE" };
  }
  if (!available.executableAvailable) {
    return { ...recipe, allowed: false, blockedReason: "EXECUTABLE_UNAVAILABLE" };
  }
  if (!available.sandboxAvailable) {
    return { ...recipe, allowed: false, blockedReason: "SANDBOX_UNAVAILABLE" };
  }
  return { ...recipe, allowed: true };
}

function validateListInput(input: VerifyListInput): void {
  if (
    input.workspaceId.length === 0 ||
    (input.target !== undefined && !isSafeRelativeTarget(input.target))
  ) {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "verify.list input is invalid");
  }
}

function isSafeRelativeTarget(target: string): boolean {
  return (
    target.length > 0 &&
    !target.startsWith("/") &&
    target.split("/").every((component) => component.length > 0 && component !== "." && component !== "..")
  );
}

function validateRunInput(input: VerifyRunInput): void {
  validateListInput(input);
  if (input.recipeId.length === 0) {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "verify.run input is invalid");
  }
}

function discoveryError(): CapabilityError {
  return new CapabilityError("VERIFICATION_DISCOVERY_INVALID", "Verification discovery is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
