import type { Readable, Writable } from "node:stream";

import { serveKodegptStdio, type KodegptStdioHandle } from "@kodegpt/mcp-server";

import { resolveRuntimePath } from "../runtime-resolver.js";
import {
  createProductionServiceStack,
  defaultStartDependencies,
  type ProductionServiceStackDependencies,
  type ProductionServiceStackOptions
} from "./start.js";

export interface BridgeKodegptOptions extends ProductionServiceStackOptions {
  streams?: { stdin: Readable; stdout: Writable };
}

export interface BridgedKodegpt {
  close(): Promise<void>;
}

export async function runBridgeCommand(
  args: string[],
  dependencies?: ProductionServiceStackDependencies
): Promise<BridgedKodegpt> {
  const options = parseBridgeArguments(args);
  return bridgeKodegpt(options, dependencies);
}

export async function bridgeKodegpt(
  options: BridgeKodegptOptions,
  dependencies?: ProductionServiceStackDependencies
): Promise<BridgedKodegpt> {
  const effectiveDeps: ProductionServiceStackDependencies = {
    ...defaultStartDependencies,
    prepareConnectorAuth: async () => undefined as any,
    ...dependencies
  };
  const stack = await createProductionServiceStack(options, effectiveDeps);
  let handle: KodegptStdioHandle | undefined;
  try {
    handle = serveKodegptStdio(stack.toolContext, options.streams);
    let closed = false;
    return {
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await handle?.close();
        await stack.close();
      }
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await stack.close().catch(() => undefined);
    throw error;
  }
}

export function parseBridgeArguments(args: string[]): BridgeKodegptOptions {
  let runtimePath: string | undefined;
  let stateRoot: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !flag.startsWith("--")) {
      throw new Error("bridge accepts only named options");
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
      case "--state-root":
        if (stateRoot !== undefined) throw new Error("--state-root may be specified only once");
        stateRoot = value;
        break;
      default:
        throw new Error(`Unknown bridge option: ${flag}`);
    }
  }

  if (runtimePath === undefined || runtimePath.length === 0) {
    throw new Error("bridge requires --runtime <path>");
  }

  return {
    runtimePath,
    ...(stateRoot === undefined ? {} : { stateRoot })
  };
}
