import { describe, expect, it } from "vitest";

import { ExecutionManager } from "./execution-manager.js";
import type { WorkspaceProcessOperationResult, WorkspaceProcessRunInput } from "./workspace-manager.js";

const RUNNING: WorkspaceProcessOperationResult = {
  schemaVersion: 1,
  operationId: "op_0000000000000001",
  state: "running",
  stdoutPreview: "",
  stderrPreview: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  sourceTruncated: false,
  bytesSpooled: 0,
  artifact: {
    schemaVersion: 1,
    uri: "artifact://ka_process_fixture",
    mediaType: "application/vnd.kodegpt.execution-stream",
    sizeBytes: 0,
    sourceTruncated: false
  }
};

describe("ExecutionManager", () => {
  it("delegates public process operations without introducing process authority", async () => {
    const calls: unknown[] = [];
    const workspace = {
      async runProcess(input: WorkspaceProcessRunInput) {
        calls.push(["run", input]);
        return RUNNING;
      },
      async processStatus(workspaceId: string, operationId: string) {
        calls.push(["status", workspaceId, operationId]);
        return RUNNING;
      },
      async processCancel(workspaceId: string, operationId: string) {
        calls.push(["cancel", workspaceId, operationId]);
        return { ...RUNNING, state: "cancelled" as const };
      }
    };
    const manager = new ExecutionManager(workspace);
    const input: WorkspaceProcessRunInput = {
      workspaceId: "ws_public",
      logicalExecutable: "python3",
      argv: ["--version"],
      background: true
    };

    const run = await manager.run(input);
    const status = await manager.status("ws_public", run.operationId);
    const cancelled = await manager.cancel("ws_public", run.operationId);

    expect(calls).toEqual([
      ["run", input],
      ["status", "ws_public", "op_0000000000000001"],
      ["cancel", "ws_public", "op_0000000000000001"]
    ]);
    expect(status.operationId).toBe("op_0000000000000001");
    expect(cancelled.state).toBe("cancelled");
    expect(JSON.stringify([run, status, cancelled])).not.toContain("kc_");
    expect(JSON.stringify([run, status, cancelled])).not.toContain("ex_");
    expect(JSON.stringify([run, status, cancelled])).not.toContain("processGroup");
  });
});
