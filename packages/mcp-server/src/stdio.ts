import type { Readable, Writable } from "node:stream";

import { ConsoleStateStore } from "@kodegpt/dev-console";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";

import { createKodegptMcpServer } from "./server.js";
import type { KodegptToolContext } from "./tool-context.js";

export interface KodegptStdioHandle {
  close(): Promise<void>;
}

export function serveKodegptStdio(
  toolContext: KodegptToolContext,
  streams?: { stdin: Readable; stdout: Writable }
): KodegptStdioHandle {
  const transport =
    streams === undefined
      ? new StdioServerTransport()
      : new StdioServerTransport(streams.stdin, streams.stdout);
  const consoleState = new ConsoleStateStore();

  return serveStdio(
    () => createKodegptMcpServer(toolContext, consoleState),
    {
      legacy: "reject",
      transport
    }
  );
}
