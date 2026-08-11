import { describe, expect, it } from "vitest";

import type {
  CapabilityPathIdentityResult,
  VerificationAvailabilityAdapter,
  VerificationExecutionAdapter,
  VerificationWorkspaceAdapter
} from "./adapters.js";
import { NativeCapabilityService } from "./native-capability-service.js";
import { createTestCapabilityDependencies } from "./test-support.js";

const PACKAGE_JSON = "package.json";

function presentFile(): CapabilityPathIdentityResult {
  return { exists: true, kind: "file", sizeBytes: 1, hashTruncated: false };
}

function missing(): CapabilityPathIdentityResult {
  return { exists: false, hashTruncated: false };
}

function service(options: {
  packageJson?: Record<string, unknown>;
  packageJsonText?: string;
  files?: string[];
  allowProcess?: boolean;
  allowedExecutables?: readonly string[];
  availability?: Partial<Record<string, { executableAvailable: boolean; sandboxAvailable: boolean }>>;
  run?: VerificationExecutionAdapter["run"];
  onPathIdentity?: (path: string) => void;
  onRead?: (path: string) => void;
} = {}): NativeCapabilityService {
  const files = new Set(options.files ?? []);
  if (options.packageJson !== undefined || options.packageJsonText !== undefined) files.add(PACKAGE_JSON);
  const workspace: VerificationWorkspaceAdapter = {
    readFile: async (_workspaceId, path) => {
      options.onRead?.(path);
      if (
        path !== PACKAGE_JSON ||
        (options.packageJson === undefined && options.packageJsonText === undefined)
      ) {
        throw new Error(`unexpected read: ${path}`);
      }
      const contents = options.packageJsonText ?? JSON.stringify(options.packageJson);
      return { contents, bytesRead: Buffer.byteLength(contents), eof: true };
    },
    pathIdentity: async (_workspaceId, path) => {
      options.onPathIdentity?.(path);
      return files.has(path) ? presentFile() : missing();
    },
    effectivePolicy: () => ({
      allowProcess: options.allowProcess ?? true,
      allowedExecutableNames: [...(options.allowedExecutables ?? ["pnpm", "npm", "yarn", "bun", "cargo"])]
    })
  };
  const availability: VerificationAvailabilityAdapter = {
    inspectExecutable: async (_workspaceId, logicalExecutable) => ({
      schemaVersion: 1,
      executableAvailable: options.availability?.[logicalExecutable]?.executableAvailable ?? true,
      sandboxAvailable: options.availability?.[logicalExecutable]?.sandboxAvailable ?? true
    })
  };
  const execution: VerificationExecutionAdapter = {
    run:
      options.run ??
      (async () => {
        throw new Error("verification discovery must not execute anything");
      })
  };

  return new NativeCapabilityService(
    createTestCapabilityDependencies({
      verification: { workspace, availability, execution }
    })
  );
}

function packageFixture(packageManager?: string): Record<string, unknown> {
  return {
    name: "fixture",
    ...(packageManager === undefined ? {} : { packageManager }),
    scripts: {
      test: "node -e \"require('child_process').execSync('echo malicious-looking')\"",
      lint: "eslint ."
    }
  };
}

describe("safe verification recipes", () => {
  for (const [manager, lockfile] of [
    ["pnpm", "pnpm-lock.yaml"],
    ["npm", "package-lock.json"],
    ["yarn", "yarn.lock"],
    ["bun", "bun.lock"]
  ] as const) {
    it(`discovers ${manager} package recipes from explicit matching evidence`, async () => {
      const capability = service({
        packageJson: packageFixture(`${manager}@9.9.9`),
        files: [lockfile]
      });

      const result = await capability.listVerifications({ workspaceId: `ws_${manager}` });
      expect(result.recipes).toContainEqual({
        id: "package:test",
        label: "Package test",
        category: "test",
        logicalExecutable: manager,
        argv: ["run", "test"],
        cwd: ".",
        source: "package-script",
        allowed: true
      });
      expect(result.recipes.find((recipe) => recipe.id === "package:test")?.argv).not.toContain(
        "node -e \"require('child_process').execSync('echo malicious-looking')\""
      );
    });
  }

  it("selects a manager from one lockfile when packageManager is absent", async () => {
    const capability = service({ packageJson: packageFixture(), files: ["yarn.lock"] });
    const result = await capability.listVerifications({ workspaceId: "ws_lock_only" });
    expect(result.recipes.find((recipe) => recipe.id === "package:test")).toMatchObject({
      logicalExecutable: "yarn",
      argv: ["run", "test"],
      allowed: true
    });
  });

  it("fails closed on conflicting manager evidence without inventing launch fields", async () => {
    const explicitConflict = service({
      packageJson: packageFixture("pnpm@10"),
      files: ["package-lock.json"]
    });
    const multipleLocks = service({
      packageJson: packageFixture(),
      files: ["pnpm-lock.yaml", "yarn.lock"]
    });

    for (const capability of [explicitConflict, multipleLocks]) {
      const recipe = (await capability.listVerifications({ workspaceId: "ws_conflict" })).recipes.find(
        (candidate) => candidate.id === "package:test"
      );
      expect(recipe).toEqual({
        id: "package:test",
        label: "Package test",
        category: "test",
        source: "package-script",
        allowed: false,
        blockedReason: "PACKAGE_MANAGER_CONFLICT"
      });
    }
  });

  it("keeps scripts discoverable but blocked when package manager evidence is absent", async () => {
    const capability = service({ packageJson: packageFixture() });
    const recipe = (await capability.listVerifications({ workspaceId: "ws_unknown" })).recipes.find(
      (candidate) => candidate.id === "package:test"
    );
    expect(recipe).toEqual({
      id: "package:test",
      label: "Package test",
      category: "test",
      source: "package-script",
      allowed: false,
      blockedReason: "PACKAGE_MANAGER_UNKNOWN"
    });
  });

  it("uses exact known-path probes and never recursive tree discovery", async () => {
    const probed: string[] = [];
    const capability = service({
      packageJson: packageFixture("pnpm@10"),
      files: ["pnpm-lock.yaml", "Cargo.toml"],
      onPathIdentity: (path) => probed.push(path)
    });

    await capability.listVerifications({ workspaceId: "ws_probe" });
    expect(probed).toEqual([
      "package.json",
      "Cargo.toml",
      "pnpm-lock.yaml",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "yarn.lock",
      "bun.lock",
      "bun.lockb"
    ]);
  });

  it("applies policy and static availability in fail-closed precedence", async () => {
    const cases = [
      {
        options: { allowProcess: false, allowedExecutables: ["pnpm"] },
        reason: "PROCESS_NOT_ALLOWED"
      },
      {
        options: { allowProcess: true, allowedExecutables: [] },
        reason: "EXECUTABLE_NOT_ALLOWED"
      },
      {
        options: {
          allowProcess: true,
          allowedExecutables: ["pnpm"],
          availability: { pnpm: { executableAvailable: false, sandboxAvailable: true } }
        },
        reason: "EXECUTABLE_UNAVAILABLE"
      },
      {
        options: {
          allowProcess: true,
          allowedExecutables: ["pnpm"],
          availability: { pnpm: { executableAvailable: true, sandboxAvailable: false } }
        },
        reason: "SANDBOX_UNAVAILABLE"
      }
    ] as const;

    for (const { options, reason } of cases) {
      const capability = service({
        packageJson: packageFixture("pnpm@10"),
        files: ["pnpm-lock.yaml"],
        ...options
      });
      const recipe = (await capability.listVerifications({ workspaceId: "ws_policy" })).recipes.find(
        (candidate) => candidate.id === "package:test"
      );
      expect(recipe).toMatchObject({ allowed: false, blockedReason: reason });
    }
  });

  it("discovers fixed Cargo recipes through exact manifest evidence and availability", async () => {
    const capability = service({ files: ["Cargo.toml"] });
    const result = await capability.listVerifications({ workspaceId: "ws_cargo" });
    expect(result.recipes).toEqual([
      {
        id: "cargo:test",
        label: "Cargo test",
        category: "test",
        logicalExecutable: "cargo",
        argv: ["test", "--workspace"],
        cwd: ".",
        source: "cargo",
        allowed: true
      },
      {
        id: "cargo:check",
        label: "Cargo check",
        category: "typecheck",
        logicalExecutable: "cargo",
        argv: ["check", "--workspace"],
        cwd: ".",
        source: "cargo",
        allowed: true
      },
      {
        id: "cargo:fmt-check",
        label: "Cargo fmt check",
        category: "format-check",
        logicalExecutable: "cargo",
        argv: ["fmt", "--all", "--", "--check"],
        cwd: ".",
        source: "cargo",
        allowed: true
      }
    ]);
  });

  it("re-resolves discovery before run and executes only stored recipe fields including recipeId", async () => {
    const calls: unknown[] = [];
    const capability = service({
      packageJson: packageFixture("npm@11"),
      files: ["package-lock.json"],
      run: async (input) => {
        calls.push(input);
        return {
          schemaVersion: 1,
          operationId: "op_verify",
          state: "completed",
          exitCode: 0,
          stdoutPreview: "ok",
          stderrPreview: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          sourceTruncated: false,
          bytesSpooled: 2,
          artifact: {
            schemaVersion: 1,
            uri: "artifact://ka_verify",
            mediaType: "application/vnd.kodegpt.execution-stream",
            sizeBytes: 2,
            sourceTruncated: false
          }
        };
      }
    });

    const result = await capability.runVerification({
      workspaceId: "ws_run",
      recipeId: "package:test",
      background: true
    });
    expect(result.operation.operationId).toBe("op_verify");
    expect(calls).toEqual([
      {
        workspaceId: "ws_run",
        recipeId: "package:test",
        logicalExecutable: "npm",
        argv: ["run", "test"],
        cwd: ".",
        background: true
      }
    ]);
  });

  it("uses stable errors for invalid, missing, blocked, and invalid manifest discovery", async () => {
    const capability = service({ packageJson: packageFixture() });
    await expect(capability.listVerifications({ workspaceId: "" })).rejects.toMatchObject({
      code: "CAPABILITY_INPUT_INVALID"
    });
    await expect(
      capability.runVerification({ workspaceId: "ws_missing", recipeId: "missing" })
    ).rejects.toMatchObject({ code: "VERIFICATION_NOT_FOUND" });
    await expect(
      capability.runVerification({ workspaceId: "ws_blocked", recipeId: "package:test" })
    ).rejects.toMatchObject({ code: "VERIFICATION_NOT_ALLOWED" });

    const malformed = service({ packageJsonText: "{not-json" });
    await expect(
      malformed.listVerifications({ workspaceId: "ws_malformed" })
    ).rejects.toMatchObject({
      code: "VERIFICATION_DISCOVERY_INVALID",
      message: "Verification discovery is invalid"
    });
  });
});
