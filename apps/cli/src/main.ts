import { homedir } from "node:os";
import { join } from "node:path";

import { ConnectorCredentialStore } from "@kodegpt/auth";
import { KernelClient } from "@kodegpt/core";
import {
  createSkillSourceRuntimeAdapter,
  SkillCatalog,
  SkillPinStore,
  SkillSourceManager,
  SkillSourceStore
} from "@kodegpt/skills";
import { WorkspaceTrustStore } from "@kodegpt/trust";

import { runAuthCommand } from "./commands/auth.js";
import { runBridgeCommand } from "./commands/bridge.js";
import { formatExposeZrokStatus, runExposeZrokCommand } from "./commands/expose-zrok.js";
import { runSkillCommand, type SkillCommandDependencies } from "./commands/skill.js";
import { formatKodegptStartStatus, runStartCommand } from "./commands/start.js";
import { runWorkspaceCommand, type InspectedWorkspaceRoot } from "./commands/workspace.js";
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
    case "workspace":
      await workspace(rest);
      return;
    case "skill":
      await skill(rest);
      return;
    case "start":
      await start(rest);
      return;
    case "bridge":
      await bridge(rest);
      return;
    case "expose":
      await expose(rest);
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

async function workspace(args: string[]): Promise<void> {
  const { stateRoot, remaining } = extractStateRoot(args);
  const store = new WorkspaceTrustStore(stateRoot);
  const inspectRoot = async (path: string): Promise<InspectedWorkspaceRoot> => {
    const runtimePath = await resolveRuntimePath();
    const client = await KernelClient.start({ runtimePath, stateRoot });
    try {
      return await client.request<InspectedWorkspaceRoot>("system.inspect_root", { path });
    } finally {
      await client.stop();
    }
  };
  const output = await runWorkspaceCommand(remaining, { store, inspectRoot });
  process.stdout.write(`${output}\n`);
}

async function skill(args: string[]): Promise<void> {
  const { stateRoot, remaining } = extractStateRoot(args);
  const sourceStore = new SkillSourceStore(stateRoot);
  const pinStore = new SkillPinStore(stateRoot);
  const dependencies: SkillCommandDependencies = {
    sourceStore,
    pinStore,
    sourceManager: {
      addSource: (path, label) =>
        withSkillRuntime(stateRoot, sourceStore, (manager) => manager.addSource(path, label))
    },
    catalog: {
      pin: (input) =>
        withSkillRuntime(stateRoot, sourceStore, (manager) =>
          new SkillCatalog(manager, { pins: pinStore }).pin(input)
        )
    }
  };
  const output = await runSkillCommand(remaining, dependencies);
  process.stdout.write(`${output}\n`);
}

async function withSkillRuntime<T>(
  stateRoot: string,
  sourceStore: SkillSourceStore,
  operation: (manager: SkillSourceManager) => Promise<T>
): Promise<T> {
  const runtimePath = await resolveRuntimePath();
  const client = await KernelClient.start({ runtimePath, stateRoot });
  const manager = new SkillSourceManager(sourceStore, createSkillSourceRuntimeAdapter(client));
  try {
    return await operation(manager);
  } finally {
    try {
      await manager.close();
    } finally {
      await client.stop();
    }
  }
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
  process.exit(0);
}

async function bridge(args: string[]): Promise<void> {
  if (args.includes("--runtime") && process.env.NODE_ENV !== "test" && process.env.NODE_ENV !== "development") {
    throw new Error("--runtime is available only in development and tests");
  }
  const runtimePath = await resolveRuntimePath();
  const bridgeArgs = args.includes("--runtime") ? args : [...args, "--runtime", runtimePath];
  const bridged = await runBridgeCommand(bridgeArgs);
  await waitForShutdown(bridged.close, { listenStdin: true });
  process.exit(0);
}

async function expose(args: string[]): Promise<void> {
  const [provider, ...rest] = args;
  if (provider !== "zrok") {
    throw new Error("expose command requires provider: zrok");
  }
  if (rest.includes("--runtime") && process.env.NODE_ENV !== "test" && process.env.NODE_ENV !== "development") {
    throw new Error("--runtime is available only in development and tests");
  }
  const runtimePath = await resolveRuntimePath();
  const exposeArgs = rest.includes("--runtime") ? rest : [...rest, "--runtime", runtimePath];
  const exposed = await runExposeZrokCommand(exposeArgs);
  process.stdout.write(`${formatExposeZrokStatus(exposed.status)}\n`);
  await Promise.race([
    waitForShutdown(exposed.close),
    exposed.termination.finally(() => exposed.close())
  ]);
  process.exit(0);
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

async function waitForShutdown(
  close: () => Promise<void>,
  options?: { listenStdin?: boolean }
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      if (options?.listenStdin) {
        process.stdin.pause();
      }
      void close().then(resolve, reject);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    if (options?.listenStdin) {
      if (process.stdin.readableEnded) {
        shutdown();
      } else {
        process.stdin.resume();
        process.stdin.once("end", shutdown);
        process.stdin.once("close", shutdown);
        process.stdin.once("error", shutdown);
      }
    }
  });
}

function helpText(): string {
  return [
    "KodeGPT v0.1",
    "  kodegpt doctor [--json]",
    "  kodegpt auth status|rotate [--state-root <path>]",
    "  kodegpt workspace trust <path> [--ceiling observe|develop|trusted] [--state-root <path>]",
    "  kodegpt workspace untrust <trust-id> [--state-root <path>]",
    "  kodegpt workspace list [--state-root <path>]",
    "  kodegpt skill source list [--state-root <path>]",
    "  kodegpt skill source add <absolute-path> [--kind agent-skills] [--state-root <path>]",
    "  kodegpt skill source remove <source-id> [--state-root <path>]",
    "  kodegpt skill pin <skill-id> [--fingerprint <sha256>] [--state-root <path>]",
    "  kodegpt skill unpin <skill-id> [--fingerprint <sha256>] [--state-root <path>]",
    "  kodegpt start [--state-root <path>] [--port <port>] [--public-url <https-url>]",
    "  kodegpt bridge [--state-root <path>]",
    "  kodegpt expose zrok --name <namespace:name> [--port <port>] [--state-root <path>]",
    ""
  ].join("\n");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write(`kodegpt: ${message}\n`);
  process.exitCode = 1;
});
