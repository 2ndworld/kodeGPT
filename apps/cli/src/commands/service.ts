import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  ServiceMetadataStore,
  type ServiceMetadataV1,
  type ServiceReleaseRecord
} from "../service/metadata.js";
import {
  ServiceRuntimeStatusStore,
  type ServiceRuntimeStatusV1
} from "../service/runtime-status.js";
import {
  removeUserUnit,
  renderKodegptUserUnit,
  writeUserUnitAtomic,
  type SystemdUserManager
} from "../service/systemd.js";
import {
  validateZrokReservedNameSelection,
  type ExposedZrokKodegpt,
  type ExposeZrokOptions
} from "./expose-zrok.js";
import { DEFAULT_MCP_PORT } from "./start.js";

export type ServiceCommand = "install" | "start" | "stop" | "restart" | "status" | "uninstall" | "run";

export interface ServiceInstallOptions {
  command: "install";
  stateRoot: string;
  name: string;
  port: number;
}

export interface ServiceSimpleOptions {
  command: "start" | "stop" | "restart" | "uninstall";
  stateRoot: string;
}

export interface ServiceStatusOptions {
  command: "status";
  stateRoot: string;
  json: boolean;
}

export interface ServiceRunOptions {
  command: "run";
  stateRoot: string;
  releaseId: string;
  name: string;
  port: number;
}

export type ParsedServiceArguments =
  | ServiceInstallOptions
  | ServiceSimpleOptions
  | ServiceStatusOptions
  | ServiceRunOptions;

export interface ServiceOperatorDependencies {
  metadataStore: ServiceMetadataStore;
  runtimeStatusStore: ServiceRuntimeStatusStore;
  manager: SystemdUserManager;
  serviceDataRoot: string;
  unitPath: string;
  prepareRelease(options: ServiceInstallOptions): Promise<ServiceReleaseRecord>;
  waitForReady(releaseId: string): Promise<ServiceRuntimeStatusV1>;
  cleanupReleases?(metadata: ServiceMetadataV1): Promise<void>;
}

export interface InstalledServiceRunDependencies {
  metadataStore: ServiceMetadataStore;
  runtimeStatusStore: ServiceRuntimeStatusStore;
  pid?: number;
  exposeZrok(options: ExposeZrokOptions): Promise<ExposedZrokKodegpt>;
}

export interface RunningInstalledService {
  termination: Promise<never>;
  close(): Promise<void>;
}

export interface ServiceStatusSnapshot {
  installed: boolean;
  state: "running" | "stopped" | "failed" | "activating" | "unknown";
  enabled: boolean;
  linger: "enabled" | "disabled" | "unknown";
  packageVersion?: string;
  activeReleaseId?: string;
  stagedReleaseId?: string;
  rollbackReleaseId?: string;
  runtimeVersion?: string;
  protocolVersion?: "2026-07-28";
  surfaceVersion?: "0.3";
  localPort?: number;
  listenerReady: boolean;
  managedExposure: boolean;
  reservedName?: string;
  publicUrl?: string;
  lastFailureSummary?: string;
}

export async function installService(
  options: ServiceInstallOptions,
  dependencies: ServiceOperatorDependencies
): Promise<string> {
  const release = await dependencies.prepareRelease(options);
  if (release.reservedName !== options.name || release.port !== options.port) {
    throw new Error("prepared service release does not match requested exposure identity");
  }
  const unit = renderKodegptUserUnit(release, options.stateRoot);
  await writeUserUnitAtomic(dependencies.unitPath, unit);
  await dependencies.metadataStore.stageRelease(release);
  await dependencies.manager.daemonReload();
  await dependencies.manager.enable();
  return `KodeGPT service installed staged=${release.releaseId}`;
}

export async function uninstallService(
  _options: ServiceSimpleOptions & { command: "uninstall" },
  dependencies: ServiceOperatorDependencies
): Promise<string> {
  await dependencies.manager.stop();
  await dependencies.manager.disable();
  await removeUserUnit(dependencies.unitPath);
  await dependencies.manager.daemonReload();
  await rm(dependencies.serviceDataRoot, { recursive: true, force: true });
  await dependencies.runtimeStatusStore.delete();
  await dependencies.metadataStore.delete();
  return "KodeGPT service uninstalled";
}

export async function startService(
  _options: ServiceSimpleOptions & { command: "start" },
  dependencies: ServiceOperatorDependencies
): Promise<string> {
  const metadata = await dependencies.metadataStore.read();
  const targetReleaseId = metadata.stagedReleaseId ?? metadata.activeReleaseId;
  if (targetReleaseId === undefined) throw new Error("KodeGPT service has no installed release to start");
  const target = metadata.releases[targetReleaseId];
  if (target === undefined) throw new Error("service release metadata is missing the start target");

  await dependencies.manager.resetFailed();
  await dependencies.manager.start();
  await dependencies.waitForReady(targetReleaseId);
  if (metadata.stagedReleaseId === targetReleaseId) {
    const promoted = await dependencies.metadataStore.promoteStagedRelease();
    await dependencies.cleanupReleases?.(promoted);
  }
  return `KodeGPT service running active=${targetReleaseId}`;
}

export async function stopService(
  _options: ServiceSimpleOptions & { command: "stop" },
  dependencies: ServiceOperatorDependencies
): Promise<string> {
  await dependencies.manager.stop();
  return "KodeGPT service stopped";
}

export async function restartService(
  options: ServiceSimpleOptions & { command: "restart" },
  dependencies: ServiceOperatorDependencies
): Promise<string> {
  const metadata = await dependencies.metadataStore.read();
  const targetReleaseId = metadata.stagedReleaseId ?? metadata.activeReleaseId;
  if (targetReleaseId === undefined) throw new Error("KodeGPT service has no installed release to restart");
  const target = metadata.releases[targetReleaseId];
  if (target === undefined) throw new Error("service release metadata is missing the restart target");

  if (metadata.stagedReleaseId !== undefined && metadata.stagedReleaseId !== metadata.activeReleaseId) {
    await writeUserUnitAtomic(dependencies.unitPath, renderKodegptUserUnit(target, options.stateRoot));
    await dependencies.manager.daemonReload();
  }
  await dependencies.manager.resetFailed();
  if (metadata.activeReleaseId === undefined) await dependencies.manager.start();
  else await dependencies.manager.restart();
  try {
    await dependencies.waitForReady(targetReleaseId);
  } catch (candidateError) {
    if (
      metadata.activeReleaseId !== undefined &&
      metadata.stagedReleaseId !== undefined &&
      metadata.stagedReleaseId !== metadata.activeReleaseId
    ) {
      const rollbackRelease = metadata.releases[metadata.activeReleaseId];
      if (rollbackRelease !== undefined) {
        try {
          await writeUserUnitAtomic(
            dependencies.unitPath,
            renderKodegptUserUnit(rollbackRelease, options.stateRoot)
          );
          await dependencies.manager.daemonReload();
          await dependencies.manager.resetFailed();
          await dependencies.manager.restart();
          await dependencies.waitForReady(rollbackRelease.releaseId);
        } catch (rollbackError) {
          throw new AggregateError(
            [candidateError, rollbackError],
            "candidate service activation failed and rollback also failed"
          );
        }
      }
    }
    throw candidateError;
  }
  if (metadata.stagedReleaseId === targetReleaseId) {
    const promoted = await dependencies.metadataStore.promoteStagedRelease();
    await dependencies.cleanupReleases?.(promoted);
  }
  return `KodeGPT service running active=${targetReleaseId}`;
}

export async function getServiceStatus(
  dependencies: ServiceOperatorDependencies
): Promise<ServiceStatusSnapshot> {
  const [metadata, managerState, runtimeStatus, linger] = await Promise.all([
    dependencies.metadataStore.read(),
    dependencies.manager.show(),
    dependencies.runtimeStatusStore.read(),
    dependencies.manager.linger()
  ]);
  const currentReleaseId = metadata.activeReleaseId ?? metadata.stagedReleaseId;
  const currentRelease = currentReleaseId === undefined ? undefined : metadata.releases[currentReleaseId];
  const runtimeMatches =
    runtimeStatus !== undefined &&
    metadata.activeReleaseId !== undefined &&
    runtimeStatus.releaseId === metadata.activeReleaseId &&
    managerState.mainPid !== undefined &&
    runtimeStatus.pid === managerState.mainPid &&
    managerState.activeState === "active";
  const state = normalizeServiceState(managerState.activeState);
  const installed = Object.keys(metadata.releases).length > 0 || managerState.loadState !== "not-found";

  return {
    installed,
    state,
    enabled: managerState.unitFileState === "enabled",
    linger,
    listenerReady: runtimeMatches,
    managedExposure: currentRelease !== undefined,
    ...(currentRelease === undefined ? {} : {
      packageVersion: currentRelease.packageVersion,
      reservedName: currentRelease.reservedName,
      localPort: runtimeMatches && runtimeStatus !== undefined ? runtimeStatus.localPort : currentRelease.port
    }),
    ...(metadata.activeReleaseId === undefined ? {} : { activeReleaseId: metadata.activeReleaseId }),
    ...(metadata.stagedReleaseId === undefined ? {} : { stagedReleaseId: metadata.stagedReleaseId }),
    ...(metadata.rollbackReleaseId === undefined ? {} : { rollbackReleaseId: metadata.rollbackReleaseId }),
    ...(runtimeMatches && runtimeStatus !== undefined ? {
      runtimeVersion: runtimeStatus.runtimeVersion,
      protocolVersion: runtimeStatus.protocolVersion,
      surfaceVersion: runtimeStatus.surfaceVersion,
      publicUrl: runtimeStatus.publicUrl
    } : {}),
    ...(state === "failed" && managerState.result !== undefined ? { lastFailureSummary: managerState.result } : {})
  };
}

export function formatServiceStatus(status: ServiceStatusSnapshot, json: boolean): string {
  if (json) return JSON.stringify(status);
  const fields = [
    `installed=${status.installed}`,
    `state=${status.state}`,
    `enabled=${status.enabled}`,
    `linger=${status.linger}`,
    `listenerReady=${status.listenerReady}`,
    `managedExposure=${status.managedExposure}`
  ];
  if (status.packageVersion !== undefined) fields.push(`version=${status.packageVersion}`);
  if (status.activeReleaseId !== undefined) fields.push(`active=${status.activeReleaseId}`);
  if (status.stagedReleaseId !== undefined) fields.push(`staged=${status.stagedReleaseId}`);
  if (status.rollbackReleaseId !== undefined) fields.push(`rollback=${status.rollbackReleaseId}`);
  if (status.runtimeVersion !== undefined) fields.push(`runtime=${status.runtimeVersion}`);
  if (status.protocolVersion !== undefined) fields.push(`protocol=${status.protocolVersion}`);
  if (status.surfaceVersion !== undefined) fields.push(`surface=${status.surfaceVersion}`);
  if (status.localPort !== undefined) fields.push(`localPort=${status.localPort}`);
  if (status.reservedName !== undefined) fields.push(`zrokName=${status.reservedName}`);
  if (status.publicUrl !== undefined) fields.push(`publicUrl=${status.publicUrl}`);
  if (status.lastFailureSummary !== undefined) fields.push(`lastFailure=${status.lastFailureSummary}`);
  return fields.join(" ");
}

function normalizeServiceState(activeState: string): ServiceStatusSnapshot["state"] {
  if (activeState === "active") return "running";
  if (activeState === "inactive") return "stopped";
  if (activeState === "failed") return "failed";
  if (activeState === "activating" || activeState === "reloading" || activeState === "deactivating") return "activating";
  return "unknown";
}

export async function runInstalledService(
  options: ServiceRunOptions,
  dependencies: InstalledServiceRunDependencies
): Promise<RunningInstalledService> {
  const metadata = await dependencies.metadataStore.read();
  const release = metadata.releases[options.releaseId];
  if (
    release === undefined ||
    release.reservedName !== options.name ||
    release.port !== options.port
  ) {
    throw new Error("service run arguments do not match installed release metadata");
  }

  const pid = dependencies.pid ?? process.pid;
  const exposed = await dependencies.exposeZrok({
    runtimePath: release.runtimePath,
    stateRoot: options.stateRoot,
    name: release.reservedName,
    port: release.port,
    requireExistingConnectorCredential: true
  });
  if (exposed.status.credentialCreated || exposed.status.chatgptServerUrl !== undefined) {
    await exposed.close().catch(() => undefined);
    throw new Error("managed service exposure must not issue connector credentials");
  }

  await dependencies.runtimeStatusStore.write({
    schemaVersion: 1,
    releaseId: release.releaseId,
    pid,
    ready: true,
    localPort: exposed.status.local.port,
    runtimeVersion: exposed.status.local.runtimeVersion,
    protocolVersion: exposed.status.local.protocolVersion,
    surfaceVersion: exposed.status.local.surfaceVersion,
    reservedName: release.reservedName,
    publicUrl: exposed.status.publicUrl
  });

  const removeReady = async () => {
    await dependencies.runtimeStatusStore.removeIfMatches(release.releaseId, pid).catch(() => undefined);
  };
  const termination = exposed.termination.finally(removeReady) as Promise<never>;
  return {
    termination,
    async close() {
      try {
        await exposed.close();
      } finally {
        await removeReady();
      }
    }
  };
}

export function parseServiceArguments(args: string[], homeDir: string): ParsedServiceArguments {
  const [command, ...rest] = args;
  if (command === undefined) {
    throw new Error("service requires install, start, stop, restart, status, or uninstall");
  }
  if (!isServiceCommand(command)) {
    throw new Error(`unknown service command: ${command}`);
  }

  if (command === "install") return parseInstall(rest, homeDir);
  if (command === "status") return parseStatus(rest, homeDir);
  if (command === "run") return parseRun(rest, homeDir);
  return parseSimple(command, rest, homeDir);
}

function parseInstall(args: string[], homeDir: string): ServiceInstallOptions {
  let stateRoot = join(homeDir, ".kodegpt");
  let name: string | undefined;
  let port = DEFAULT_MCP_PORT;
  let stateRootSeen = false;
  let portSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !flag.startsWith("--")) {
      throw new Error("service install accepts only named options");
    }
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    index += 1;
    switch (flag) {
      case "--name":
        if (name !== undefined) throw new Error("--name may be specified only once");
        validateZrokReservedNameSelection(value);
        name = value;
        break;
      case "--port":
        if (portSeen) throw new Error("--port may be specified only once");
        portSeen = true;
        port = parsePort(value);
        break;
      case "--state-root":
        if (stateRootSeen) throw new Error("--state-root may be specified only once");
        stateRootSeen = true;
        stateRoot = value;
        break;
      default:
        throw new Error(`unknown service install option: ${flag}`);
    }
  }

  if (name === undefined) throw new Error("service install requires --name <namespace:name>");
  return { command: "install", stateRoot, name, port };
}

function parseRun(args: string[], homeDir: string): ServiceRunOptions {
  let stateRoot = join(homeDir, ".kodegpt");
  let releaseId: string | undefined;
  let name: string | undefined;
  let port: number | undefined;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !flag.startsWith("--")) throw new Error("service run accepts only named options");
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (seen.has(flag)) throw new Error(`${flag} may be specified only once`);
    seen.add(flag);
    index += 1;
    switch (flag) {
      case "--state-root":
        stateRoot = value;
        break;
      case "--release-id":
        if (!/^rel_[a-f0-9]{32}$/.test(value)) throw new Error("invalid service release id");
        releaseId = value;
        break;
      case "--name":
        validateZrokReservedNameSelection(value);
        name = value;
        break;
      case "--port":
        port = parsePort(value);
        break;
      default:
        throw new Error(`unknown service run option: ${flag}`);
    }
  }

  if (releaseId === undefined || name === undefined || port === undefined) {
    throw new Error("service run requires --release-id, --name, and --port");
  }
  return { command: "run", stateRoot, releaseId, name, port };
}

function parseStatus(args: string[], homeDir: string): ServiceStatusOptions {
  let stateRoot = join(homeDir, ".kodegpt");
  let stateRootSeen = false;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--json") {
      if (json) throw new Error("--json may be specified only once");
      json = true;
      continue;
    }
    if (flag === "--state-root") {
      if (stateRootSeen) throw new Error("--state-root may be specified only once");
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--state-root requires a value");
      stateRootSeen = true;
      stateRoot = value;
      index += 1;
      continue;
    }
    throw new Error("service status accepts only --json and --state-root");
  }

  return { command: "status", stateRoot, json };
}

function parseSimple(
  command: ServiceSimpleOptions["command"],
  args: string[],
  homeDir: string
): ServiceSimpleOptions {
  let stateRoot = join(homeDir, ".kodegpt");
  if (args.length === 0) return { command, stateRoot };
  if (args.length !== 2 || args[0] !== "--state-root") {
    throw new Error(`service ${command} accepts only --state-root`);
  }
  const value = args[1];
  if (value === undefined || value.startsWith("--")) throw new Error("--state-root requires a value");
  stateRoot = value;
  return { command, stateRoot };
}

function parsePort(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error("--port requires an integer in the range 1..65535");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port requires an integer in the range 1..65535");
  }
  return port;
}

function isServiceCommand(value: string): value is ServiceCommand {
  return value === "install" ||
    value === "start" ||
    value === "stop" ||
    value === "restart" ||
    value === "status" ||
    value === "uninstall" ||
    value === "run";
}
