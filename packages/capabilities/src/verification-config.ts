import type { VerificationWorkspaceAdapter } from "./adapters.js";
import type { VerificationCategory } from "./contracts.js";
import { CapabilityError } from "./errors.js";

const CONFIG_PATH = ".kodegpt/verify.json";
const CONFIG_MAX_BYTES = 64 * 1024;
const CONFIG_SCHEMA_VERSION = 1;
const MAX_CONFIG_RECIPES = 32;
const MAX_RECIPE_KEY_CHARS = 64;
const MAX_LABEL_BYTES = 120;
const MAX_ARGV_ITEMS = 64;
const MAX_ARG_BYTES = 4096;
const MAX_CWD_BYTES = 4096;
const RECIPE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOGICAL_EXECUTABLE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CATEGORIES = new Set<VerificationCategory>([
  "test",
  "lint",
  "typecheck",
  "build",
  "format-check",
  "custom"
]);

export interface ConfigVerificationDefinition {
  id: `config:${string}`;
  label: string;
  category: VerificationCategory;
  logicalExecutable: string;
  argv: string[];
  cwd: string;
  source: "kodegpt-config";
}

export async function readVerificationConfig(
  workspace: VerificationWorkspaceAdapter,
  workspaceId: string
): Promise<ConfigVerificationDefinition[]> {
  let identity;
  try {
    identity = await workspace.pathIdentity(workspaceId, CONFIG_PATH);
  } catch {
    throw discoveryError();
  }
  if (!identity.exists) return [];
  if (
    identity.kind !== "file" ||
    (identity.sizeBytes !== undefined && identity.sizeBytes > CONFIG_MAX_BYTES)
  ) {
    throw discoveryError();
  }

  let file;
  try {
    file = await workspace.readFile(workspaceId, CONFIG_PATH, {
      offset: 0,
      maxBytes: CONFIG_MAX_BYTES
    });
  } catch {
    throw discoveryError();
  }
  const actualBytes = Buffer.byteLength(file.contents, "utf8");
  if (
    !file.eof ||
    file.bytesRead !== actualBytes ||
    actualBytes > CONFIG_MAX_BYTES ||
    (identity.sizeBytes !== undefined && identity.sizeBytes !== actualBytes)
  ) {
    throw discoveryError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(file.contents) as unknown;
  } catch {
    throw discoveryError();
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["schemaVersion", "recipes"])) {
    throw discoveryError();
  }
  if (parsed.schemaVersion !== CONFIG_SCHEMA_VERSION || !isRecord(parsed.recipes)) {
    throw discoveryError();
  }

  const recipeEntries = Object.entries(parsed.recipes);
  if (recipeEntries.length > MAX_CONFIG_RECIPES) throw discoveryError();
  recipeEntries.sort(([left], [right]) => compareText(left, right));
  return recipeEntries.map(([key, value]) => parseRecipe(key, value));
}

function parseRecipe(key: string, value: unknown): ConfigVerificationDefinition {
  if (
    key.length > MAX_RECIPE_KEY_CHARS ||
    !RECIPE_KEY.test(key) ||
    !isRecord(value) ||
    !hasExactKeys(value, ["label", "category", "logicalExecutable", "argv", "cwd"])
  ) {
    throw discoveryError();
  }

  const { label, category, logicalExecutable, argv, cwd } = value;
  if (
    typeof label !== "string" ||
    Buffer.byteLength(label, "utf8") < 1 ||
    Buffer.byteLength(label, "utf8") > MAX_LABEL_BYTES ||
    typeof category !== "string" ||
    !isVerificationCategory(category) ||
    typeof logicalExecutable !== "string" ||
    !isSafeLogicalExecutable(logicalExecutable) ||
    !Array.isArray(argv) ||
    argv.length > MAX_ARGV_ITEMS ||
    !argv.every(
      (argument) =>
        typeof argument === "string" &&
        !argument.includes("\0") &&
        Buffer.byteLength(argument, "utf8") <= MAX_ARG_BYTES
    ) ||
    typeof cwd !== "string" ||
    !isSafeRecipeCwd(cwd)
  ) {
    throw discoveryError();
  }

  return {
    id: `config:${key}`,
    label,
    category,
    logicalExecutable,
    argv: [...argv] as string[],
    cwd,
    source: "kodegpt-config"
  };
}

function isVerificationCategory(value: string): value is VerificationCategory {
  return CATEGORIES.has(value as VerificationCategory);
}

function isSafeLogicalExecutable(value: string): boolean {
  return (
    value !== "bash" &&
    value !== "sh" &&
    value !== "." &&
    value !== ".." &&
    !value.includes("\0") &&
    LOGICAL_EXECUTABLE.test(value)
  );
}

function isSafeRecipeCwd(value: string): boolean {
  if (Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > MAX_CWD_BYTES) {
    return false;
  }
  if (value === ".") return true;
  return (
    !value.startsWith("/") &&
    !value.includes("\0") &&
    value
      .split("/")
      .every((component) => component.length > 0 && component !== "." && component !== "..")
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function discoveryError(): CapabilityError {
  return new CapabilityError("VERIFICATION_DISCOVERY_INVALID", "Verification discovery is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
