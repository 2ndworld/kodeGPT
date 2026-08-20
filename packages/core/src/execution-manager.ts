import type {
  WorkspaceManager,
  WorkspaceProcessOperationResult,
  WorkspaceProcessRunInput
} from "./workspace-manager.js";

export interface ProcessRunInput extends WorkspaceProcessRunInput {}

const PROCESS_STATUS_POLL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ExecutionManager {
  readonly #workspace: Pick<WorkspaceManager, "runProcess" | "processStatus" | "processCancel">;

  constructor(
    workspace: Pick<WorkspaceManager, "runProcess" | "processStatus" | "processCancel">
  ) {
    this.#workspace = workspace;
  }

  run(input: ProcessRunInput): Promise<WorkspaceProcessOperationResult> {
    return this.#workspace.runProcess(input);
  }

  async status(
    workspaceId: string,
    operationId: string,
    waitMs = 0
  ): Promise<WorkspaceProcessOperationResult> {
    const deadline = Date.now() + waitMs;
    let current = await this.#workspace.processStatus(workspaceId, operationId);
    while (current.state === "running" && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(PROCESS_STATUS_POLL_MS, remaining));
      current = await this.#workspace.processStatus(workspaceId, operationId);
    }
    return current;
  }

  cancel(workspaceId: string, operationId: string): Promise<WorkspaceProcessOperationResult> {
    return this.#workspace.processCancel(workspaceId, operationId);
  }
}
