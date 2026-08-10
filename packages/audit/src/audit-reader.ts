import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const AUDIT_EVENT_LIMIT_MAX = 200;
const AUDIT_EVENT_LIMIT_DEFAULT = 50;
const AUDIT_RELATIVE_PATH = "logs/security/audit.jsonl";

export interface PublicAuditEvent {
  schemaVersion: 1;
  timestampUnixMs: number;
  phase: "decision" | "outcome";
  requestId: string;
  operationId: string;
  action: string;
  decision?: string;
  reason?: string;
  outcome?: string;
}

export class AuditReader {
  readonly #auditPath: string;

  constructor(stateRoot: string) {
    if (stateRoot.length === 0) {
      throw new TypeError("stateRoot must not be empty");
    }
    this.#auditPath = join(stateRoot, AUDIT_RELATIVE_PATH);
  }

  async readRecentAuditEvents(limit = AUDIT_EVENT_LIMIT_DEFAULT): Promise<PublicAuditEvent[]> {
    const boundedLimit = clampLimit(limit);
    let contents: string;
    try {
      contents = await readFile(this.#auditPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const events: PublicAuditEvent[] = [];
    for (const line of contents.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      try {
        const event = toPublicAuditEvent(JSON.parse(line) as unknown);
        if (event !== undefined) {
          events.push(event);
        }
      } catch {
        // Diagnostics never return malformed or partially-written records.
      }
    }
    return events.slice(-boundedLimit);
  }
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return AUDIT_EVENT_LIMIT_DEFAULT;
  }
  return Math.min(AUDIT_EVENT_LIMIT_MAX, Math.max(1, Math.trunc(limit)));
}

function toPublicAuditEvent(value: unknown): PublicAuditEvent | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.timestampUnixMs) ||
    (value.timestampUnixMs as number) < 0 ||
    (value.phase !== "decision" && value.phase !== "outcome") ||
    typeof value.requestId !== "string" ||
    !value.requestId.startsWith("req_") ||
    typeof value.operationId !== "string" ||
    !value.operationId.startsWith("op_") ||
    typeof value.action !== "string" ||
    value.action.length === 0
  ) {
    return undefined;
  }

  const decision = optionalString(value.decision);
  const reason = optionalString(value.reason);
  const outcome = optionalString(value.outcome);
  if (decision === null || reason === null || outcome === null) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    timestampUnixMs: value.timestampUnixMs as number,
    phase: value.phase,
    requestId: value.requestId,
    operationId: value.operationId,
    action: value.action,
    ...(decision === undefined ? {} : { decision }),
    ...(reason === undefined ? {} : { reason }),
    ...(outcome === undefined ? {} : { outcome })
  };
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
