import { describe, expect, it } from "vitest";

import type { VerificationWorkspaceAdapter } from "./adapters.js";
import { readVerificationConfig } from "./verification-config.js";

const CONFIG_PATH = ".kodegpt/verify.json";

function workspace(
  text: string | undefined,
  options: {
    kind?: "file" | "directory" | "symlink" | "other";
    eof?: boolean;
    bytesRead?: number;
    sizeBytes?: number;
  } = {}
): VerificationWorkspaceAdapter {
  return {
    readFile: async (_workspaceId, path) => {
      if (path !== CONFIG_PATH || text === undefined) throw new Error(`unexpected read: ${path}`);
      return {
        contents: text,
        bytesRead: options.bytesRead ?? Buffer.byteLength(text, "utf8"),
        eof: options.eof ?? true
      };
    },
    tree: async () => ({ entries: [], truncated: false }),
    pathIdentity: async (_workspaceId, path) => {
      if (path !== CONFIG_PATH || text === undefined) return { exists: false, hashTruncated: false };
      return {
        exists: true,
        kind: options.kind ?? "file",
        sizeBytes: options.sizeBytes ?? Buffer.byteLength(text, "utf8"),
        hashTruncated: false
      };
    },
    effectivePolicy: () => ({
      allowProcess: true,
      allowDynamicExecutables: true,
      allowedExecutableNames: []
    })
  };
}

function document(recipes: Record<string, unknown>): string {
  return JSON.stringify({ schemaVersion: 1, recipes });
}

const validRecipe = {
  label: "Python tests",
  category: "test",
  logicalExecutable: "pytest",
  argv: ["-q"],
  cwd: "."
};

describe("repository verification config", () => {
  it("returns no recipes when the config is absent", async () => {
    await expect(readVerificationConfig(workspace(undefined), "ws_absent")).resolves.toEqual([]);
  });

  it("parses one strict recipe into the existing verification launch shape", async () => {
    await expect(
      readVerificationConfig(workspace(document({ pytest: validRecipe })), "ws_valid")
    ).resolves.toEqual([
      {
        id: "config:pytest",
        label: "Python tests",
        category: "test",
        logicalExecutable: "pytest",
        argv: ["-q"],
        cwd: ".",
        source: "kodegpt-config"
      }
    ]);
  });

  it.each([
    ["future schema", JSON.stringify({ schemaVersion: 2, recipes: {} })],
    ["unknown top-level field", JSON.stringify({ schemaVersion: 1, recipes: {}, extra: true })],
    ["unknown recipe field", document({ pytest: { ...validRecipe, env: { HOME: "/tmp" } } })],
    ["invalid recipe key", document({ "bad/key": validRecipe })],
    ["empty label", document({ pytest: { ...validRecipe, label: "" } })],
    ["oversized label", document({ pytest: { ...validRecipe, label: "x".repeat(121) } })],
    ["invalid category", document({ pytest: { ...validRecipe, category: "security" } })],
    ["bash executable", document({ pytest: { ...validRecipe, logicalExecutable: "bash" } })],
    ["sh executable", document({ pytest: { ...validRecipe, logicalExecutable: "sh" } })],
    ["path executable", document({ pytest: { ...validRecipe, logicalExecutable: "../pytest" } })],
    ["too many argv", document({ pytest: { ...validRecipe, argv: Array.from({ length: 65 }, () => "x") } })],
    ["oversized argv element", document({ pytest: { ...validRecipe, argv: ["x".repeat(4097)] } })],
    ["absolute cwd", document({ pytest: { ...validRecipe, cwd: "/tmp" } })],
    ["parent cwd", document({ pytest: { ...validRecipe, cwd: "../tests" } })],
    ["empty cwd", document({ pytest: { ...validRecipe, cwd: "" } })]
  ])("fails closed for %s", async (_label, text) => {
    await expect(readVerificationConfig(workspace(text), "ws_invalid")).rejects.toMatchObject({
      code: "VERIFICATION_DISCOVERY_INVALID"
    });
  });

  it("fails closed above the recipe count bound", async () => {
    const recipes = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`recipe-${index}`, validRecipe])
    );
    await expect(readVerificationConfig(workspace(document(recipes)), "ws_too_many")).rejects.toMatchObject({
      code: "VERIFICATION_DISCOVERY_INVALID"
    });
  });

  it("fails closed for non-file, truncated, inconsistent, or oversized config evidence", async () => {
    const text = document({ pytest: validRecipe });
    for (const candidate of [
      workspace(text, { kind: "symlink" }),
      workspace(text, { kind: "directory" }),
      workspace(text, { eof: false }),
      workspace(text, { bytesRead: 1 }),
      workspace(text, { sizeBytes: 64 * 1024 + 1 })
    ]) {
      await expect(readVerificationConfig(candidate, "ws_bad_evidence")).rejects.toMatchObject({
        code: "VERIFICATION_DISCOVERY_INVALID"
      });
    }
  });

  it("accepts all existing verification categories and deterministic recipe-key order", async () => {
    const categories = ["test", "lint", "typecheck", "build", "format-check", "custom"] as const;
    const recipes = Object.fromEntries(
      categories.map((category, index) => [
        `z${index}`,
        { ...validRecipe, label: category, category, logicalExecutable: `tool-${index}` }
      ]).reverse()
    );
    const result = await readVerificationConfig(workspace(document(recipes)), "ws_categories");
    expect(result.map((recipe) => recipe.id)).toEqual([
      "config:z0",
      "config:z1",
      "config:z2",
      "config:z3",
      "config:z4",
      "config:z5"
    ]);
  });
});
