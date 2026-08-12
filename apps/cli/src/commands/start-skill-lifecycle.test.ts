import { describe, expect, it } from "vitest";

import { createProductionServiceStack, startKodegpt, type StartKernel } from "./start.js";

function baseDependencies(events: string[]) {
  const kernel: StartKernel = {
    request: async <T>() => ({} as T),
    hello: async () => {
      events.push("kernel.hello");
      return {
        runtimeVersion: "0.1.0",
        testMethods: false,
        auditHealthy: true,
        filesystemBoundaryAvailable: true
      };
    },
    stop: async () => {
      events.push("kernel.stop");
    }
  };

  const workspaceManager = {
    listWorkspaces: () => [],
    openWorkspace: async () => {
      throw new Error("not used");
    },
    closeWorkspace: async () => undefined,
    requireReady: () => {
      throw new Error("not used");
    },
    readFile: async () => ({ contents: "", bytesRead: 0, eof: true }),
    writeFile: async () => ({ bytesWritten: 0, created: false }),
    editFile: async () => ({ bytesWritten: 0, replacements: 0 }),
    gitStatus: async () => {
      throw new Error("not used");
    },
    gitDiff: async () => {
      throw new Error("not used");
    },
    search: async () => [],
    tree: async () => [],
    treeBounded: async () => ({ entries: [], truncated: false }),
    searchBounded: async () => ({ matches: [], truncated: false, truncationReasons: [] }),
    gitCheckpoint: async () => ({ schemaVersion: 1 as const, records: [], truncated: false }),
    gitCheckpointPatch: async () => {
      throw new Error("not used");
    },
    pathIdentity: async () => ({ schemaVersion: 1 as const, exists: false, hashTruncated: false }),
    commitPatchFile: async () => {
      throw new Error("not used");
    },
    inspectExecutable: async () => ({
      schemaVersion: 1 as const,
      executableAvailable: false,
      sandboxAvailable: false
    }),
    runVerificationProcess: async () => {
      throw new Error("not used");
    },
    runProcess: async () => {
      throw new Error("not used");
    },
    processStatus: async () => {
      throw new Error("not used");
    },
    processCancel: async () => {
      throw new Error("not used");
    }
  };

  const dependencies = {
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
    prepareSkillCatalog: async ({ kernel: receivedKernel }: { stateRoot: string; kernel: StartKernel }) => {
      expect(receivedKernel).toBe(kernel);
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
    createMcp: () => ({
      handler: async () => undefined,
      close: async () => {
        events.push("mcp.close");
      }
    }),
    bindLoopback: async () => ({
      host: "127.0.0.1" as const,
      port: 43121,
      close: async () => {
        events.push("bind.close");
      }
    })
  };

  return { dependencies, kernel };
}

describe("production skill catalog lifecycle", () => {
  it("creates the catalog after kernel validation, wires it into tools, and closes it before kernel", async () => {
    const events: string[] = [];
    const { dependencies } = baseDependencies(events);

    const stack = await createProductionServiceStack(
      { runtimePath: "/runtime", stateRoot: "/state" },
      dependencies
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
      "managers"
    ]);
    await expect(stack.toolContext.skill.list({})).resolves.toMatchObject({
      schemaVersion: 1,
      skills: []
    });

    await stack.close();
    expect(events.slice(-2)).toEqual(["skill.close", "kernel.stop"]);

    await stack.close();
    expect(events.filter((event) => event === "skill.close")).toHaveLength(1);
    expect(events.filter((event) => event === "kernel.stop")).toHaveLength(1);
  });

  it("closes an already-created catalog before stopping the kernel when later startup fails", async () => {
    const events: string[] = [];
    const { dependencies } = baseDependencies(events);
    dependencies.createTrustProfile = () => {
      events.push("trust-profile.fail");
      throw new Error("trust failed");
    };

    await expect(
      createProductionServiceStack(
        { runtimePath: "/runtime", stateRoot: "/state" },
        dependencies
      )
    ).rejects.toThrow("trust failed");

    expect(events.slice(-3)).toEqual(["trust-profile.fail", "skill.close", "kernel.stop"]);
  });

  it("closes HTTP resources before the production stack and remains idempotent", async () => {
    const events: string[] = [];
    const { dependencies } = baseDependencies(events);

    const started = await startKodegpt(
      { runtimePath: "/runtime", stateRoot: "/state", port: 43121 },
      dependencies
    );

    await started.close();
    expect(events.slice(-4)).toEqual(["bind.close", "mcp.close", "skill.close", "kernel.stop"]);

    await started.close();
    expect(events.filter((event) => event === "bind.close")).toHaveLength(1);
    expect(events.filter((event) => event === "mcp.close")).toHaveLength(1);
    expect(events.filter((event) => event === "skill.close")).toHaveLength(1);
    expect(events.filter((event) => event === "kernel.stop")).toHaveLength(1);
  });

  it("still stops the kernel when catalog cleanup fails and propagates the cleanup error", async () => {
    const events: string[] = [];
    const { dependencies } = baseDependencies(events);
    dependencies.prepareSkillCatalog = async () => ({
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
        events.push("skill.close.fail");
        throw new Error("skill cleanup failed");
      }
    });

    const stack = await createProductionServiceStack(
      { runtimePath: "/runtime", stateRoot: "/state" },
      dependencies
    );

    await expect(stack.close()).rejects.toThrow("skill cleanup failed");
    expect(events.slice(-2)).toEqual(["skill.close.fail", "kernel.stop"]);

    await stack.close();
    expect(events.filter((event) => event === "skill.close.fail")).toHaveLength(1);
    expect(events.filter((event) => event === "kernel.stop")).toHaveLength(1);
  });
});
