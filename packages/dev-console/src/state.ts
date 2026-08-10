export const CONSOLE_GIT_FRESH_MS = 5_000;

export type ConsoleStatus = "FAILED" | "BLOCKED" | "DEGRADED" | "WORKING" | "READY";

export interface ConsoleState {
  schemaVersion: 1;
  generatedAtMs: number;
  status: ConsoleStatus;
  workspace: {
    items: unknown[];
  };
  changes: {
    workspaceId?: string;
    gitStatus?: unknown;
    refreshedAtMs?: number;
    stale: boolean;
  };
  processes: {
    operations: unknown[];
  };
  security: {
    health: unknown;
  };
  diagnostics: {
    value: unknown;
  };
}

export interface ConsoleStatusSignals {
  failed?: boolean;
  blocked?: boolean;
  degraded?: boolean;
  working?: boolean;
}

type GitCacheEntry = {
  value: unknown;
  refreshedAtMs: number;
};

export class ConsoleStateStore {
  readonly #gitByWorkspace = new Map<string, GitCacheEntry>();
  readonly #processes = new Map<string, unknown>();

  recordGitStatus(workspaceId: string, value: unknown, refreshedAtMs = Date.now()): void {
    if (workspaceId.length === 0 || !Number.isFinite(refreshedAtMs)) {
      return;
    }
    this.#gitByWorkspace.set(workspaceId, { value, refreshedAtMs });
  }

  recordProcessOperation(value: unknown): void {
    if (!isRecord(value) || typeof value.operationId !== "string" || !value.operationId.startsWith("op_")) {
      return;
    }
    this.#processes.set(value.operationId, value);
  }

  snapshot(
    input: {
      workspaces: unknown;
      health: unknown;
      blocked?: boolean;
      failed?: boolean;
    },
    nowMs = Date.now()
  ): ConsoleState {
    const workspaces = Array.isArray(input.workspaces) ? input.workspaces : [];
    const workspaceId = firstWorkspaceId(workspaces);
    const gitEntry = workspaceId === undefined ? undefined : this.#gitByWorkspace.get(workspaceId);
    const stale =
      gitEntry !== undefined && Math.max(0, nowMs - gitEntry.refreshedAtMs) > CONSOLE_GIT_FRESH_MS;
    const operations = [...this.#processes.values()];
    const working = operations.some(
      (operation) => isRecord(operation) && operation.state === "running"
    );
    const health = isRecord(input.health) ? input.health : {};
    const failed =
      input.failed === true || health.auditHealthy === false || health.filesystemBoundaryAvailable === false;
    const degraded = !failed && (health.ok === false || stale);
    const status = resolveConsoleStatus({
      failed,
      blocked: input.blocked === true,
      degraded,
      working
    });

    return {
      schemaVersion: 1,
      generatedAtMs: nowMs,
      status,
      workspace: { items: workspaces },
      changes: {
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(gitEntry === undefined
          ? {}
          : { gitStatus: gitEntry.value, refreshedAtMs: gitEntry.refreshedAtMs }),
        stale
      },
      processes: { operations },
      security: { health: input.health },
      diagnostics: {
        value: isRecord(input.health) && "diagnostics" in input.health ? input.health.diagnostics : null
      }
    };
  }
}

export function resolveConsoleStatus(signals: ConsoleStatusSignals): ConsoleStatus {
  if (signals.failed) return "FAILED";
  if (signals.blocked) return "BLOCKED";
  if (signals.degraded) return "DEGRADED";
  if (signals.working) return "WORKING";
  return "READY";
}

function firstWorkspaceId(workspaces: unknown[]): string | undefined {
  for (const workspace of workspaces) {
    if (isRecord(workspace) && typeof workspace.id === "string" && workspace.id.length > 0) {
      return workspace.id;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
