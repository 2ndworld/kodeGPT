import { describe, expect, it } from "vitest";

import type {
  CapabilityPathIdentityResult,
  CapabilityTreeEntry,
  VerificationAvailabilityAdapter,
  VerificationExecutionAdapter,
  VerificationWorkspaceAdapter
} from "./adapters.js";
import { NativeCapabilityService } from "./native-capability-service.js";
import { createTestCapabilityDependencies } from "./test-support.js";

const PACKAGE_JSON = "package.json";
const VERIFICATION_CONFIG = ".kodegpt/verify.json";

function presentFile(): CapabilityPathIdentityResult {
  return { exists: true, kind: "file", sizeBytes: 1, hashTruncated: false };
}

function missing(): CapabilityPathIdentityResult {
  return { exists: false, hashTruncated: false };
}

function service(options: {
  packageJson?: Record<string, unknown>;
  packageJsonText?: string;
  packageJsonByPath?: Record<string, Record<string, unknown> | string>;
  verificationConfig?: Record<string, unknown> | string | (() => string | undefined);
  files?: string[];
  treeEntries?: CapabilityTreeEntry[];
  treeTruncated?: boolean;
  allowProcess?: boolean;
  allowDynamicExecutables?: boolean;
  allowedExecutables?: readonly string[];
  availability?: Partial<Record<string, { executableAvailable: boolean; sandboxAvailable: boolean }>>;
  run?: VerificationExecutionAdapter["run"];
  sourceStateError?: unknown;
  onSourceState?: () => void;
  onPathIdentity?: (path: string) => void;
  onRead?: (path: string) => void;
  onTree?: (scope: "literal" | "semantic" | undefined) => void;
} = {}): NativeCapabilityService {
  const files = new Set(options.files ?? []);
  const packageJsonByPath = new Map<string, string>();
  if (options.packageJson !== undefined || options.packageJsonText !== undefined) {
    files.add(PACKAGE_JSON);
    packageJsonByPath.set(PACKAGE_JSON, options.packageJsonText ?? JSON.stringify(options.packageJson));
  }
  for (const [path, value] of Object.entries(options.packageJsonByPath ?? {})) {
    files.add(path);
    packageJsonByPath.set(path, typeof value === "string" ? value : JSON.stringify(value));
  }
  const currentVerificationConfig = (): string | undefined => {
    const value = typeof options.verificationConfig === "function"
      ? options.verificationConfig()
      : options.verificationConfig;
    return value === undefined ? undefined : typeof value === "string" ? value : JSON.stringify(value);
  };
  const defaultTreeEntries = [...new Set([
    ...packageJsonByPath.keys(),
    ...[...files].filter((path) => path === "Cargo.toml" || path.endsWith("/Cargo.toml"))
  ])].map((path) => ({ path, kind: "file" as const }));
  const workspace = {
    readFile: async (_workspaceId: string, path: string) => {
      options.onRead?.(path);
      const contents = path === VERIFICATION_CONFIG
        ? currentVerificationConfig()
        : packageJsonByPath.get(path);
      if (contents === undefined) throw new Error(`unexpected read: ${path}`);
      return { contents, bytesRead: Buffer.byteLength(contents), eof: true };
    },
    tree: async (_workspaceId: string, _path: string | undefined, _maxEntries: number, scope?: "literal" | "semantic") => {
      options.onTree?.(scope);
      return {
        entries: options.treeEntries ?? defaultTreeEntries,
        truncated: options.treeTruncated ?? false
      };
    },
    pathIdentity: async (_workspaceId: string, path: string) => {
      options.onPathIdentity?.(path);
      if (path === VERIFICATION_CONFIG) {
        const contents = currentVerificationConfig();
        return contents === undefined
          ? missing()
          : {
              exists: true,
              kind: "file" as const,
              sizeBytes: Buffer.byteLength(contents, "utf8"),
              hashTruncated: false
            };
      }
      return files.has(path) ? presentFile() : missing();
    },
    effectivePolicy: () => ({
      allowProcess: options.allowProcess ?? true,
      allowDynamicExecutables: options.allowDynamicExecutables ?? false,
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
  const git = {
    checkpoint: async () => {
      options.onSourceState?.();
      if (options.sourceStateError !== undefined) throw options.sourceStateError;
      return {
        schemaVersion: 1 as const,
        headOid: "f".repeat(40),
        records: [],
        truncated: false
      };
    },
    checkpointPatch: async () => {
      throw new Error("source-state binding must not request patch presentation");
    }
  };

  return new NativeCapabilityService(
    createTestCapabilityDependencies({
      git,
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

  it("uses one semantic bounded tree for package manifests while keeping root lock/Cargo probes exact", async () => {
    const probed: string[] = [];
    const scopes: Array<"literal" | "semantic" | undefined> = [];
    const capability = service({
      packageJson: packageFixture("pnpm@10"),
      files: ["pnpm-lock.yaml", "Cargo.toml"],
      onPathIdentity: (path) => probed.push(path),
      onTree: (scope) => scopes.push(scope)
    });

    await capability.listVerifications({ workspaceId: "ws_probe" });
    expect(scopes).toEqual(["semantic"]);
    expect(probed).toEqual([
      "package.json",
      "Cargo.toml",
      "pnpm-lock.yaml",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
      ".kodegpt/verify.json"
    ]);
  });

  it("discovers collision-free nested first-party package recipes and preserves root IDs", async () => {
    const capability = service({
      packageJson: {
        ...packageFixture("pnpm@10"),
        scripts: { test: "root-test" }
      },
      packageJsonByPath: {
        "frontend/package.json": {
          name: "frontend",
          scripts: { test: "frontend-test", lint: "frontend-lint", typecheck: "tsc", build: "build" }
        },
        "backend/package.json": {
          name: "backend",
          scripts: { test: "backend-test" }
        }
      },
      files: ["pnpm-lock.yaml"],
      treeEntries: [
        { path: "package.json", kind: "file" },
        { path: "frontend/package.json", kind: "file" },
        { path: "backend/package.json", kind: "file" }
      ]
    });

    const result = await capability.listVerifications({ workspaceId: "ws_nested" });
    expect(result.recipes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "package:test", cwd: ".", logicalExecutable: "pnpm" }),
        expect.objectContaining({ id: "package:frontend:test", cwd: "frontend", logicalExecutable: "pnpm" }),
        expect.objectContaining({ id: "package:frontend:lint", cwd: "frontend", logicalExecutable: "pnpm" }),
        expect.objectContaining({ id: "package:frontend:typecheck", cwd: "frontend", logicalExecutable: "pnpm" }),
        expect.objectContaining({ id: "package:frontend:build", cwd: "frontend", logicalExecutable: "pnpm" }),
        expect.objectContaining({ id: "package:backend:test", cwd: "backend", logicalExecutable: "pnpm" })
      ])
    );
  });

  it("fails closed when semantic project discovery is incomplete", async () => {
    const truncated = service({ packageJson: packageFixture("pnpm@10"), treeTruncated: true });
    await expect(truncated.listVerifications({ workspaceId: "ws_truncated_tree" })).rejects.toMatchObject({
      code: "VERIFICATION_DISCOVERY_INVALID"
    });

    const packageJsonByPath = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [
        `packages/p${String(index).padStart(3, "0")}/package.json`,
        { name: `p${index}`, scripts: { test: "test" } }
      ])
    );
    const tooMany = service({ packageJsonByPath, files: ["pnpm-lock.yaml"] });
    await expect(tooMany.listVerifications({ workspaceId: "ws_too_many" })).rejects.toMatchObject({
      code: "VERIFICATION_DISCOVERY_INVALID"
    });
  });

  it("allows an unlisted verification executable only through dynamic executable authority", async () => {
    const dynamic = service({
      packageJson: packageFixture("pnpm@10"),
      files: ["pnpm-lock.yaml"],
      allowedExecutables: [],
      allowDynamicExecutables: true,
      availability: { pnpm: { executableAvailable: true, sandboxAvailable: true } }
    });
    expect(
      (await dynamic.listVerifications({ workspaceId: "ws_dynamic_verify" })).recipes.find(
        (recipe) => recipe.id === "package:test"
      )
    ).toMatchObject({ allowed: true, logicalExecutable: "pnpm" });

    const fixedOnly = service({
      packageJson: packageFixture("pnpm@10"),
      files: ["pnpm-lock.yaml"],
      allowedExecutables: [],
      allowDynamicExecutables: false,
      availability: { pnpm: { executableAvailable: true, sandboxAvailable: true } }
    });
    expect(
      (await fixedOnly.listVerifications({ workspaceId: "ws_fixed_verify" })).recipes.find(
        (recipe) => recipe.id === "package:test"
      )
    ).toMatchObject({ allowed: false, blockedReason: "EXECUTABLE_NOT_ALLOWED" });
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

  it("discovers target-scoped Cargo per-crate recipes from the existing semantic tree", async () => {
    const scopes: Array<"literal" | "semantic" | undefined> = [];
    const capability = service({
      files: ["Cargo.toml"],
      treeEntries: [
        { path: "Cargo.toml", kind: "file" },
        { path: "crates/runtime/Cargo.toml", kind: "file" },
        { path: "crates/sandbox/Cargo.toml", kind: "file" }
      ],
      onTree: (scope) => scopes.push(scope)
    });

    const result = await capability.listVerifications({
      workspaceId: "ws_cargo_target",
      target: "crates/runtime/src/process.rs"
    });

    expect(scopes).toEqual(["semantic"]);
    expect(result.recipes.map(({ id }) => id)).toEqual([
      "cargo:crates/runtime:test",
      "cargo:crates/runtime:check",
      "cargo:test",
      "cargo:check",
      "cargo:fmt-check"
    ]);
    expect(result.recipes.find(({ id }) => id === "cargo:crates/runtime:test")).toMatchObject({
      logicalExecutable: "cargo",
      argv: ["test", "--manifest-path", "Cargo.toml"],
      cwd: "crates/runtime",
      source: "cargo",
      allowed: true
    });
    expect(result.recipes.some(({ id }) => id.includes("crates/sandbox"))).toBe(false);
  });

  it("scopes mixed Node and Cargo verification to the nearest project ecosystem", async () => {
    const capability = service({
      packageJson: {
        ...packageFixture("pnpm@10"),
        scripts: { test: "root-test", build: "root-build" }
      },
      packageJsonByPath: {
        "packages/core/package.json": {
          name: "core",
          scripts: { test: "core-test", typecheck: "core-typecheck" }
        },
        "packages/other/package.json": {
          name: "other",
          scripts: { test: "other-test" }
        }
      },
      files: ["pnpm-lock.yaml", "Cargo.toml"],
      treeEntries: [
        { path: "package.json", kind: "file" },
        { path: "packages/core/package.json", kind: "file" },
        { path: "packages/other/package.json", kind: "file" },
        { path: "Cargo.toml", kind: "file" },
        { path: "crates/runtime/Cargo.toml", kind: "file" }
      ]
    });

    const node = await capability.listVerifications({
      workspaceId: "ws_mixed",
      target: "packages/core/src/index.ts"
    });
    expect(node.recipes.map(({ id }) => id)).toEqual([
      "package:packages/core:test",
      "package:packages/core:typecheck",
      "package:test",
      "package:build"
    ]);
    expect(node.recipes.some(({ id }) => id.startsWith("cargo:"))).toBe(false);

    const rust = await capability.listVerifications({
      workspaceId: "ws_mixed",
      target: "crates/runtime/src/process.rs"
    });
    expect(rust.recipes.map(({ id }) => id)).toEqual([
      "cargo:crates/runtime:test",
      "cargo:crates/runtime:check",
      "cargo:test",
      "cargo:check",
      "cargo:fmt-check"
    ]);
    expect(rust.recipes.some(({ id }) => id.startsWith("package:"))).toBe(false);
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

  it("discovers repository-configured verification recipes through dynamic availability", async () => {
    const capability = service({
      verificationConfig: {
        schemaVersion: 1,
        recipes: {
          pytest: {
            label: "Python tests",
            category: "test",
            logicalExecutable: "pytest",
            argv: ["-q"],
            cwd: "python"
          }
        }
      },
      allowDynamicExecutables: true,
      allowedExecutables: [],
      availability: { pytest: { executableAvailable: true, sandboxAvailable: true } }
    });

    const result = await capability.listVerifications({ workspaceId: "ws_config" });
    expect(result.recipes).toContainEqual({
      id: "config:pytest",
      label: "Python tests",
      category: "test",
      logicalExecutable: "pytest",
      argv: ["-q"],
      cwd: "python",
      source: "kodegpt-config",
      allowed: true
    });
  });

  it("runs a configured recipe through the existing execution adapter with exact launch fields", async () => {
    const calls: unknown[] = [];
    const events: string[] = [];
    const capability = service({
      verificationConfig: {
        schemaVersion: 1,
        recipes: {
          pytest: {
            label: "Python tests",
            category: "test",
            logicalExecutable: "pytest",
            argv: ["-q", "tests/unit"],
            cwd: "python"
          }
        }
      },
      allowDynamicExecutables: true,
      allowedExecutables: [],
      onSourceState: () => events.push("source-state"),
      run: async (input) => {
        events.push("run");
        calls.push(input);
        return {
          schemaVersion: 1,
          operationId: "op_config_verify",
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
            uri: "artifact://ka_config_verify",
            mediaType: "application/vnd.kodegpt.execution-stream",
            sizeBytes: 2,
            sourceTruncated: false
          }
        };
      }
    });

    const result = await capability.runVerification({
      workspaceId: "ws_config_run",
      recipeId: "config:pytest",
      background: true
    });
    expect(result.operation.operationId).toBe("op_config_verify");
    expect(result.sourceState).toEqual({
      headOid: "f".repeat(40),
      changesFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(events).toEqual(["source-state", "run"]);
    expect(calls).toEqual([
      {
        workspaceId: "ws_config_run",
        recipeId: "config:pytest",
        logicalExecutable: "pytest",
        argv: ["-q", "tests/unit"],
        cwd: "python",
        background: true
      }
    ]);
  });

  it("fails before process launch when source-state binding cannot be established", async () => {
    let runCalls = 0;
    const capability = service({
      verificationConfig: {
        schemaVersion: 1,
        recipes: {
          pytest: {
            label: "Python tests",
            category: "test",
            logicalExecutable: "pytest",
            argv: ["-q"],
            cwd: "."
          }
        }
      },
      allowDynamicExecutables: true,
      allowedExecutables: [],
      sourceStateError: Object.assign(new Error("invalid checkpoint"), {
        code: "RUNTIME_PROTOCOL_INVALID"
      }),
      run: async () => {
        runCalls += 1;
        throw new Error("process must not launch");
      }
    });

    await expect(
      capability.runVerification({ workspaceId: "ws_source_state_failure", recipeId: "config:pytest" })
    ).rejects.toMatchObject({ code: "GIT_STATUS_INVALID" });
    expect(runCalls).toBe(0);
  });

  it("re-reads repository config before run and never executes stale listed launch data", async () => {
    let config = JSON.stringify({
      schemaVersion: 1,
      recipes: {
        pytest: {
          label: "Python tests",
          category: "test",
          logicalExecutable: "pytest",
          argv: ["-q"],
          cwd: "."
        }
      }
    });
    const calls: unknown[] = [];
    const capability = service({
      verificationConfig: () => config,
      allowDynamicExecutables: true,
      allowedExecutables: [],
      run: async (input) => {
        calls.push(input);
        throw new Error("stale recipe must not execute");
      }
    });

    const listed = await capability.listVerifications({ workspaceId: "ws_config_fresh" });
    expect(listed.recipes.some((recipe) => recipe.id === "config:pytest")).toBe(true);

    config = JSON.stringify({ schemaVersion: 1, recipes: {} });
    await expect(
      capability.runVerification({ workspaceId: "ws_config_fresh", recipeId: "config:pytest" })
    ).rejects.toMatchObject({ code: "VERIFICATION_NOT_FOUND" });
    expect(calls).toEqual([]);
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
