import { WorkspaceInspectInputSchema, WorkspaceInspectResultSchema } from "@kodegpt/capabilities";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  ConsoleStateStore,
  DEV_CONSOLE_RESOURCE_URI
} from "@kodegpt/dev-console";
import { z } from "zod";

import {
  MUTATING_FILE_TOOL_ANNOTATIONS,
  PROCESS_CANCEL_TOOL_ANNOTATIONS,
  PROCESS_RUN_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
  WORKSPACE_LIFECYCLE_TOOL_ANNOTATIONS
} from "./annotations.js";
import type { KodegptToolContext } from "./tool-context.js";

const SURFACE_TOOLS = Object.freeze([
  { name: "artifact.read", required: ["uri"] },
  { name: "console.state", required: [] },
  { name: "extension.list", required: [] },
  {
    name: "file.edit",
    required: ["workspaceId", "path", "oldText", "newText", "expectedReplacements"]
  },
  { name: "file.read", required: ["workspaceId", "path"] },
  { name: "file.search", required: ["workspaceId", "query"] },
  { name: "file.tree", required: ["workspaceId"] },
  { name: "file.write", required: ["workspaceId", "path", "content"] },
  { name: "git.diff", required: ["workspaceId"] },
  { name: "git.status", required: ["workspaceId"] },
  { name: "process.cancel", required: ["workspaceId", "operationId"] },
  { name: "process.run", required: ["workspaceId", "logicalExecutable", "argv"] },
  { name: "process.status", required: ["workspaceId", "operationId"] },
  { name: "profile.current", required: ["workspaceId"] },
  { name: "profile.inspect", required: ["name"] },
  { name: "system.capabilities", required: [] },
  { name: "system.health", required: [] },
  { name: "workspace.close", required: ["workspaceId"] },
  { name: "workspace.info", required: ["workspaceId"] },
  { name: "workspace.inspect", required: ["workspaceId"] },
  { name: "workspace.list", required: [] },
  { name: "workspace.open", required: ["rootPath"] }
] as const);

export function listSurfaceTools(): Array<{ name: string; required: string[] }> {
  return SURFACE_TOOLS.map((tool) => ({
    name: tool.name,
    required: [...tool.required]
  }));
}

export function registerKodegptTools(
  server: McpServer,
  context: KodegptToolContext,
  consoleState = new ConsoleStateStore()
): void {
  server.registerTool(
    "console.state",
    {
      description: "Return the normalized KodeGPT Dev Console state without synchronously refreshing Git.",
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      _meta: { ui: { resourceUri: DEV_CONSOLE_RESOURCE_URI } }
    },
    async (requestContext) => {
      const [workspaces, health] = await Promise.all([
        context.workspace.list(),
        context.system.health()
      ]);
      const state = consoleState.snapshot({
        workspaces,
        health
      });
      const structuredContent = {
        ...state,
        host: { uiSupported: currentRequestSupportsUi(requestContext) }
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent
      };
    }
  );

  server.registerTool(
    "extension.list",
    {
      description: "List bounded enabled declarative extensions without exposing manifest host paths or contents.",
      inputSchema: {
        limit: z.number().int().positive().max(100).safe().optional()
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ limit }) => structuredToolResult(await context.extension.list({ limit }))
  );

  server.registerTool(
    "artifact.read",
    {
      description: "Read a bounded chunk from a KodeGPT artifact URI without exposing its host spool path.",
      inputSchema: {
        uri: z.string().regex(/^artifact:\/\/ka_[A-Za-z0-9_-]{1,93}$/),
        offset: z.number().int().nonnegative().safe().optional(),
        maxBytes: z.number().int().positive().max(1024 * 1024).safe().optional()
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ uri, offset, maxBytes }) =>
      structuredToolResult(await context.artifact.read({ uri, offset, maxBytes }))
  );

  server.registerTool(
    "workspace.list",
    {
      description: "List workspaces currently known to this KodeGPT process.",
      inputSchema: {},
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async () => structuredToolResult(await context.workspace.list())
  );

  server.registerTool(
    "workspace.open",
    {
      description: "Open a locally trusted workspace. This tool cannot establish workspace trust.",
      inputSchema: { rootPath: z.string().min(1) },
      annotations: WORKSPACE_LIFECYCLE_TOOL_ANNOTATIONS
    },
    async ({ rootPath }) => structuredToolResult(await context.workspace.open({ rootPath }))
  );

  server.registerTool(
    "workspace.close",
    {
      description: "Close a READY workspace and release its private runtime capability.",
      inputSchema: { workspaceId: z.string().min(1) },
      annotations: WORKSPACE_LIFECYCLE_TOOL_ANNOTATIONS
    },
    async ({ workspaceId }) => structuredToolResult(await context.workspace.close({ workspaceId }))
  );

  server.registerTool(
    "workspace.info",
    {
      description: "Inspect public information for a READY workspace.",
      inputSchema: { workspaceId: z.string().min(1) },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId }) => structuredToolResult(await context.workspace.info({ workspaceId }))
  );

  server.registerTool(
    "workspace.inspect",
    {
      description: "Build a bounded deterministic evidence-based map of a READY workspace.",
      inputSchema: WorkspaceInspectInputSchema,
      outputSchema: WorkspaceInspectResultSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, path, maxEntries }) =>
      structuredToolResult(
        WorkspaceInspectResultSchema.parse(
          await context.workspace.inspect({ workspaceId, path, maxEntries })
        )
      )
  );

  server.registerTool(
    "file.edit",
    {
      description:
        "Replace exact UTF-8 text beneath a READY writable workspace when the expected replacement count matches.",
      inputSchema: {
        workspaceId: z.string().min(1),
        path: z.string().min(1),
        oldText: z.string().min(1),
        newText: z.string(),
        expectedReplacements: z.number().int().nonnegative().safe()
      },
      annotations: MUTATING_FILE_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, path, oldText, newText, expectedReplacements }) =>
      structuredToolResult(
        await context.workspace.editFile({
          workspaceId,
          path,
          oldText,
          newText,
          expectedReplacements
        })
      )
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
      structuredToolResult(await context.workspace.readFile({ workspaceId, path, offset, maxBytes }))
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
      structuredToolResult(await context.workspace.search({ workspaceId, query, path }))
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
    async ({ workspaceId, path }) =>
      structuredToolResult(await context.workspace.tree({ workspaceId, path }))
  );

  server.registerTool(
    "file.write",
    {
      description: "Atomically create or replace UTF-8 file content beneath a READY writable workspace.",
      inputSchema: {
        workspaceId: z.string().min(1),
        path: z.string().min(1),
        content: z.string()
      },
      annotations: MUTATING_FILE_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, path, content }) =>
      structuredToolResult(await context.workspace.writeFile({ workspaceId, path, content }))
  );

  server.registerTool(
    "git.diff",
    {
      description: "Inspect the current workspace diff through hardened read-only Git.",
      inputSchema: { workspaceId: z.string().min(1) },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId }) => structuredToolResult(await context.git.diff({ workspaceId }))
  );

  server.registerTool(
    "git.status",
    {
      description: "Inspect the current workspace status through hardened read-only Git.",
      inputSchema: { workspaceId: z.string().min(1) },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId }) => {
      const value = await context.git.status({ workspaceId });
      consoleState.recordGitStatus(workspaceId, value);
      return structuredToolResult(value);
    }
  );

  server.registerTool(
    "process.run",
    {
      description: "Run a policy-approved logical executable in the retained-root sandbox without a shell.",
      inputSchema: {
        workspaceId: z.string().min(1),
        logicalExecutable: z.string().min(1),
        argv: z.array(z.string()),
        cwd: z.string().min(1).optional(),
        env: z.record(z.string(), z.string()).optional(),
        background: z.boolean().optional()
      },
      annotations: PROCESS_RUN_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, logicalExecutable, argv, cwd, env, background }) => {
      const value = await context.process.run({
        workspaceId,
        logicalExecutable,
        argv,
        cwd,
        env,
        background
      });
      consoleState.recordProcessOperation(value);
      return structuredToolResult(value);
    }
  );

  server.registerTool(
    "process.status",
    {
      description: "Inspect a process operation by its opaque operation ID.",
      inputSchema: {
        workspaceId: z.string().min(1),
        operationId: z.string().startsWith("op_")
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, operationId }) => {
      const value = await context.process.status({ workspaceId, operationId });
      consoleState.recordProcessOperation(value);
      return structuredToolResult(value);
    }
  );

  server.registerTool(
    "process.cancel",
    {
      description: "Cancel a process operation tree by its opaque operation ID.",
      inputSchema: {
        workspaceId: z.string().min(1),
        operationId: z.string().startsWith("op_")
      },
      annotations: PROCESS_CANCEL_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, operationId }) => {
      const value = await context.process.cancel({ workspaceId, operationId });
      consoleState.recordProcessOperation(value);
      return structuredToolResult(value);
    }
  );

  server.registerTool(
    "profile.current",
    {
      description: "Return the effective monotonic policy for a READY workspace.",
      inputSchema: { workspaceId: z.string().min(1) },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId }) => structuredToolResult(await context.profile.current({ workspaceId }))
  );

  server.registerTool(
    "profile.inspect",
    {
      description: "Inspect a built-in KodeGPT profile preset without changing workspace policy.",
      inputSchema: { name: z.enum(["observe", "develop", "trusted"]) },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ name }) => structuredToolResult(await context.profile.inspect({ name }))
  );

  server.registerTool(
    "system.capabilities",
    {
      description: "Report KodeGPT capability availability without mutating host state.",
      inputSchema: {},
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async () => structuredToolResult(await context.system.capabilities())
  );

  server.registerTool(
    "system.health",
    {
      description: "Report KodeGPT process health without mutating host state.",
      inputSchema: {},
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async () => structuredToolResult(await context.system.health())
  );
}

export function structuredToolResult<T>(value: T) {
  const structuredContent = value ?? null;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent)
      }
    ],
    structuredContent
  };
}

function currentRequestSupportsUi(requestContext: unknown): boolean {
  if (!isRecord(requestContext) || !isRecord(requestContext.mcpReq)) return false;
  const envelope = requestContext.mcpReq.envelope;
  if (!isRecord(envelope)) return false;
  const clientCapabilities = envelope["io.modelcontextprotocol/clientCapabilities"];
  if (!isRecord(clientCapabilities)) return false;
  const extensions = clientCapabilities.extensions;
  if (!isRecord(extensions)) return false;
  const ui = extensions["io.modelcontextprotocol/ui"];
  return isRecord(ui) && Array.isArray(ui.mimeTypes) && ui.mimeTypes.includes("text/html;profile=mcp-app");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
