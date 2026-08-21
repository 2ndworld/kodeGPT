import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { createConnection } from "node:net";

import type { ProcessRunInput } from "./execution-manager.js";
import type { ProcessOperationState, WorkspaceProcessOperationResult } from "./workspace-manager.js";

export const MAX_PREVIEW_SESSIONS = 32;
export const DEFAULT_PREVIEW_WAIT_MS = 3_000;
export const MAX_PREVIEW_WAIT_MS = 10_000;

export interface PreviewProcessAdapter {
  run(input: ProcessRunInput): Promise<WorkspaceProcessOperationResult>;
  status(workspaceId: string, operationId: string): Promise<WorkspaceProcessOperationResult>;
  cancel(workspaceId: string, operationId: string): Promise<WorkspaceProcessOperationResult>;
}

export interface PreviewProbeResult {
  reachable: boolean;
  httpStatus: number | null;
}

export interface PreviewProbe {
  portInUse?(port: number): Promise<boolean>;
  inspect(input: { port: number; requestPath: string }): Promise<PreviewProbeResult>;
}

export interface EvidenceSourceStateRef {
  headOid: string;
  changesFingerprint: string;
}

export interface PreviewSourceStateAdapter {
  resolve(workspaceId: string): Promise<EvidenceSourceStateRef>;
}

export class NodeLoopbackPreviewProbe implements PreviewProbe {
  portInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const socket = createConnection({ host: "127.0.0.1", port });
      const finish = (inUse: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(inUse);
      };
      socket.setTimeout(500);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    });
  }

  inspect(input: { port: number; requestPath: string }): Promise<PreviewProbeResult> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: PreviewProbeResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const probe = request(
        {
          host: "127.0.0.1",
          port: input.port,
          path: input.requestPath,
          method: "HEAD"
        },
        (response) => {
          const httpStatus = response.statusCode ?? null;
          response.destroy();
          finish({ reachable: true, httpStatus });
        }
      );
      probe.setTimeout(500, () => probe.destroy());
      probe.once("error", () => finish({ reachable: false, httpStatus: null }));
      probe.end();
    });
  }
}

export interface PreviewStartInput {
  workspaceId: string;
  logicalExecutable: string;
  argv: string[];
  port: number;
  cwd?: string;
  env?: Record<string, string>;
  requestPath?: string;
  waitMs?: number;
}

export interface PreviewLookupInput {
  workspaceId: string;
  previewId: string;
}

export interface PreviewStatusResult {
  schemaVersion: 1;
  previewId: string;
  operationId: string;
  url: string;
  processState: ProcessOperationState;
  exitCode?: number;
  reachable: boolean;
  httpStatus: number | null;
  sourceState: EvidenceSourceStateRef;
}

type PreviewRecord = {
  previewId: string;
  workspaceId: string;
  operationId: string;
  port: number;
  requestPath: string;
  url: string;
  sourceState: EvidenceSourceStateRef;
};

export class PreviewManagerError extends Error {
  readonly code: "PREVIEW_NOT_FOUND" | "PREVIEW_LIMIT_REACHED" | "PREVIEW_ENDPOINT_IN_USE";

  constructor(code: PreviewManagerError["code"], message: string) {
    super(message);
    this.name = "PreviewManagerError";
    this.code = code;
  }
}

export class PreviewManager {
  readonly #process: PreviewProcessAdapter;
  readonly #probe: PreviewProbe;
  readonly #sourceState: PreviewSourceStateAdapter;
  readonly #idFactory: () => string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #previews = new Map<string, PreviewRecord>();
  #pendingStarts = 0;

  constructor(
    process: PreviewProcessAdapter,
    options: {
      probe: PreviewProbe;
      sourceState: PreviewSourceStateAdapter;
      idFactory?: () => string;
      sleep?: (ms: number) => Promise<void>;
    }
  ) {
    this.#process = process;
    this.#probe = options.probe;
    this.#sourceState = options.sourceState;
    this.#idFactory =
      options.idFactory ?? (() => `pv_${randomUUID().replaceAll("-", "")}`);
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async start(input: PreviewStartInput): Promise<PreviewStatusResult> {
    validateStartInput(input);
    await this.#reserveStartSlot();
    let slotReserved = true;
    try {
      if (this.#probe.portInUse !== undefined && (await this.#probe.portInUse(input.port))) {
        throw new PreviewManagerError(
          "PREVIEW_ENDPOINT_IN_USE",
          "Preview loopback port is already in use"
        );
      }
      const requestPath = input.requestPath ?? "/";
      const previewId = this.#idFactory();
      if (!/^pv_[a-f0-9]{32}$/.test(previewId)) {
        throw new TypeError("Preview ID factory returned an invalid preview ID");
      }
      if (this.#previews.has(previewId)) {
        throw new TypeError("Preview ID factory returned a duplicate preview ID");
      }
      const sourceState = validateEvidenceSourceStateRef(
        await this.#sourceState.resolve(input.workspaceId)
      );
      const operation = await this.#process.run({
        workspaceId: input.workspaceId,
        logicalExecutable: input.logicalExecutable,
        argv: input.argv,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.env === undefined ? {} : { env: input.env }),
        background: true
      });
      const record: PreviewRecord = {
        previewId,
        workspaceId: input.workspaceId,
        operationId: operation.operationId,
        port: input.port,
        requestPath,
        url: `http://127.0.0.1:${input.port}${requestPath}`,
        sourceState
      };
      this.#previews.set(previewId, record);
      this.#pendingStarts -= 1;
      slotReserved = false;
      return this.#waitForReadiness(record, operation, input.waitMs ?? DEFAULT_PREVIEW_WAIT_MS);
    } finally {
      if (slotReserved) this.#pendingStarts -= 1;
    }
  }

  async inspect(input: PreviewLookupInput): Promise<PreviewStatusResult> {
    const record = this.#lookup(input);
    const operation = await this.#process.status(record.workspaceId, record.operationId);
    if (operation.state !== "running") {
      return resultFrom(record, operation, { reachable: false, httpStatus: null });
    }
    const probe = await this.#probe.inspect({
      port: record.port,
      requestPath: record.requestPath
    });
    return resultFrom(record, operation, probe);
  }

  async stop(input: PreviewLookupInput): Promise<PreviewStatusResult> {
    const record = this.#lookup(input);
    let operation = await this.#process.status(record.workspaceId, record.operationId);
    if (operation.state === "running") {
      operation = await this.#process.cancel(record.workspaceId, record.operationId);
    }
    this.#previews.delete(record.previewId);
    return resultFrom(record, operation, { reachable: false, httpStatus: null });
  }

  releaseWorkspace(workspaceId: string): void {
    for (const [previewId, record] of this.#previews) {
      if (record.workspaceId === workspaceId) this.#previews.delete(previewId);
    }
  }

  async #waitForReadiness(
    record: PreviewRecord,
    initialOperation: WorkspaceProcessOperationResult,
    waitMs: number
  ): Promise<PreviewStatusResult> {
    let operation = initialOperation;
    if (operation.state !== "running") {
      return resultFrom(record, operation, { reachable: false, httpStatus: null });
    }
    let probe = await this.#probe.inspect({ port: record.port, requestPath: record.requestPath });
    if (probe.reachable || waitMs === 0) {
      return resultFrom(record, operation, probe);
    }

    let waited = 0;
    while (waited < waitMs) {
      const delay = Math.min(100, waitMs - waited);
      await this.#sleep(delay);
      waited += delay;
      operation = await this.#process.status(record.workspaceId, record.operationId);
      if (operation.state !== "running") {
        return resultFrom(record, operation, { reachable: false, httpStatus: null });
      }
      probe = await this.#probe.inspect({ port: record.port, requestPath: record.requestPath });
      if (probe.reachable) {
        return resultFrom(record, operation, probe);
      }
    }
    return resultFrom(record, operation, probe);
  }

  #lookup(input: PreviewLookupInput): PreviewRecord {
    const record = this.#previews.get(input.previewId);
    if (record === undefined || record.workspaceId !== input.workspaceId) {
      throw new PreviewManagerError("PREVIEW_NOT_FOUND", "Preview was not found");
    }
    return record;
  }

  async #reserveStartSlot(): Promise<void> {
    if (this.#previews.size + this.#pendingStarts >= MAX_PREVIEW_SESSIONS) {
      for (const [previewId, record] of this.#previews) {
        if (this.#previews.size + this.#pendingStarts < MAX_PREVIEW_SESSIONS) break;
        try {
          const operation = await this.#process.status(record.workspaceId, record.operationId);
          if (operation.state !== "running") this.#previews.delete(previewId);
        } catch {
          // A failed status check is not evidence that a preview is safe to prune.
        }
      }
    }
    if (this.#previews.size + this.#pendingStarts >= MAX_PREVIEW_SESSIONS) {
      throw new PreviewManagerError("PREVIEW_LIMIT_REACHED", "Preview session limit reached");
    }
    this.#pendingStarts += 1;
  }
}

function validateStartInput(input: PreviewStartInput): void {
  if (input.workspaceId.length === 0 || input.logicalExecutable.length === 0) {
    throw new TypeError("Preview workspaceId and logicalExecutable must not be empty");
  }
  if (!Number.isSafeInteger(input.port) || input.port < 1024 || input.port > 65_535) {
    throw new RangeError("Preview port must be an integer in the range 1024..65535");
  }
  const requestPath = input.requestPath ?? "/";
  let normalizedPath = "";
  try {
    const parsed = new URL(requestPath, "http://127.0.0.1");
    normalizedPath = `${parsed.pathname}${parsed.search}`;
  } catch {
    throw new TypeError("Preview requestPath is invalid");
  }
  if (
    !requestPath.startsWith("/") ||
    requestPath.startsWith("//") ||
    Buffer.byteLength(requestPath, "utf8") > 2048 ||
    requestPath.includes("#") ||
    /[\u0000-\u001f\u007f]/.test(requestPath) ||
    normalizedPath !== requestPath
  ) {
    throw new TypeError("Preview requestPath is invalid");
  }
  const waitMs = input.waitMs ?? DEFAULT_PREVIEW_WAIT_MS;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_PREVIEW_WAIT_MS) {
    throw new RangeError("Preview waitMs must be an integer in the range 0..10000");
  }
}

function resultFrom(
  record: PreviewRecord,
  operation: WorkspaceProcessOperationResult,
  probe: PreviewProbeResult
): PreviewStatusResult {
  return {
    schemaVersion: 1,
    previewId: record.previewId,
    operationId: record.operationId,
    url: record.url,
    processState: operation.state,
    ...(operation.exitCode === undefined ? {} : { exitCode: operation.exitCode }),
    reachable: probe.reachable,
    httpStatus: probe.httpStatus,
    sourceState: { ...record.sourceState }
  };
}

function validateEvidenceSourceStateRef(value: EvidenceSourceStateRef): EvidenceSourceStateRef {
  if (
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.headOid) ||
    !/^[0-9a-f]{64}$/.test(value.changesFingerprint)
  ) {
    throw new TypeError("Preview source state is invalid");
  }
  return { ...value };
}
