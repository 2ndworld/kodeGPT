import type {
  CapabilityExecutionAdapter,
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

const MANIFEST_READ_MAX_BYTES = 64 * 1024;
const MANIFEST_TREE_MAX_ENTRIES = 10_000;

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
] as const satisfies ReadonlyArray<Omit<VerificationRecipe, "allowed" | "blockedReason">>;

export class VerificationRecipeError extends Error {
  readonly code: "VERIFICATION_RECIPE_NOT_FOUND" | "VERIFICATION_RECIPE_BLOCKED";

  constructor(
    code: "VERIFICATION_RECIPE_NOT_FOUND" | "VERIFICATION_RECIPE_BLOCKED",
    message: string
  ) {
    super(message);
    this.name = "VerificationRecipeError";
    this.code = code;
  }
}

export async function listVerifications(
  workspace: VerificationWorkspaceAdapter,
  input: VerifyListInput
): Promise<VerifyListResult> {
  validateListInput(input);
  const tree = await workspace.tree(input.workspaceId, ".", MANIFEST_TREE_MAX_ENTRIES);
  if (tree.truncated) {
    throw new Error("Verification manifest discovery is truncated");
  }
  const rootFiles = new Set(
    tree.entries
      .filter((entry) => entry.kind === "file" && !entry.path.includes("/"))
      .map((entry) => entry.path)
  );
  const effectivePolicy = workspace.effectivePolicy(input.workspaceId);
  const policy = {
    allowProcess: effectivePolicy.allowProcess,
    allowedExecutableNames: new Set(effectivePolicy.allowedExecutableNames)
  };
  const recipes: VerificationRecipe[] = [];

  if (rootFiles.has("package.json")) {
    const packageJson = await workspace.readFile(input.workspaceId, "package.json", {
      offset: 0,
      maxBytes: MANIFEST_READ_MAX_BYTES
    });
    if (!packageJson.eof) {
      throw new Error("package.json exceeds verification manifest read limit");
    }
    recipes.push(...packageRecipes(packageJson.contents, policy));
  }

  if (rootFiles.has("Cargo.toml")) {
    recipes.push(
      ...CARGO_RECIPES.map((recipe) =>
        withPolicy(
          {
            ...recipe,
            argv: [...recipe.argv]
          },
          policy
        )
      )
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
  execution: CapabilityExecutionAdapter,
  input: VerifyRunInput
): Promise<VerifyRunResult> {
  validateRunInput(input);
  const current = await listVerifications(workspace, { workspaceId: input.workspaceId });
  const recipe = current.recipes.find((candidate) => candidate.id === input.recipeId);
  if (recipe === undefined) {
    throw new VerificationRecipeError(
      "VERIFICATION_RECIPE_NOT_FOUND",
      `Verification recipe was not found: ${input.recipeId}`
    );
  }
  if (!recipe.allowed) {
    throw new VerificationRecipeError(
      "VERIFICATION_RECIPE_BLOCKED",
      `Verification recipe is blocked by current policy: ${input.recipeId}`
    );
  }

  const operation = await execution.run({
    workspaceId: input.workspaceId,
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

function packageRecipes(
  contents: string,
  policy: { allowProcess: boolean; allowedExecutableNames: ReadonlySet<string> }
): VerificationRecipe[] {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("package.json is not valid JSON");
  }
  if (!isRecord(value) || !isRecord(value.scripts)) return [];

  const recipes: VerificationRecipe[] = [];
  for (const definition of PACKAGE_RECIPES) {
    if (typeof value.scripts[definition.script] !== "string") continue;
    recipes.push(
      withPolicy(
        {
          id: `package:${definition.script}`,
          label: definition.label,
          category: definition.category,
          logicalExecutable: "pnpm",
          argv: ["run", definition.script],
          cwd: ".",
          source: "package-script"
        },
        policy
      )
    );
  }
  return recipes;
}

function withPolicy(
  recipe: Omit<VerificationRecipe, "allowed" | "blockedReason">,
  policy: { allowProcess: boolean; allowedExecutableNames: ReadonlySet<string> }
): VerificationRecipe {
  if (!policy.allowProcess) {
    return {
      ...recipe,
      allowed: false,
      blockedReason: "PROCESS_NOT_ALLOWED"
    };
  }
  if (policy.allowedExecutableNames.has(recipe.logicalExecutable)) {
    return { ...recipe, allowed: true };
  }
  return {
    ...recipe,
    allowed: false,
    blockedReason: "EXECUTABLE_NOT_ALLOWED"
  };
}

function validateListInput(input: VerifyListInput): void {
  if (input.workspaceId.length === 0) {
    throw new TypeError("verify.list workspaceId must not be empty");
  }
}

function validateRunInput(input: VerifyRunInput): void {
  validateListInput(input);
  if (input.recipeId.length === 0) {
    throw new TypeError("verify.run recipeId must not be empty");
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
