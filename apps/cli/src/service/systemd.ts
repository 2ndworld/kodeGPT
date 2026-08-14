import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import type { ServiceReleaseRecord } from "./metadata.js";

const UNIT_NAME = "kodegpt.service" as const;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

export interface UserServiceState {
  loadState: string;
  activeState: string;
  subState: string;
  unitFileState: string;
  mainPid?: number;
  result?: string;
}

export interface SystemdUserManager {
  daemonReload(): Promise<void>;
  enable(): Promise<void>;
  disable(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  resetFailed(): Promise<void>;
  show(): Promise<UserServiceState>;
  linger(): Promise<"enabled" | "disabled" | "unknown">;
}

export interface ServiceCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ServiceCommandRunner = (
  executable: string,
  argv: string[]
) => Promise<ServiceCommandResult>;

export function renderKodegptUserUnit(record: ServiceReleaseRecord, stateRoot: string): string {
  const execArgs = [
    record.nodePath,
    record.cliPath,
    "service",
    "run",
    "--state-root",
    stateRoot,
    "--release-id",
    record.releaseId,
    "--name",
    record.reservedName,
    "--port",
    String(record.port)
  ];
  const pathEntries = [dirname(record.nodePath), dirname(record.zrokPath), "/usr/local/bin", "/usr/bin", "/bin"];
  const pathValue = [...new Set(pathEntries)].join(":");

  return [
    "[Unit]",
    "Description=KodeGPT managed local service",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execArgs.map(systemdQuote).join(" ")}`,
    `WorkingDirectory=${systemdQuote(record.releaseRoot)}`,
    `Environment=${systemdQuote("NODE_ENV=production")}`,
    `Environment=${systemdQuote(`PATH=${pathValue}`)}`,
    "Restart=on-failure",
    "RestartSec=5s",
    "KillSignal=SIGTERM",
    "KillMode=control-group",
    "TimeoutStopSec=10s",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
}

export async function writeUserUnitAtomic(unitPath: string, content: string): Promise<void> {
  await mkdir(dirname(unitPath), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(unitPath), `.kodegpt.service.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, unitPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function removeUserUnit(unitPath: string): Promise<void> {
  await rm(unitPath, { force: true });
}

export function createSystemdUserManager(options: {
  systemctlPath: string;
  loginctlPath: string;
  userName: string;
  runner?: ServiceCommandRunner;
}): SystemdUserManager {
  const runner = options.runner ?? runServiceManagerCommand;
  const systemctl = async (args: string[], allowFailure = false): Promise<ServiceCommandResult> => {
    const result = await runner(options.systemctlPath, ["--user", ...args]);
    if (!allowFailure && result.exitCode !== 0) {
      throw commandFailure("systemctl", result);
    }
    return result;
  };

  return {
    async daemonReload() {
      await systemctl(["daemon-reload"]);
    },
    async enable() {
      await systemctl(["enable", UNIT_NAME]);
    },
    async disable() {
      await systemctl(["disable", UNIT_NAME], true);
    },
    async start() {
      await systemctl(["start", UNIT_NAME]);
    },
    async stop() {
      await systemctl(["stop", UNIT_NAME], true);
    },
    async restart() {
      await systemctl(["restart", UNIT_NAME]);
    },
    async resetFailed() {
      await systemctl(["reset-failed", UNIT_NAME], true);
    },
    async show() {
      const result = await systemctl(
        [
          "show",
          UNIT_NAME,
          "--property=LoadState",
          "--property=ActiveState",
          "--property=SubState",
          "--property=UnitFileState",
          "--property=MainPID",
          "--property=Result",
          "--no-pager"
        ],
        true
      );
      if (result.exitCode !== 0 && result.stdout.trim().length === 0) {
        return {
          loadState: "not-found",
          activeState: "inactive",
          subState: "dead",
          unitFileState: "disabled"
        };
      }
      return parseSystemdShow(result.stdout);
    },
    async linger() {
      try {
        const result = await runner(options.loginctlPath, [
          "show-user",
          options.userName,
          "-p",
          "Linger",
          "--value"
        ]);
        if (result.exitCode !== 0) return "unknown";
        const value = result.stdout.trim().toLowerCase();
        if (value === "yes") return "enabled";
        if (value === "no") return "disabled";
        return "unknown";
      } catch {
        return "unknown";
      }
    }
  };
}

export async function resolveExecutableOnPath(name: string, pathValue = process.env.PATH ?? ""): Promise<string> {
  if (name.includes("/")) throw new Error("executable name must not contain a path separator");
  for (const entry of pathValue.split(delimiter)) {
    if (entry.length === 0) continue;
    const candidate = join(entry, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch (error) {
      if (["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
  }
  throw new Error(`required executable not found on PATH: ${name}`);
}

export async function runServiceManagerCommand(
  executable: string,
  argv: string[]
): Promise<ServiceCommandResult> {
  return await new Promise<ServiceCommandResult>((resolve, reject) => {
    const child = spawn(executable, argv, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: serviceManagerEnvironment(process.env)
    });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: Buffer): string =>
      (current + chunk.toString("utf8")).slice(0, MAX_COMMAND_OUTPUT_BYTES);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`service manager command terminated by signal ${signal}`));
        return;
      }
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function parseSystemdShow(stdout: string): UserServiceState {
  const fields = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    fields.set(line.slice(0, index), line.slice(index + 1));
  }
  const mainPidValue = Number(fields.get("MainPID"));
  const mainPid = Number.isSafeInteger(mainPidValue) && mainPidValue > 0 ? mainPidValue : undefined;
  const result = fields.get("Result");
  return {
    loadState: fields.get("LoadState") ?? "unknown",
    activeState: fields.get("ActiveState") ?? "unknown",
    subState: fields.get("SubState") ?? "unknown",
    unitFileState: fields.get("UnitFileState") ?? "unknown",
    ...(mainPid === undefined ? {} : { mainPid }),
    ...(result === undefined || result.length === 0 ? {} : { result })
  };
}

function systemdQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("unsafe systemd unit argument");
  const escaped = value
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  return `"${escaped}"`;
}

function commandFailure(command: string, result: ServiceCommandResult): Error {
  const detail = result.stderr.trim().slice(0, 500);
  return new Error(
    detail.length === 0
      ? `${command} failed with exit code ${result.exitCode}`
      : `${command} failed with exit code ${result.exitCode}: ${detail}`
  );
}

function serviceManagerEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of ["HOME", "PATH", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "USER", "LOGNAME"] as const) {
    const value = environment[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}
