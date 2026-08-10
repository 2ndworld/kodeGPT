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
  const workspaceManager = {
    listWorkspaces: () => [],
    openWorkspace: async () => ({}),
    closeWorkspace: async () => undefined,
    requireReady: () => ({ effectivePolicy: {} }),
    readFile: async () => ({}),
    writeFile: async () => ({}),
    editFile: async () => ({}),
    search: async () => [],
    tree: async () => [],
    gitStatus: async () => ({}),
    gitDiff: async () => ({})
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
      surfaceVersion: "0.1",
      runtimeVersion: "0.1.0",
      auditHealthy: true,
      filesystemBoundaryAvailable: true
    });
    expect(JSON.stringify(started.status)).not.toMatch(/token|secret|verifier|kc_/i);

    await started.close();
    expect(events.slice(-3)).toEqual(["bind.close", "mcp.close", "kernel.stop"]);
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
