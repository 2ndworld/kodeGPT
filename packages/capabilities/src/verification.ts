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

const MANIFEST_READ_MAX_BYTES = 64 * 1024;
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

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";
type RecipeLaunchDefinition = Omit<VerificationRecipe, "allowed" | "blockedReason"> & {
  logicalExecutable: string;
  argv: string[];
  cwd: string;
};
type PolicySnapshot = {
  allowProcess: boolean;
  allowedExecutableNames: ReadonlySet<string>;
};
type ManagerResolution =
  | { kind: "resolved"; manager: PackageManager }
  | { kind: "unknown" }
  | { kind: "conflict" };

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

  const effectivePolicy = workspace.effectivePolicy(input.workspaceId);
  const policy: PolicySnapshot = {
    allowProcess: effectivePolicy.allowProcess,
    allowedExecutableNames: new Set(effectivePolicy.allowedExecutableNames)
  };
  const recipes: VerificationRecipe[] = [];

  if (evidence.get("package.json") === true) {
    const packageJson = await readPackageManifest(workspace, input.workspaceId);
    const manager = resolvePackageManager(packageJson, evidence);
    const scripts = packageScripts(packageJson);
    recipes.push(
      ...(await packageRecipes(input.workspaceId, scripts, manager, policy, availability))
    );
  }

  if (evidence.get("Cargo.toml") === true) {
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
  }

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

async function readPackageManifest(
  workspace: VerificationWorkspaceAdapter,
  workspaceId: string
): Promise<Record<string, unknown>> {
  let manifest;
  try {
    manifest = await workspace.readFile(workspaceId, "package.json", {
      offset: 0,
      maxBytes: MANIFEST_READ_MAX_BYTES
    });
  } catch {
    throw discoveryError();
  }
  if (!manifest.eof) throw discoveryError();

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
  availability: VerificationAvailabilityAdapter
): Promise<VerificationRecipe[]> {
  const definitions = PACKAGE_RECIPES.filter(
    (definition) => typeof scripts[definition.script] === "string"
  );

  if (manager.kind !== "resolved") {
    const blockedReason =
      manager.kind === "conflict" ? "PACKAGE_MANAGER_CONFLICT" : "PACKAGE_MANAGER_UNKNOWN";
    return definitions.map((definition) => ({
      id: `package:${definition.script}`,
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
          id: `package:${definition.script}`,
          label: definition.label,
          category: definition.category,
          logicalExecutable: manager.manager,
          argv: ["run", definition.script],
          cwd: ".",
          source: "package-script"
        },
        policy,
        availability
      )
    )
  );
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
  if (!policy.allowedExecutableNames.has(recipe.logicalExecutable)) {
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
  if (input.workspaceId.length === 0) {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "verify.list input is invalid");
  }
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
