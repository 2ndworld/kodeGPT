import { McpServer } from "@modelcontextprotocol/server";
import {
  DEV_CONSOLE_CURRENT_RESOURCE_URI,
  DEV_CONSOLE_MIME_TYPE,
  DEV_CONSOLE_RESOURCE_URI,
  devConsoleResourceContent
} from "@kodegpt/dev-console";

import type { KodegptToolContext } from "./tool-context.js";
import { listSurfaceTools, registerKodegptTools } from "./tools.js";

export const KODEGPT_MCP_SERVER_INFO = Object.freeze({
  name: "KodeGPT",
  version: "0.1.0"
});

export { listSurfaceTools };

export function createKodegptMcpServer(context: KodegptToolContext): McpServer {
  const server = new McpServer(KODEGPT_MCP_SERVER_INFO, {
    capabilities: {
      extensions: {
        "io.modelcontextprotocol/ui": {
          mimeTypes: [DEV_CONSOLE_MIME_TYPE]
        }
      }
    }
  });
  registerKodegptTools(server, context);
  registerDevConsoleResource(server, "kodegpt-dev-console-v1", DEV_CONSOLE_RESOURCE_URI);
  registerDevConsoleResource(server, "kodegpt-dev-console-current", DEV_CONSOLE_CURRENT_RESOURCE_URI);
  return server;
}

function registerDevConsoleResource(
  server: McpServer,
  name: string,
  uri: typeof DEV_CONSOLE_RESOURCE_URI | typeof DEV_CONSOLE_CURRENT_RESOURCE_URI
): void {
  server.registerResource(
    name,
    uri,
    {
      title: "KodeGPT Dev Console",
      description: "Self-contained MCP Apps view for current KodeGPT workspace state.",
      mimeType: DEV_CONSOLE_MIME_TYPE
    },
    async () => ({ contents: [devConsoleResourceContent(uri)] })
  );
}
