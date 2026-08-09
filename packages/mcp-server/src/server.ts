import { McpServer } from "@modelcontextprotocol/server";

import type { KodegptToolContext } from "./tool-context.js";
import { listSurfaceTools, registerKodegptTools } from "./tools.js";

export const KODEGPT_MCP_SERVER_INFO = Object.freeze({
  name: "KodeGPT",
  version: "0.1.0"
});

export { listSurfaceTools };

export function createKodegptMcpServer(context: KodegptToolContext): McpServer {
  const server = new McpServer(KODEGPT_MCP_SERVER_INFO);
  registerKodegptTools(server, context);
  return server;
}
