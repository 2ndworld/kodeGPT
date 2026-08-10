export interface ProcessRunInput {
  logicalExecutable: string;
  argv?: string[];
  cwd?: string;
  env?: Record<string, string>;
  background?: boolean;
}

export type ProcessState = "running" | "exited" | "cancelled" | "failed";

export interface ProcessArtifactMetadata {
  schemaVersion: number;
  artifactId: string;
  mediaType: string;
  bytesWritten: number;
  sourceTruncated: boolean;
}

export interface ProcessStatus {
  schemaVersion: number;
  operationId: string;
  state: ProcessState;
  exitCode?: number;
  stdoutPreview?: string;
  stderrPreview?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  artifact?: ProcessArtifactMetadata;
}

export interface WorkspaceExecutionAdapter {
  runProcess(workspaceId: string, input: Required<ProcessRunInput>): Promise<ProcessStatus>;
  processStatus(workspaceId: string, operationId: string): Promise<ProcessStatus>;
  cancelProcess(workspaceId: string, operationId: string): Promise<ProcessStatus>;
}

export class ExecutionManager {
  readonly #workspace: WorkspaceExecutionAdapter;

  constructor(workspace: WorkspaceExecutionAdapter) {
    this.#workspace = workspace;
  }

  run(workspaceId: string, input: ProcessRunInput): Promise<ProcessStatus> {
    if (input.logicalExecutable.length === 0) {
      throw new TypeError("logicalExecutable must not be empty");
    }
    return this.#workspace.runProcess(workspaceId, {
      logicalExecutable: input.logicalExecutable,
      argv: [...(input.argv ?? [])],
      cwd: input.cwd ?? ".",
      env: { ...(input.env ?? {}) },
      background: input.background ?? false
    });
  }

  status(workspaceId: string, operationId: string): Promise<ProcessStatus> {
    validateOperationId(operationId);
    return this.#workspace.processStatus(workspaceId, operationId);
  }

  cancel(workspaceId: string, operationId: string): Promise<ProcessStatus> {
    validateOperationId(operationId);
    return this.#workspace.cancelProcess(workspaceId, operationId);
  }
}

function validateOperationId(operationId: string): void {
  if (
    operationId.length === 0 ||
    operationId.length > 96 ||
    !operationId.startsWith("op_") ||
    !/^[A-Za-z0-9_-]+$/.test(operationId)
  ) {
    throw new TypeError("operationId must be a valid opaque KodeGPT operation ID");
  }
}
