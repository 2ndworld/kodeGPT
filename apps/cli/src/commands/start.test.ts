import { createHash } from "node:crypto";

import { MCP_SURFACE_VERSION } from "@kodegpt/mcp-server";
import { describe, expect, it } from "vitest";

import {
  formatKodegptStartStatus,
  runStartCommand,
  startKodegpt,
  type StartDependencies
} from "./start.js";

function dependencies(
  events: string[],
  hello: {
    runtimeVersion: string;
    testMethods: boolean;
    auditHealthy: boolean;
    filesystemBoundaryAvailable: boolean;
  } = {
    runtimeVersion: "0.1.0",
    testMethods: false,
    auditHealthy: true,
    filesystemBoundaryAvailable: true
  }
): StartDependencies {
  const kernel = {
    request: async <T>() => ({} as T),
    hello: async () => {
      events.push("kernel.hello");
      return hello;
    },
    stop: async () => {
      events.push("kernel.stop");
    }
  };
  const effectivePolicy = {
    name: "observe" as const,
    allowWrite: false,
    allowProcess: false,
    network: "deny" as const,
    allowedExecutableNames: [],
    inheritEnv: false as const,
    envAllowlist: []
  };
  const readyWorkspace = {
    id: "ws_test",
    canonicalRoot: "/workspace",
    effectivePolicy
  };
  const artifact = {
    schemaVersion: 1 as const,
    uri: "artifact://ka_test" as const,
    mediaType: "application/vnd.kodegpt.execution-stream",
    sizeBytes: 0,
    sourceTruncated: false
  };
  const gitInspection = {
    schemaVersion: 1 as const,
    exitCode: 0,
    stdoutPreview: "",
    stderrPreview: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    sourceTruncated: false,
    bytesSpooled: 0,
    artifact
  };
  const completedProcess = {
    schemaVersion: 1 as const,
    operationId: "op_test",
    state: "completed" as const,
    exitCode: 0,
    stdoutPreview: "",
    stderrPreview: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    sourceTruncated: false,
    bytesSpooled: 0,
    artifact
  };
  const workspaceManager = {
    listWorkspaces: () => [],
    openWorkspace: async () => readyWorkspace,
    closeWorkspace: async () => undefined,
    requireReady: () => readyWorkspace,
    readFile: async () => ({ contents: "", bytesRead: 0, eof: true }),
    pathIdentity: async () => ({ schemaVersion: 1 as const, exists: false, hashTruncated: false }),
    commitPatchFile: async (input: { action: "create" | "update" | "delete"; content: string | null }) => ({
      schemaVersion: 1 as const,
      action: input.action,
      bytesWritten: input.content === null ? 0 : Buffer.byteLength(input.content),
      sha256: input.content === null ? null : "a".repeat(64)
    }),
    writeFile: async () => ({ bytesWritten: 0, created: true }),
    editFile: async () => ({ bytesWritten: 0, replacements: 0 }),
    gitStatus: async () => gitInspection,
    gitCheckpoint: async () => ({ schemaVersion: 1 as const, records: [], truncated: false }),
    gitCheckpointPatch: async () => gitInspection,
    gitDiff: async () => gitInspection,
    runProcess: async () => completedProcess,
    inspectExecutable: async () => ({
      schemaVersion: 1 as const,
      executableAvailable: true,
      sandboxAvailable: true
    }),
    runVerificationProcess: async () => completedProcess,
    processStatus: async () => completedProcess,
    processCancel: async () => ({ ...completedProcess, state: "cancelled" as const }),
    search: async () => [],
    searchBounded: async () => ({ matches: [], truncated: false, truncationReasons: [] }),
    tree: async () => [],
    treeBounded: async () => ({ entries: [], truncated: false })
  };

  return {
    prepareStateRoot: async () => {
      events.push("state-root");
    },
    prepareAudit: async () => {
      events.push("audit");
    },
    prepareConnectorAuth: async () => {
      events.push("connector-verifier");
      return { authenticate: async () => true };
    },
    prepareExtensionRegistry: async () => {
      events.push("extensions");
      return { listEnabled: () => [] };
    },
    startKernel: async () => {
      events.push("kernel.start");
      return kernel;
    },
    prepareSkillCatalog: async () => {
      events.push("skill.catalog");
      return {
        list: async () => ({
          schemaVersion: 1 as const,
          skills: [],
          truncated: false,
          truncationReasons: []
        }),
        inspect: async () => {
          throw new Error("not used");
        },
        load: async () => {
          throw new Error("not used");
        },
        close: async () => {
          events.push("skill.close");
        }
      };
    },
    createTrustProfile: () => {
      events.push("trust-profile");
      return {
        trust: {},
        inspectProfile: (name: "observe" | "develop" | "trusted") => ({ name })
      };
    },
    createManagers: () => {
      events.push("managers");
      return { workspaceManager };
    },
    createMcp: () => {
      events.push("mcp");
      return {
        handler: async () => undefined,
        close: async () => {
          events.push("mcp.close");
        }
      };
    },
    bindLoopback: async () => {
      events.push("bind");
      return {
        host: "127.0.0.1",
        port: 43121,
        close: async () => {
          events.push("bind.close");
        }
      };
    }
  };
}

describe("kodegpt start orchestration", () => {
  it("starts in the locked fail-closed order and reports only safe status", async () => {
    const events: string[] = [];
    const started = await startKodegpt(
      { runtimePath: "/runtime", stateRoot: "/state", port: 43121 },
      dependencies(events)
    );

    expect(events).toEqual([
      "state-root",
      "audit",
      "connector-verifier",
      "extensions",
      "kernel.start",
      "kernel.hello",
      "skill.catalog",
      "trust-profile",
      "managers",
      "mcp",
      "bind"
    ]);
    expect(started.status).toEqual({
      host: "127.0.0.1",
      port: 43121,
      protocolVersion: "2026-07-28",
      surfaceVersion: MCP_SURFACE_VERSION,
      runtimeVersion: "0.1.0",
      auditHealthy: true,
      filesystemBoundaryAvailable: true
    });
    expect(JSON.stringify(started.status)).not.toMatch(/token|secret|verifier|kc_/i);

    await started.close();
    expect(events.slice(-4)).toEqual(["bind.close", "mcp.close", "skill.close", "kernel.stop"]);
  });

  it("production-wires git.changes through the existing workspace manager", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const originalCreateMcp = deps.createMcp;
    let toolContext: Parameters<StartDependencies["createMcp"]>[0]["toolContext"] | undefined;
    deps.createMcp = (options) => {
      toolContext = options.toolContext;
      return originalCreateMcp(options);
    };

    const started = await startKodegpt(
      { runtimePath: "/runtime", stateRoot: "/state", port: 43121 },
      deps
    );
    try {
      await expect(toolContext!.git.changes({ workspaceId: "ws_test" })).resolves.toMatchObject({
        schemaVersion: 1,
        workspaceId: "ws_test",
        clean: true,
        changedPaths: [],
        summary: { changedFiles: 0 },
        truncated: false,
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
      });
    } finally {
      await started.close();
    }
  });

  it("production-wires verification discovery through the existing workspace manager", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const originalCreateMcp = deps.createMcp;
    let toolContext: Parameters<StartDependencies["createMcp"]>[0]["toolContext"] | undefined;
    deps.createMcp = (options) => {
      toolContext = options.toolContext;
      return originalCreateMcp(options);
    };

    const started = await startKodegpt(
      { runtimePath: "/runtime", stateRoot: "/state", port: 43121 },
      deps
    );
    try {
      await expect(toolContext!.verify.list({ workspaceId: "ws_test" })).resolves.toEqual({
        schemaVersion: 1,
        workspaceId: "ws_test",
        recipes: []
      });
    } finally {
      await started.close();
    }
  });

  it("production-wires verification execution through the existing workspace manager", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const originalCreateManagers = deps.createManagers;
    const runInputs: unknown[] = [];
    deps.createManagers = (options) => {
      const managers = originalCreateManagers(options);
      const packageJson = JSON.stringify({
        packageManager: "pnpm@10.0.0",
        scripts: { test: "metadata only" }
      });
      Object.assign(managers.workspaceManager, {
        requireReady: () => ({
          id: "ws_test",
          canonicalRoot: "/workspace",
          effectivePolicy: {
            name: "trusted" as const,
            allowWrite: true,
            allowProcess: true,
            network: "unrestricted" as const,
            allowedExecutableNames: ["pnpm"],
            inheritEnv: false as const,
            envAllowlist: []
          }
        }),
        pathIdentity: async (_workspaceId: string, path: string) => ({
          schemaVersion: 1 as const,
          exists: path === "package.json" || path === "pnpm-lock.yaml",
          ...(path === "package.json" || path === "pnpm-lock.yaml"
            ? { kind: "file" as const, sizeBytes: 1 }
            : {}),
          hashTruncated: false
        }),
        treeBounded: async () => ({
          entries: [{ path: "package.json", kind: "file" as const }],
          truncated: false
        }),
        readFile: async () => ({ contents: packageJson, bytesRead: packageJson.length, eof: true }),
        inspectExecutable: async () => ({
          schemaVersion: 1 as const,
          executableAvailable: true,
          sandboxAvailable: true
        }),
        runVerificationProcess: async (input: unknown) => {
          runInputs.push(input);
          return {
            schemaVersion: 1 as const,
            operationId: "op_verify",
            state: "completed" as const,
            exitCode: 0,
            stdoutPreview: "verify-ok\n",
            stderrPreview: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            sourceTruncated: false,
            bytesSpooled: 10,
            artifact: {
              schemaVersion: 1 as const,
              uri: "artifact://ka_verify" as const,
              mediaType: "text/plain",
              sizeBytes: 10,
              sourceTruncated: false
            }
          };
        }
      });
      return managers;
    };

    const originalCreateMcp = deps.createMcp;
    let toolContext: Parameters<StartDependencies["createMcp"]>[0]["toolContext"] | undefined;
    deps.createMcp = (options) => {
      toolContext = options.toolContext;
      return originalCreateMcp(options);
    };

    const started = await startKodegpt(
      { runtimePath: "/runtime", stateRoot: "/state", port: 43121 },
      deps
    );
    try {
      const result = await toolContext!.verify.run({
        workspaceId: "ws_test",
        recipeId: "package:test",
        background: true
      });
      expect(runInputs).toEqual([
        {
          workspaceId: "ws_test",
          recipeId: "package:test",
          logicalExecutable: "pnpm",
          argv: ["run", "test"],
          cwd: ".",
          background: true
        }
      ]);
      expect(result).toMatchObject({
        schemaVersion: 1,
        workspaceId: "ws_test",
        recipe: { id: "package:test", allowed: true },
        operation: { operationId: "op_verify", state: "completed", exitCode: 0 }
      });
    } finally {
      await started.close();
    }
  });

  it("production-wires file.patch apply through the existing workspace manager commit authority", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const originalCreateManagers = deps.createManagers;
    const commitInputs: unknown[] = [];
    deps.createManagers = (options) => {
      const managers = originalCreateManagers(options);
      Object.assign(managers.workspaceManager, {
        pathIdentity: async () => ({
          schemaVersion: 1 as const,
          exists: true,
          kind: "file" as const,
          sizeBytes: 4,
          hashTruncated: false
        }),
        readFile: async () => ({ contents: "old\n", bytesRead: 4, eof: true }),
        commitPatchFile: async (input: { action: "create" | "update" | "delete"; content: string | null }) => {
          commitInputs.push(input);
          const sha256 =
            input.content === null
              ? null
              : createHash("sha256").update(input.content, "utf8").digest("hex");
          return {
            schemaVersion: 1 as const,
            action: input.action,
            bytesWritten: input.content === null ? 0 : Buffer.byteLength(input.content),
            sha256
          };
        }
      });
      return managers;
    };

    const originalCreateMcp = deps.createMcp;
    let toolContext: Parameters<StartDependencies["createMcp"]>[0]["toolContext"] | undefined;
    deps.createMcp = (options) => {
      toolContext = options.toolContext;
      return originalCreateMcp(options);
    };

    const started = await startKodegpt(
      { runtimePath: "/runtime", stateRoot: "/state", port: 43121 },
      deps
    );
    try {
      const result = await toolContext!.file.patch({
        workspaceId: "ws_test",
        patch: "--- a/target.txt\n+++ b/target.txt\n@@ -1 +1 @@\n-old\n+new\n",
        mode: "apply"
      });
      expect(commitInputs).toEqual([
        {
          workspaceId: "ws_test",
          path: "target.txt",
          action: "update",
          expectedSha256: createHash("sha256").update("old\n", "utf8").digest("hex"),
          content: "new\n"
        }
      ]);
      expect(result).toMatchObject({
        schemaVersion: 1,
        workspaceId: "ws_test",
        mode: "apply",
        committedPaths: ["target.txt"],
        files: [{ path: "target.txt", action: "update", committed: true }]
      });
    } finally {
      await started.close();
    }
  });

  it("production-wires context.build through the existing capability service and workspace manager", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const originalCreateManagers = deps.createManagers;
    deps.createManagers = (options) => {
      const managers = originalCreateManagers(options);
      Object.assign(managers.workspaceManager, {
        treeBounded: async () => ({ entries: [], truncated: false }),
        searchBounded: async () => ({ matches: [], truncated: false, truncationReasons: [] }),
        gitCheckpoint: async () => ({ schemaVersion: 1 as const, records: [], truncated: false }),
        pathIdentity: async () => ({ schemaVersion: 1 as const, exists: false, hashTruncated: false }),
        readFile: async (_workspaceId: string, path: string) => ({
          contents: path === "src/main.ts" ? "export const value = 1;\n" : "",
          bytesRead: path === "src/main.ts" ? 24 : 0,
          eof: true
        })
      });
      return managers;
    };

    const originalCreateMcp = deps.createMcp;
    let toolContext: Parameters<StartDependencies["createMcp"]>[0]["toolContext"] | undefined;
    deps.createMcp = (options) => {
      toolContext = options.toolContext;
      return originalCreateMcp(options);
    };

    const started = await startKodegpt(
      { runtimePath: "/runtime", stateRoot: "/state", port: 43121 },
      deps
    );
    try {
      const result = await toolContext!.context.build({
        workspaceId: "ws_test",
        intent: "understand",
        target: "src/main.ts",
        maxBytes: 64
      });
      expect(result).toMatchObject({
        schemaVersion: 1,
        intent: "understand",
        target: "src/main.ts",
        selectedFiles: [
          {
            path: "src/main.ts",
            reason: "exact-target",
            content: "export const value = 1;\n",
            truncated: false
          }
        ],
        totalBytes: 24,
        truncated: false
      });
    } finally {
      await started.close();
    }
  });

  it("rejects connector bootstrap unless it is paired with explicit public query compatibility", async () => {
    await expect(
      startKodegpt(
        {
          runtimePath: "/runtime",
          stateRoot: "/state",
          port: 43121,
          allowMissingConnectorCredential: true
        },
        dependencies([])
      )
    ).rejects.toThrow(/bootstrap/i);
  });

  it("keeps query credential compatibility disabled by default and programmatic-only", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const originalCreateMcp = deps.createMcp;
    const captured: Array<Record<string, unknown>> = [];
    deps.createMcp = (options) => {
      captured.push(options as unknown as Record<string, unknown>);
      return originalCreateMcp(options);
    };

    const normal = await runStartCommand(
      ["--runtime", "/runtime", "--state-root", "/state", "--port", "43121"],
      deps
    );
    expect(captured.at(-1)?.queryCredentialCompatibility).toBe(false);
    await normal.close();

    const enabled = await startKodegpt(
      {
        runtimePath: "/runtime",
        stateRoot: "/state",
        port: 43121,
        queryCredentialCompatibility: true
      },
      deps
    );
    expect(captured.at(-1)?.queryCredentialCompatibility).toBe(true);
    expect(enabled.status.host).toBe("127.0.0.1");
    await enabled.close();
  });

  it("parses the start command module strictly and formats only safe status", async () => {
    const events: string[] = [];
    const started = await runStartCommand(
      ["--runtime", "/runtime", "--state-root", "/state", "--port", "43121"],
      dependencies(events)
    );
    const formatted = formatKodegptStartStatus(started.status);
    expect(formatted).toContain("http://127.0.0.1:43121");
    expect(formatted).toContain("protocol=2026-07-28");
    expect(formatted).not.toMatch(/token|secret|verifier|kc_/i);
    await started.close();

    await expect(runStartCommand([], dependencies([]))).rejects.toThrow(/--runtime/);
    await expect(
      runStartCommand(["--runtime", "/runtime", "--unknown", "x"], dependencies([]))
    ).rejects.toThrow(/Unknown start option/);
  });

  it.each([
    ["audit", { auditHealthy: false, filesystemBoundaryAvailable: true }],
    ["filesystem", { auditHealthy: true, filesystemBoundaryAvailable: false }]
  ])("fails closed when %s capability validation fails", async (_label, flags) => {
    const events: string[] = [];
    await expect(
      startKodegpt(
        { runtimePath: "/runtime", stateRoot: "/state", port: 43121 },
        dependencies(events, {
          runtimeVersion: "0.1.0",
          testMethods: false,
          ...flags
        })
      )
    ).rejects.toThrow(/unavailable|unhealthy/i);

    expect(events).toContain("kernel.stop");
    expect(events).not.toContain("trust-profile");
    expect(events).not.toContain("bind");
  });
});
