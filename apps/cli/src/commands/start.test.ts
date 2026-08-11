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
    writeFile: async () => ({ bytesWritten: 0, created: true }),
    editFile: async () => ({ bytesWritten: 0, replacements: 0 }),
    gitStatus: async () => gitInspection,
    gitDiff: async () => gitInspection,
    runProcess: async () => completedProcess,
    processStatus: async () => completedProcess,
    processCancel: async () => ({ ...completedProcess, state: "cancelled" as const }),
    search: async () => [],
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
    expect(events.slice(-3)).toEqual(["bind.close", "mcp.close", "kernel.stop"]);
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
