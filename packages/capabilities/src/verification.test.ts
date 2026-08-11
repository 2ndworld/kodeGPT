import { describe, expect, it } from "vitest";

import type {
  CapabilityExecutionAdapter,
  VerificationWorkspaceAdapter
} from "./adapters.js";
import { NativeCapabilityService } from "./native-capability-service.js";
import { createTestCapabilityDependencies } from "./test-support.js";

function service(options: {
  packageJson?: string;
  cargo?: boolean;
  allowedExecutableNames?: string[];
  allowProcess?: boolean;
  run?: CapabilityExecutionAdapter["run"];
}): NativeCapabilityService {
  const verificationWorkspace: VerificationWorkspaceAdapter = {
    tree: async () => ({
      entries: [
        ...(options.packageJson === undefined ? [] : [{ path: "package.json", kind: "file" as const }]),
        ...(options.cargo === true ? [{ path: "Cargo.toml", kind: "file" as const }] : [])
      ],
      truncated: false
    }),
    readFile: async (_workspaceId, path, readOptions) => {
      expect(readOptions?.maxBytes).toBe(64 * 1024);
      if (path !== "package.json" || options.packageJson === undefined) {
        throw new Error(`unexpected manifest read: ${path}`);
      }
      return {
        contents: options.packageJson,
        bytesRead: Buffer.byteLength(options.packageJson),
        eof: true
      };
    },
    effectivePolicy: () => ({
      allowProcess: options.allowProcess ?? true,
      allowedExecutableNames: [...(options.allowedExecutableNames ?? [])]
    })
  };

  return new NativeCapabilityService(
    createTestCapabilityDependencies({
      verification: {
        workspace: verificationWorkspace,
        execution: {
          run:
            options.run ??
            (async () => {
              throw new Error("verification discovery must not execute anything");
            })
        }
      }
    })
  );
}

describe("safe verification recipes", () => {
  it("discovers supported package scripts without parsing or executing script bodies", async () => {
    const capability = service({
      packageJson: JSON.stringify({
        scripts: {
          test: "vitest run",
          lint: "eslint .",
          typecheck: "tsc --noEmit",
          build: "echo build && rm -rf should-never-be-parsed",
          dev: "vite"
        }
      }),
      allowedExecutableNames: ["pnpm"]
    });

    await expect(capability.listVerifications({ workspaceId: "ws_pkg" })).resolves.toEqual({
      schemaVersion: 1,
      workspaceId: "ws_pkg",
      recipes: [
        {
          id: "package:test",
          label: "Package test",
          category: "test",
          logicalExecutable: "pnpm",
          argv: ["run", "test"],
          cwd: ".",
          source: "package-script",
          allowed: true
        },
        {
          id: "package:lint",
          label: "Package lint",
          category: "lint",
          logicalExecutable: "pnpm",
          argv: ["run", "lint"],
          cwd: ".",
          source: "package-script",
          allowed: true
        },
        {
          id: "package:typecheck",
          label: "Package typecheck",
          category: "typecheck",
          logicalExecutable: "pnpm",
          argv: ["run", "typecheck"],
          cwd: ".",
          source: "package-script",
          allowed: true
        },
        {
          id: "package:build",
          label: "Package build",
          category: "build",
          logicalExecutable: "pnpm",
          argv: ["run", "build"],
          cwd: ".",
          source: "package-script",
          allowed: true
        }
      ]
    });
  });

  it("discovers stable Cargo verification recipes", async () => {
    const capability = service({ cargo: true, allowedExecutableNames: ["cargo"] });

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

  it("marks recipes blocked when the executable is absent from effective policy", async () => {
    const capability = service({
      packageJson: JSON.stringify({ scripts: { test: "vitest run" } }),
      cargo: true,
      allowedExecutableNames: ["cargo"]
    });

    const result = await capability.listVerifications({ workspaceId: "ws_policy" });

    expect(result.recipes.find((recipe) => recipe.id === "package:test")).toMatchObject({
      allowed: false,
      blockedReason: "EXECUTABLE_NOT_ALLOWED"
    });
    expect(result.recipes.find((recipe) => recipe.id === "cargo:test")).toMatchObject({
      allowed: true
    });
  });

  it("marks recipes blocked when process authority is disabled even if executable remains allowlisted", async () => {
    const capability = service({
      packageJson: JSON.stringify({ scripts: { test: "vitest run" } }),
      allowedExecutableNames: ["pnpm"],
      allowProcess: false
    });

    const result = await capability.listVerifications({ workspaceId: "ws_no_process" });

    expect(result.recipes.find((recipe) => recipe.id === "package:test")).toMatchObject({
      allowed: false,
      blockedReason: "PROCESS_NOT_ALLOWED"
    });
  });

  it("fails closed when bounded manifest discovery is truncated", async () => {
    let runCalls = 0;
    const capability = new NativeCapabilityService(
      createTestCapabilityDependencies({
        verification: {
          workspace: {
            tree: async () => ({ entries: [], truncated: true }),
            readFile: async () => {
              throw new Error("truncated discovery must not read manifests");
            },
            effectivePolicy: () => ({ allowProcess: true, allowedExecutableNames: ["pnpm"] })
          },
          execution: {
            run: async () => {
              runCalls += 1;
              throw new Error("truncated discovery must not execute");
            }
          }
        }
      })
    );

    await expect(
      capability.listVerifications({ workspaceId: "ws_truncated" })
    ).rejects.toThrow(/truncated/i);
    expect(runCalls).toBe(0);
  });

  it("re-resolves the selected recipe and runs only its stored executable, argv, and cwd", async () => {
    const calls: unknown[] = [];
    const capability = service({
      packageJson: JSON.stringify({ scripts: { test: "arbitrary shell body is metadata only" } }),
      allowedExecutableNames: ["pnpm"],
      run: async (input) => {
        calls.push(input);
        return {
          schemaVersion: 1,
          operationId: "op_verify",
          state: "completed",
          exitCode: 0,
          stdoutPreview: "ok\n",
          stderrPreview: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          sourceTruncated: false,
          bytesSpooled: 3,
          artifact: {
            schemaVersion: 1,
            uri: "artifact://ka_verify",
            mediaType: "application/vnd.kodegpt.execution-stream",
            sizeBytes: 3,
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

    expect(calls).toEqual([
      {
        workspaceId: "ws_run",
        logicalExecutable: "pnpm",
        argv: ["run", "test"],
        cwd: ".",
        background: true
      }
    ]);
    expect(result).toMatchObject({
      schemaVersion: 1,
      workspaceId: "ws_run",
      recipe: { id: "package:test", allowed: true },
      operation: { schemaVersion: 1, operationId: "op_verify", state: "completed" }
    });
  });

  it("re-checks current policy before run and rejects a now-blocked recipe", async () => {
    let allowed = true;
    let runCalls = 0;
    const packageJson = JSON.stringify({ scripts: { test: "vitest run" } });
    const verificationWorkspace: VerificationWorkspaceAdapter = {
      tree: async () => ({ entries: [{ path: "package.json", kind: "file" }], truncated: false }),
      readFile: async () => ({ contents: packageJson, bytesRead: packageJson.length, eof: true }),
      effectivePolicy: () => ({
        allowProcess: true,
        allowedExecutableNames: allowed ? ["pnpm"] : []
      })
    };
    const capability = new NativeCapabilityService(
      createTestCapabilityDependencies({
        verification: {
          workspace: verificationWorkspace,
          execution: {
            run: async () => {
              runCalls += 1;
              throw new Error("blocked recipe must not execute");
            }
          }
        }
      })
    );

    const listed = await capability.listVerifications({ workspaceId: "ws_recheck" });
    expect(listed.recipes[0]?.allowed).toBe(true);
    allowed = false;

    await expect(
      capability.runVerification({ workspaceId: "ws_recheck", recipeId: "package:test" })
    ).rejects.toMatchObject({ code: "VERIFICATION_RECIPE_BLOCKED" });
    expect(runCalls).toBe(0);
  });

  it("rejects unknown recipe IDs without invoking execution", async () => {
    let runCalls = 0;
    const capability = service({
      packageJson: JSON.stringify({ scripts: { test: "vitest run" } }),
      allowedExecutableNames: ["pnpm"],
      run: async () => {
        runCalls += 1;
        throw new Error("unknown recipe must not execute");
      }
    });

    await expect(
      capability.runVerification({ workspaceId: "ws_unknown", recipeId: "package:missing" })
    ).rejects.toMatchObject({ code: "VERIFICATION_RECIPE_NOT_FOUND" });
    expect(runCalls).toBe(0);
  });
});
