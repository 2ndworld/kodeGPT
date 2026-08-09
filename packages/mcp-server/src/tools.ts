import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WORKSPACE_LIFECYCLE_TOOL_ANNOTATIONS
} from "./annotations.js";
import type { KodegptToolContext } from "./tool-context.js";

const SURFACE_TOOLS = Object.freeze([
  { name: "file.read", required: ["workspaceId", "path"] },
  { name: "file.search", required: ["workspaceId", "query"] },
  { name: "file.tree", required: ["workspaceId"] },
  { name: "profile.current", required: ["workspaceId"] },
  { name: "profile.inspect", required: ["name"] },
  { name: "system.capabilities", required: [] },
  { name: "system.health", required: [] },
  { name: "workspace.close", required: ["workspaceId"] },
  { name: "workspace.info", required: ["workspaceId"] },
  { name: "workspace.list", required: [] },
  { name: "workspace.open", required: ["rootPath"] }
] as const);

export function listSurfaceTools(): Array<{ name: string; required: string[] }> {
  return SURFACE_TOOLS.map((tool) => ({
    name: tool.name,
    required: [...tool.required]
  }));
}

export function registerKodegptTools(server: McpServer, context: KodegptToolContext): void {
  server.registerTool(
    "workspace.list",
    {
      description: "List workspaces currently known to this KodeGPT process.",
      inputSchema: {},
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async () => toolResult(await context.workspace.list())
  );

  server.registerTool(
    "workspace.open",
    {
      description: "Open a locally trusted workspace. This tool cannot establish workspace trust.",
      inputSchema: { rootPath: z.string().min(1) },
      annotations: WORKSPACE_LIFECYCLE_TOOL_ANNOTATIONS
    },
    async ({ rootPath }) => toolResult(await context.workspace.open({ rootPath }))
  );

  server.registerTool(
    "workspace.close",
    {
      description: "Close a READY workspace and release its private runtime capability.",
      inputSchema: { workspaceId: z.string().min(1) },
      annotations: WORKSPACE_LIFECYCLE_TOOL_ANNOTATIONS
    },
    async ({ workspaceId }) => toolResult(await context.workspace.close({ workspaceId }))
  );

  server.registerTool(
    "workspace.info",
    {
      description: "Inspect public information for a READY workspace.",
      inputSchema: { workspaceId: z.string().min(1) },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId }) => toolResult(await context.workspace.info({ workspaceId }))
  );

  server.registerTool(
    "file.read",
    {
      description: "Read bounded UTF-8 file content beneath a READY workspace retained root.",
      inputSchema: {
        workspaceId: z.string().min(1),
        path: z.string().min(1),
        offset: z.number().int().nonnegative().optional(),
        maxBytes: z.number().int().nonnegative().max(1024 * 1024).optional()
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, path, offset, maxBytes }) =>
      toolResult(await context.workspace.readFile({ workspaceId, path, offset, maxBytes }))
  );

  server.registerTool(
    "file.search",
    {
      description: "Run bounded lexical UTF-8 search beneath a READY workspace retained root.",
      inputSchema: {
        workspaceId: z.string().min(1),
        query: z.string().min(1),
        path: z.string().min(1).optional()
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, query, path }) =>
      toolResult(await context.workspace.search({ workspaceId, query, path }))
  );

  server.registerTool(
    "file.tree",
    {
      description: "List the deterministic bounded tree beneath a READY workspace retained root.",
      inputSchema: {
        workspaceId: z.string().min(1),
        path: z.string().min(1).optional()
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, path }) => toolResult(await context.workspace.tree({ workspaceId, path }))
  );

  server.registerTool(
    "profile.current",
    {
      description: "Return the effective monotonic policy for a READY workspace.",
      inputSchema: { workspaceId: z.string().min(1) },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId }) => toolResult(await context.profile.current({ workspaceId }))
  );

  server.registerTool(
    "profile.inspect",
    {
      description: "Inspect a built-in KodeGPT profile preset without changing workspace policy.",
      inputSchema: { name: z.enum(["observe", "develop", "trusted"]) },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ name }) => toolResult(await context.profile.inspect({ name }))
  );

  server.registerTool(
    "system.capabilities",
    {
      description: "Report KodeGPT capability availability without mutating host state.",
      inputSchema: {},
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async () => toolResult(await context.system.capabilities())
  );

  server.registerTool(
    "system.health",
    {
      description: "Report KodeGPT process health without mutating host state.",
      inputSchema: {},
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async () => toolResult(await context.system.health())
  );
}

function toolResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value ?? null)
      }
    ]
  };
}
