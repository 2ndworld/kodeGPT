import type {
  WorkspaceManager,
  WorkspaceProcessOperationResult,
  WorkspaceProcessRunInput
} from "./workspace-manager.js";

export interface ProcessRunInput extends WorkspaceProcessRunInput {}

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

  status(workspaceId: string, operationId: string): Promise<WorkspaceProcessOperationResult> {
    return this.#workspace.processStatus(workspaceId, operationId);
  }

  cancel(workspaceId: string, operationId: string): Promise<WorkspaceProcessOperationResult> {
    return this.#workspace.processCancel(workspaceId, operationId);
  }
}
