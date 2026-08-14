import { rm } from "node:fs/promises";
import { join } from "node:path";

import { ServiceMetadataStore, type ServiceReleaseRecord } from "../service/metadata.js";
import {
  removeUserUnit,
  renderKodegptUserUnit,
  writeUserUnitAtomic,
  type SystemdUserManager
} from "../service/systemd.js";
import { DEFAULT_MCP_PORT } from "./start.js";
import { validateZrokReservedNameSelection } from "./expose-zrok.js";

export type ServiceCommand = "install" | "start" | "stop" | "restart" | "status" | "uninstall";

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

export type ParsedServiceArguments =
  | ServiceInstallOptions
  | ServiceSimpleOptions
  | ServiceStatusOptions;

export interface ServiceOperatorDependencies {
  metadataStore: ServiceMetadataStore;
  manager: SystemdUserManager;
  serviceDataRoot: string;
  unitPath: string;
  prepareRelease(options: ServiceInstallOptions): Promise<ServiceReleaseRecord>;
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
  await dependencies.metadataStore.delete();
  return "KodeGPT service uninstalled";
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
    value === "uninstall";
}
