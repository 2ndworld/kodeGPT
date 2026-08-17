import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { SystemdUserManager } from "./systemd.js";

export interface ServiceRuntimeStatusV1 {
  schemaVersion: 1;
  releaseId: string;
  pid: number;
  ready: true;
  localPort: number;
  runtimeVersion: string;
  protocolVersion: "2026-07-28";
  surfaceVersion: "0.3" | "0.4" | "0.5" | "0.6" | "0.7" | "0.8";
  reservedName: string;
  publicUrl: string;
}

const STATUS_FIELDS = new Set([
  "schemaVersion",
  "releaseId",
  "pid",
  "ready",
  "localPort",
  "runtimeVersion",
  "protocolVersion",
  "surfaceVersion",
  "reservedName",
  "publicUrl"
]);

export class ServiceRuntimeStatusStore {
  readonly path: string;

  constructor(readonly stateRoot: string) {
    this.path = join(stateRoot, "service-runtime.json");
  }

  async read(): Promise<ServiceRuntimeStatusV1 | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new Error("service runtime status is not valid JSON", { cause: error });
    }
    return parseRuntimeStatus(value);
  }

  async write(status: ServiceRuntimeStatusV1): Promise<void> {
    const validated = parseRuntimeStatus(status);
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    const temporary = join(this.stateRoot, `.service-runtime.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async removeIfMatches(releaseId: string, pid: number): Promise<boolean> {
    const current = await this.read();
    if (current === undefined || current.releaseId !== releaseId || current.pid !== pid) return false;
    await rm(this.path, { force: true });
    return true;
  }

  async delete(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

export async function waitForServiceReady(options: {
  manager: SystemdUserManager;
  statusStore: ServiceRuntimeStatusStore;
  expectedReleaseId: string;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<ServiceRuntimeStatusV1> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 250;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const managerState = await options.manager.show();
    if (managerState.activeState === "failed") {
      const result = managerState.result === undefined ? "unknown" : managerState.result;
      throw new Error(`KodeGPT service failed before readiness result=${result}`);
    }
    const runtimeStatus = await options.statusStore.read();
    if (
      managerState.activeState === "active" &&
      managerState.mainPid !== undefined &&
      runtimeStatus !== undefined &&
      runtimeStatus.releaseId === options.expectedReleaseId &&
      runtimeStatus.pid === managerState.mainPid
    ) {
      return runtimeStatus;
    }
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }

  throw new Error(`timed out waiting for KodeGPT service readiness release=${options.expectedReleaseId}`);
}

function parseRuntimeStatus(value: unknown): ServiceRuntimeStatusV1 {
  if (!isRecord(value)) throw new Error("service runtime status must be an object");
  for (const key of Object.keys(value)) {
    if (!STATUS_FIELDS.has(key)) throw new Error(`unknown service runtime status field: ${key}`);
  }
  if (value.schemaVersion !== 1) throw new Error("unsupported service runtime status schema");
  const releaseId = stringField(value.releaseId, "releaseId");
  if (!/^rel_[a-f0-9]{32}$/.test(releaseId)) throw new Error("invalid service runtime releaseId");
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) throw new Error("invalid service runtime pid");
  if (value.ready !== true) throw new Error("invalid service runtime ready state");
  if (!Number.isSafeInteger(value.localPort) || (value.localPort as number) < 1 || (value.localPort as number) > 65_535) {
    throw new Error("invalid service runtime localPort");
  }
  const runtimeVersion = stringField(value.runtimeVersion, "runtimeVersion");
  if (value.protocolVersion !== "2026-07-28") throw new Error("invalid service runtime protocolVersion");
  if (
    value.surfaceVersion !== "0.3" &&
    value.surfaceVersion !== "0.4" &&
    value.surfaceVersion !== "0.5" &&
    value.surfaceVersion !== "0.6" &&
    value.surfaceVersion !== "0.7" &&
    value.surfaceVersion !== "0.8"
  ) {
    throw new Error("invalid service runtime surfaceVersion");
  }
  const reservedName = stringField(value.reservedName, "reservedName");
  if (/[\s/@?#]/.test(reservedName)) throw new Error("invalid service runtime reservedName");
  const publicUrl = stringField(value.publicUrl, "publicUrl");
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch (error) {
    throw new Error("invalid service runtime publicUrl", { cause: error });
  }
  if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
    throw new Error("invalid service runtime publicUrl");
  }

  return {
    schemaVersion: 1,
    releaseId,
    pid: value.pid as number,
    ready: true,
    localPort: value.localPort as number,
    runtimeVersion,
    protocolVersion: "2026-07-28",
    surfaceVersion: value.surfaceVersion,
    reservedName,
    publicUrl: url.toString()
  };
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid service runtime ${name}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
