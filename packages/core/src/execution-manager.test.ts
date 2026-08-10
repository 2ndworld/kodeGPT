import { describe, expect, it } from "vitest";

import {
  ExecutionManager,
  type ProcessStatus,
  type WorkspaceExecutionAdapter
} from "./execution-manager.js";

class FakeWorkspace implements WorkspaceExecutionAdapter {
  readonly calls: Array<{ method: string; workspaceId: string; value: unknown }> = [];

  async runProcess(workspaceId: string, input: any): Promise<ProcessStatus> {
    this.calls.push({ method: "run", workspaceId, value: input });
    return { schemaVersion: 1, operationId: "op_fixture", state: input.background ? "running" : "exited" };
  }

  async processStatus(workspaceId: string, operationId: string): Promise<ProcessStatus> {
    this.calls.push({ method: "status", workspaceId, value: operationId });
    return { schemaVersion: 1, operationId, state: "running" };
  }

  async cancelProcess(workspaceId: string, operationId: string): Promise<ProcessStatus> {
    this.calls.push({ method: "cancel", workspaceId, value: operationId });
    return { schemaVersion: 1, operationId, state: "cancelled" };
  }
}

describe("ExecutionManager", () => {
  it("normalizes process.run defaults without exposing runtime capability identity", async () => {
    const workspace = new FakeWorkspace();
    const manager = new ExecutionManager(workspace);

    const result = await manager.run("ws_fixture", { logicalExecutable: "sh" });

    expect(result.operationId).toBe("op_fixture");
    expect(JSON.stringify(result)).not.toContain("kc_");
    expect(workspace.calls).toEqual([
      {
        method: "run",
        workspaceId: "ws_fixture",
        value: {
          logicalExecutable: "sh",
          argv: [],
          cwd: ".",
          env: {},
          background: false
        }
      }
    ]);
  });

  it("scopes status/cancel to opaque operation IDs and rejects malformed IDs before delegation", async () => {
    const workspace = new FakeWorkspace();
    const manager = new ExecutionManager(workspace);

    await expect(manager.status("ws_fixture", "op_valid_1")).resolves.toMatchObject({ state: "running" });
    await expect(manager.cancel("ws_fixture", "op_valid_1")).resolves.toMatchObject({ state: "cancelled" });
    expect(() => manager.status("ws_fixture", "1234")).toThrow(TypeError);
    expect(() => manager.cancel("ws_fixture", "../op_bad")).toThrow(TypeError);
    expect(workspace.calls).toHaveLength(2);
  });
});
