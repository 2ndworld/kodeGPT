import { homedir } from "node:os";
import { join } from "node:path";

import type { ConnectorCredentialStatus, IssuedConnectorCredential } from "@kodegpt/auth";

import {
  DEFAULT_MCP_PORT,
  type KodegptStartStatus,
  type StartedKodegpt,
  type StartKodegptOptions
} from "./start.js";

const DEFAULT_STATE_ROOT = join(homedir(), ".kodegpt");
const ZROK_READINESS_ATTEMPTS = 120;
const ZROK_READINESS_POLL_MS = 250;
const QUERY_CREDENTIAL_PARAM = ["kodegpt", "token"].join("_");

export interface ExposeZrokOptions {
  runtimePath: string;
  name: string;
  stateRoot?: string;
  port?: number;
}

export interface ZrokReservedName {
  namespace: string;
  name: string;
  namespaceName: string;
  reserved: true;
}

export interface ExposureCredentialStore {
  status(): Promise<ConnectorCredentialStatus>;
  rotate(): Promise<IssuedConnectorCredential>;
}

export interface SpawnedZrokProcess {
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface ExposeZrokDependencies {
  createCredentialStore(stateRoot: string): ExposureCredentialStore;
  startKodegpt(options: StartKodegptOptions): Promise<StartedKodegpt>;
  runZrokJson(args: string[]): Promise<string>;
  spawnZrok(
    command: string,
    args: string[],
    options: { shell: false; stdio: "inherit" }
  ): SpawnedZrokProcess;
  delay(milliseconds: number): Promise<void>;
}

export interface ExposeZrokStatus {
  local: KodegptStartStatus;
  publicUrl: string;
  chatgptServerUrl?: string;
  credentialCreated: boolean;
}

export interface ExposedZrokKodegpt {
  status: ExposeZrokStatus;
  termination: Promise<never>;
  close(): Promise<void>;
}

export function parseExposeZrokArguments(args: string[]): ExposeZrokOptions {
  let runtimePath: string | undefined;
  let name: string | undefined;
  let stateRoot: string | undefined;
  let port: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !flag.startsWith("--")) throw new Error("expose zrok accepts only named options");
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    index += 1;
    switch (flag) {
      case "--runtime":
        if (runtimePath !== undefined) throw new Error("--runtime may be specified only once");
        runtimePath = value;
        break;
      case "--name":
        if (name !== undefined) throw new Error("--name may be specified only once");
        parseZrokNameSelection(value);
        name = value;
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
        throw new Error(`Unknown expose zrok option: ${flag}`);
    }
  }

  if (runtimePath === undefined || runtimePath.length === 0) throw new Error("expose zrok requires a runtime path");
  if (name === undefined || name.length === 0) throw new Error("expose zrok requires a reserved name selection");
  return {
    runtimePath,
    name,
    ...(stateRoot === undefined ? {} : { stateRoot }),
    ...(port === undefined ? {} : { port })
  };
}

function parseZrokNameSelection(value: string): { namespaceToken: string; name: string } {
  if (/[\s/@?#]/.test(value)) throw new Error("invalid zrok reserved name selection");
  const parts = value.split(":");
  if (parts.length !== 2) throw new Error("invalid zrok reserved name selection");
  const [namespaceToken, name] = parts;
  if (
    namespaceToken === undefined ||
    name === undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(namespaceToken) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
  ) {
    throw new Error("invalid zrok reserved name selection");
  }
  return { namespaceToken, name };
}

function parsePort(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error("--port requires an integer in the range 1..65535");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("--port requires an integer in the range 1..65535");
  return port;
}

function parseExternalJson(rawJson: string): unknown {
  return JSON.parse(rawJson);
}

function validateDnsHostname(value: string): string {
  const hostname = value.toLowerCase();
  if (hostname.length > 253 || !hostname.includes(".")) {
    throw new Error("zrok reserved name produced an invalid hostname");
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
    throw new Error("zrok reserved name produced an invalid hostname");
  }
  return hostname;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveZrokReservedName(selection: string, rawJson: string): ZrokReservedName {
  const parsedSelection = parseZrokNameSelection(selection);
  let parsed: unknown;
  try {
    parsed = parseExternalJson(rawJson);
  } catch {
    throw new Error("invalid zrok reserved-name metadata");
  }
  if (!Array.isArray(parsed)) throw new Error("invalid zrok reserved-name metadata");
  const matches = parsed.filter((entry): entry is Record<string, unknown> =>
    isRecord(entry) && entry.name === parsedSelection.name
  );
  if (matches.length !== 1) throw new Error("zrok reserved name was not resolved uniquely");
  const match = matches[0];
  if (
    match === undefined ||
    match.reserved !== true ||
    typeof match.namespaceName !== "string" ||
    match.namespaceName.length === 0
  ) {
    throw new Error("zrok reserved name is invalid");
  }
  validateDnsHostname(`${parsedSelection.name}.${match.namespaceName}`);
  return {
    namespace: parsedSelection.namespaceToken,
    name: parsedSelection.name,
    namespaceName: match.namespaceName,
    reserved: true
  };
}

function isReadyShare(rawJson: string, target: string, hostname: string): boolean {
  let parsed: unknown;
  try {
    parsed = parseExternalJson(rawJson);
  } catch {
    return false;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.shares)) return false;
  const matches = parsed.shares.filter((entry) => {
    if (!isRecord(entry)) return false;
    if (
      entry.target !== target ||
      entry.shareMode !== "public" ||
      entry.backendMode !== "proxy" ||
      !Array.isArray(entry.frontendEndpoints)
    ) {
      return false;
    }
    return entry.frontendEndpoints.some((endpoint) => endpoint === hostname);
  });
  return matches.length === 1;
}

export async function runExposeZrokCommand(
  args: string[],
  dependencies: ExposeZrokDependencies
): Promise<ExposedZrokKodegpt> {
  return exposeZrok(parseExposeZrokArguments(args), dependencies);
}

export async function exposeZrok(
  options: ExposeZrokOptions,
  dependencies: ExposeZrokDependencies
): Promise<ExposedZrokKodegpt> {
  const stateRoot = options.stateRoot ?? DEFAULT_STATE_ROOT;
  const port = options.port ?? DEFAULT_MCP_PORT;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port requires an integer in the range 1..65535");
  }
  if (options.runtimePath.length === 0) throw new Error("expose zrok requires a runtime path");

  const selection = parseZrokNameSelection(options.name);
  const namesRaw = await dependencies.runZrokJson([
    "list", "names", "-n", selection.namespaceToken, "--json"
  ]);
  const reserved = resolveZrokReservedName(options.name, namesRaw);
  const hostname = validateDnsHostname(`${reserved.name}.${reserved.namespaceName}`);
  const publicUrl = `https://${hostname}/mcp`;
  const target = `http://127.0.0.1:${port}`;

  const store = dependencies.createCredentialStore(stateRoot);
  const credentialStatus = await store.status();
  const started = await dependencies.startKodegpt({
    runtimePath: options.runtimePath,
    stateRoot,
    port,
    publicUrl,
    queryCredentialCompatibility: true,
    allowMissingConnectorCredential: !credentialStatus.configured
  });

  let child: SpawnedZrokProcess;
  try {
    child = dependencies.spawnZrok(
      "zrok2",
      [
        "share", "public", target,
        "--headless",
        "--force-local",
        "--backend-mode", "proxy",
        "-n", options.name
      ],
      { shell: false, stdio: "inherit" }
    );
  } catch {
    await started.close().catch(() => undefined);
    throw new Error("zrok failed to start");
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

  let childFailure: Error | undefined;
  let rejectTermination!: (reason: unknown) => void;
  const termination = new Promise<never>((_resolve, reject) => {
    rejectTermination = reject;
  });
  const failExposure = (error: Error) => {
    if (closing) return;
    childFailure = error;
    void close().then(
      () => rejectTermination(error),
      (closeError) => rejectTermination(closeError)
    );
  };
  child.once("error", () => failExposure(new Error("zrok process failed")));
  child.once("exit", (code, signal) => {
    failExposure(new Error(
      `zrok exited unexpectedly (${code === null ? "no-exit-code" : `code=${code}`}${signal === null ? "" : ` signal=${signal}`})`
    ));
  });

  const readinessArgs = [
    "list", "shares",
    "--target", target,
    "--share-mode", "public",
    "--backend-mode", "proxy",
    "--json"
  ];
  let ready = false;
  for (let attempt = 0; attempt < ZROK_READINESS_ATTEMPTS; attempt += 1) {
    let raw: string | undefined;
    try {
      raw = await Promise.race([dependencies.runZrokJson(readinessArgs), termination]);
    } catch {
      if (childFailure !== undefined) throw childFailure;
    }
    if (raw !== undefined && isReadyShare(raw, target, hostname)) {
      ready = true;
      break;
    }
    if (attempt + 1 < ZROK_READINESS_ATTEMPTS) {
      try {
        await Promise.race([dependencies.delay(ZROK_READINESS_POLL_MS), termination]);
      } catch {
        if (childFailure !== undefined) throw childFailure;
      }
    }
  }

  if (!ready) {
    await close().catch(() => undefined);
    throw new Error("zrok readiness timed out");
  }

  let issued: IssuedConnectorCredential | undefined;
  if (!credentialStatus.configured) {
    try {
      issued = await store.rotate();
    } catch (error) {
      await close().catch(() => undefined);
      throw error;
    }
  }

  let chatgptServerUrl: string | undefined;
  if (issued !== undefined) {
    const onboardingUrl = new URL(publicUrl);
    onboardingUrl.searchParams.set(QUERY_CREDENTIAL_PARAM, issued["token"]);
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

export function formatExposeZrokStatus(status: ExposeZrokStatus): string {
  const lines = ["KodeGPT exposure ready", `Public MCP endpoint: ${status.publicUrl}`];
  if (status.chatgptServerUrl !== undefined) {
    lines.push(
      `ChatGPT Server URL: ${status.chatgptServerUrl}`,
      "Keep this URL private. The connector credential is shown only when newly issued."
    );
  } else {
    lines.push("An existing connector credential is active.");
  }
  return lines.join("\n");
}
