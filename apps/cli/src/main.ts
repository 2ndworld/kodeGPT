import { homedir } from "node:os";
import { join } from "node:path";

import { ConnectorCredentialStore } from "@kodegpt/auth";

import { runAuthCommand } from "./commands/auth.js";
import { formatKodegptStartStatus, runStartCommand } from "./commands/start.js";
import { resolveRuntimePath, RUNTIME_PACKAGE_LINUX_X64 } from "./runtime-resolver.js";

async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "doctor":
      await doctor(rest);
      return;
    case "auth":
      await auth(rest);
      return;
    case "start":
      await start(rest);
      return;
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(helpText());
      return;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

async function doctor(args: string[]): Promise<void> {
  const json = args.length === 1 && args[0] === "--json";
  if (args.length !== 0 && !json) {
    throw new Error("doctor accepts only --json");
  }
  await resolveRuntimePath();
  const result = {
    ok: true,
    platform: process.platform,
    arch: process.arch,
    runtimePackage: RUNTIME_PACKAGE_LINUX_X64,
    runtimeExecutable: true
  };
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : "KodeGPT doctor: ok\n");
}

async function auth(args: string[]): Promise<void> {
  const { stateRoot, remaining } = extractStateRoot(args);
  const store = new ConnectorCredentialStore(stateRoot);
  const output = await runAuthCommand(remaining, { store });
  process.stdout.write(`${output}\n`);
}

async function start(args: string[]): Promise<void> {
  if (args.includes("--runtime") && process.env.NODE_ENV !== "test" && process.env.NODE_ENV !== "development") {
    throw new Error("--runtime is available only in development and tests");
  }
  const runtimePath = await resolveRuntimePath();
  const startArgs = args.includes("--runtime") ? args : [...args, "--runtime", runtimePath];
  const started = await runStartCommand(startArgs);
  process.stdout.write(`${formatKodegptStartStatus(started.status)}\n`);
  await waitForShutdown(started.close);
}

function extractStateRoot(args: string[]): { stateRoot: string; remaining: string[] } {
  let stateRoot = join(homedir(), ".kodegpt");
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--state-root") {
      if (arg !== undefined) remaining.push(arg);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--state-root requires a value");
    }
    stateRoot = value;
    index += 1;
  }
  return { stateRoot, remaining };
}

async function waitForShutdown(close: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      void close().then(resolve, reject);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function helpText(): string {
  return [
    "KodeGPT v0.1",
    "  kodegpt doctor [--json]",
    "  kodegpt auth status|rotate [--state-root <path>]",
    "  kodegpt start [--state-root <path>] [--port <port>] [--public-url <https-url>]",
    ""
  ].join("\n");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write(`kodegpt: ${message}\n`);
  process.exitCode = 1;
});
