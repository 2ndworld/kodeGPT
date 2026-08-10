import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  ConnectorCredentialStore,
  type ConnectorCredentialStatus,
  type IssuedConnectorCredential
} from "@kodegpt/auth";

import {
  DEFAULT_MCP_PORT,
  startKodegpt,
  type KodegptStartStatus,
  type StartedKodegpt,
  type StartKodegptOptions
} from "./start.js";

const DEFAULT_STATE_ROOT = join(homedir(), ".kodegpt");
const NGROK_STARTUP_GRACE_MS = 1_000;

export interface ExposeNgrokOptions {
  runtimePath: string;
  hostname: string;
  stateRoot?: string;
  port?: number;
}

export interface ExposureCredentialStore {
  status(): Promise<ConnectorCredentialStatus>;
  rotate(): Promise<IssuedConnectorCredential>;
}

export interface SpawnedNgrokProcess {
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface ExposeNgrokDependencies {
  createCredentialStore(stateRoot: string): ExposureCredentialStore;
  startKodegpt(options: StartKodegptOptions): Promise<StartedKodegpt>;
  spawnNgrok(
    command: string,
    args: string[],
    options: { shell: false; stdio: "inherit" }
  ): SpawnedNgrokProcess;
  delay(milliseconds: number): Promise<void>;
}

export interface ExposeNgrokStatus {
  local: KodegptStartStatus;
  publicUrl: string;
  chatgptServerUrl?: string;
  credentialCreated: boolean;
}

export interface ExposedNgrokKodegpt {
  status: ExposeNgrokStatus;
  termination: Promise<never>;
  close(): Promise<void>;
}

const defaultExposeNgrokDependencies: ExposeNgrokDependencies = {
  createCredentialStore: (stateRoot) => new ConnectorCredentialStore(stateRoot),
  startKodegpt,
  spawnNgrok: (command, args, options) =>
    spawn(command, args, options) as unknown as SpawnedNgrokProcess,
  delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
};

export async function runExposeNgrokCommand(
  args: string[],
  dependencies: ExposeNgrokDependencies = defaultExposeNgrokDependencies
): Promise<ExposedNgrokKodegpt> {
  return exposeNgrok(parseExposeNgrokArguments(args), dependencies);
}

export async function exposeNgrok(
  options: ExposeNgrokOptions,
  dependencies: ExposeNgrokDependencies = defaultExposeNgrokDependencies
): Promise<ExposedNgrokKodegpt> {
  const stateRoot = options.stateRoot ?? DEFAULT_STATE_ROOT;
  const port = options.port ?? DEFAULT_MCP_PORT;
  validatePort(port);
  const hostname = validateHostname(options.hostname);
  if (options.runtimePath.length === 0) {
    throw new Error("expose ngrok requires --runtime <path>");
  }

  const credentialStore = dependencies.createCredentialStore(stateRoot);
  const credentialStatus = await credentialStore.status();
  const publicUrl = `https://${hostname}/mcp`;

  const started = await dependencies.startKodegpt({
    runtimePath: options.runtimePath,
    stateRoot,
    port,
    publicUrl,
    queryCredentialCompatibility: true,
    allowMissingConnectorCredential: !credentialStatus.configured
  });

  let child: SpawnedNgrokProcess;
  try {
    child = dependencies.spawnNgrok(
      "ngrok",
      ["http", `http://127.0.0.1:${port}`, "--url", `https://${hostname}`],
      { shell: false, stdio: "inherit" }
    );
  } catch (error) {
    await started.close().catch(() => undefined);
    throw error;
  }

  let closing = false;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closing = true;
    closePromise = (async () => {
      try {
        child.kill("SIGTERM");
      } finally {
        await started.close();
      }
    })();
    return closePromise;
  };

  let rejectTermination!: (reason: unknown) => void;
  const termination = new Promise<never>((_resolve, reject) => {
    rejectTermination = reject;
  });
  const failExposure = (error: Error) => {
    if (closing) return;
    void close().then(
      () => rejectTermination(error),
      (closeError) => rejectTermination(closeError)
    );
  };
  child.once("error", (error) => failExposure(new Error(`ngrok failed: ${error.message}`)));
  child.once("exit", (code, signal) => {
    failExposure(
      new Error(
        `ngrok exited unexpectedly (${code === null ? "no-exit-code" : `code=${code}`}${
          signal === null ? "" : ` signal=${signal}`
        })`
      )
    );
  });

  await Promise.race([dependencies.delay(NGROK_STARTUP_GRACE_MS), termination]);

  let issued: IssuedConnectorCredential | undefined;
  if (!credentialStatus.configured) {
    try {
      issued = await credentialStore.rotate();
    } catch (error) {
      await close().catch(() => undefined);
      throw error;
    }
  }

  let chatgptServerUrl: string | undefined;
  if (issued !== undefined) {
    const onboardingUrl = new URL(publicUrl);
    onboardingUrl.searchParams.set("kodegpt_token", issued.token);
    chatgptServerUrl = onboardingUrl.toString();
  }

  return {
    status: {
      local: started.status,
      publicUrl,
      ...(chatgptServerUrl === undefined ? {} : { chatgptServerUrl }),
      credentialCreated: issued !== undefined
    },
    termination,
    close
  };
}

export function formatExposeNgrokStatus(status: ExposeNgrokStatus): string {
  const lines = ["KodeGPT exposure ready", `Public MCP endpoint: ${status.publicUrl}`];
  if (status.chatgptServerUrl !== undefined) {
    lines.push(
      `ChatGPT Server URL: ${status.chatgptServerUrl}`,
      "Keep this URL private. The connector credential is shown only when newly issued."
    );
  } else {
    lines.push(
      "An existing connector credential is active.",
      "Use the Server URL already configured in ChatGPT, or run `kodegpt auth rotate` to issue a new credential."
    );
  }
  return lines.join("\n");
}

export function parseExposeNgrokArguments(args: string[]): ExposeNgrokOptions {
  let runtimePath: string | undefined;
  let hostname: string | undefined;
  let stateRoot: string | undefined;
  let port: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !flag.startsWith("--")) {
      throw new Error("expose ngrok accepts only named options");
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    index += 1;
    switch (flag) {
      case "--runtime":
        if (runtimePath !== undefined) throw new Error("--runtime may be specified only once");
        runtimePath = value;
        break;
      case "--hostname":
        if (hostname !== undefined) throw new Error("--hostname may be specified only once");
        hostname = value;
        break;
      case "--state-root":
        if (stateRoot !== undefined) throw new Error("--state-root may be specified only once");
        stateRoot = value;
        break;
      case "--port":
        if (port !== undefined) throw new Error("--port may be specified only once");
        port = parsePort(value);
        break;
      default:
        throw new Error(`Unknown expose ngrok option: ${flag}`);
    }
  }

  if (runtimePath === undefined || runtimePath.length === 0) {
    throw new Error("expose ngrok requires --runtime <path>");
  }
  if (hostname === undefined || hostname.length === 0) {
    throw new Error("expose ngrok requires --hostname <stable-hostname>");
  }

  return {
    runtimePath,
    hostname: validateHostname(hostname),
    ...(stateRoot === undefined ? {} : { stateRoot }),
    ...(port === undefined ? {} : { port })
  };
}

function validateHostname(value: string): string {
  const hostname = value.toLowerCase();
  if (hostname.length > 253 || !hostname.includes(".")) {
    throw new Error("--hostname requires a stable DNS hostname");
  }
  const labels = hostname.split(".");
  if (
    labels.some(
      (label) =>
        label.length < 1 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
    )
  ) {
    throw new Error("--hostname requires a stable DNS hostname");
  }
  return hostname;
}

function parsePort(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("--port requires an integer in the range 1..65535");
  }
  const port = Number(value);
  validatePort(port);
  return port;
}

function validatePort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port requires an integer in the range 1..65535");
  }
}
