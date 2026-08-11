import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import type { OpenWorkspace } from "../../core/src/index.js";
import type { KodegptToolContext, WorkspaceToolContext } from "./tool-context.js";
import { registerKodegptTools } from "./tools.js";

type CapturedHandler = (...args: never[]) => Promise<unknown>;

const typedWorkspaceListResult: OpenWorkspace[] = [
  {
    id: "ws_1",
    canonicalRoot: "/workspace",
    effectivePolicy: {
      profile: "observe",
      writeAllowed: false,
      processAllowed: false,
      network: "deny",
      allowedExecutableNames: [],
      inheritEnv: false,
      envAllowlist: []
    }
  }
];

const typedWorkspaceListContext: Pick<WorkspaceToolContext, "list"> = {
  list: async () => typedWorkspaceListResult
};
void typedWorkspaceListContext;

describe("structured MCP tool results", () => {
  it("keeps workspace.list structured content identical to its text fallback", async () => {
    const handlers = new Map<string, CapturedHandler>();
    const server = {
      registerTool(name: string, _definition: unknown, handler: CapturedHandler) {
        handlers.set(name, handler);
      }
    } as unknown as McpServer;

    const context = {
      workspace: {
        list: async () => typedWorkspaceListResult,
        open: async () => typedWorkspaceListResult[0],
        close: async () => ({ ok: true }),
        info: async () => typedWorkspaceListResult[0],
        readFile: async () => ({ contents: "", bytesRead: 0, eof: true }),
        writeFile: async () => ({ bytesWritten: 0, created: true }),
        editFile: async () => ({ bytesWritten: 0, replacements: 0 }),
        search: async () => [],
        tree: async () => []
      },
      git: {
        status: async () => ({}),
        diff: async () => ({})
      },
      process: {
        run: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({})
      },
      artifact: {
        read: async () => ({})
      },
      extension: {
        list: async () => []
      },
      profile: {
        current: async () => ({}),
        inspect: async () => ({})
      },
      system: {
        capabilities: async () => ({}),
        health: async () => ({ ok: true })
      }
    } as KodegptToolContext;

    registerKodegptTools(server, context);
    const handler = handlers.get("workspace.list");
    expect(handler).toBeDefined();

    const result = (await handler!()) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
    };

    expect(result.structuredContent).toEqual(typedWorkspaceListResult);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });
});
