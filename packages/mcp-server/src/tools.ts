import {
  CodeSearchInputSchema,
  CodeSearchResultSchema,
  ContextBuildInputSchema,
  ContextBuildResultSchema,
  FilePatchInputSchema,
  FilePatchResultSchema,
  GitChangesInputSchema,
  GitChangesResultSchema,
  GitLogInputSchema,
  GitLogResultSchema,
  GitShowInputSchema,
  GitShowResultSchema,
  GitRangeInputSchema,
  GitRangeResultSchema,
  GitDiffHistoryInputSchema,
  GitDiffHistoryResultSchema,
  VerifyListInputSchema,
  VerifyListResultSchema,
  VerifyRunInputSchema,
  VerifyRunResultSchema,
  WorkspaceInspectInputSchema,
  WorkspaceInspectResultSchema,
  toPublicCapabilityError
} from "@kodegpt/capabilities";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  SKILL_TOOL_LIST_MAX,
  SKILL_TOOL_LOAD_MAX_BYTES,
  SKILL_TOOL_LOAD_RESOURCE_MAX
} from "@kodegpt/skills/contracts";
import { SkillError } from "@kodegpt/skills/errors";
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
  { name: "code.search", required: ["workspaceId", "query"] },
  { name: "console.state", required: [] },
  { name: "context.build", required: ["workspaceId", "intent"] },
  { name: "extension.list", required: [] },
  {
    name: "file.edit",
    required: ["workspaceId", "path", "oldText", "newText", "expectedReplacements"]
  },
  { name: "file.read", required: ["workspaceId", "path"] },
  { name: "file.patch", required: ["workspaceId", "patch"] },
  { name: "file.search", required: ["workspaceId", "query"] },
  { name: "file.tree", required: ["workspaceId"] },
  { name: "file.write", required: ["workspaceId", "path", "content"] },
  { name: "git.changes", required: ["workspaceId"] },
  { name: "git.diff", required: ["workspaceId"] },
  { name: "git.diffHistory", required: ["workspaceId", "baseRevision", "headRevision"] },
  { name: "git.log", required: ["workspaceId"] },
  { name: "git.range", required: ["workspaceId", "baseRevision", "headRevision"] },
  { name: "git.show", required: ["workspaceId"] },
  { name: "git.status", required: ["workspaceId"] },
  { name: "process.cancel", required: ["workspaceId", "operationId"] },
  { name: "process.run", required: ["workspaceId", "logicalExecutable", "argv"] },
  { name: "process.status", required: ["workspaceId", "operationId"] },
  { name: "profile.current", required: ["workspaceId"] },
  { name: "profile.inspect", required: ["name"] },
  { name: "skill.list", required: [] },
  { name: "skill.inspect", required: ["skillId"] },
  { name: "skill.load", required: ["skillId"] },
  { name: "system.capabilities", required: [] },
  { name: "system.health", required: [] },
  { name: "trust.list", required: [] },
  { name: "verify.list", required: ["workspaceId"] },
  { name: "verify.run", required: ["workspaceId", "recipeId"] },
  { name: "workspace.close", required: ["workspaceId"] },
  { name: "workspace.info", required: ["workspaceId"] },
  { name: "workspace.inspect", required: ["workspaceId"] },
  { name: "workspace.list", required: [] },
  { name: "workspace.open", required: ["rootPath"] },
  { name: "workspace.trust", required: ["rootPath"] },
  { name: "workspace.untrust", required: ["trustId"] }
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
    "trust.list",
    {
      description: "List durable trusted workspace records without exposing filesystem identity.",
      inputSchema: {},
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async () => structuredToolResult(await context.trust.list())
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
    "workspace.trust",
    {
      description: "Trust a local workspace path using locally derived persistent filesystem identity.",
      inputSchema: {
        rootPath: z.string().min(1),
        profile: z.enum(["observe", "develop", "trusted"]).optional()
      },
      annotations: WORKSPACE_LIFECYCLE_TOOL_ANNOTATIONS
    },
    async ({ rootPath, profile }) =>
      structuredToolResult(await context.workspace.trust({ rootPath, profile }))
  );

  server.registerTool(
    "workspace.untrust",
    {
      description: "Remove durable workspace trust and revoke active workspace authority when open.",
      inputSchema: { trustId: z.string().min(1) },
      annotations: WORKSPACE_LIFECYCLE_TOOL_ANNOTATIONS
    },
    async ({ trustId }) => structuredToolResult(await context.workspace.untrust({ trustId }))
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
      nativeCapabilityResult(async () =>
        WorkspaceInspectResultSchema.parse(
          await context.workspace.inspect({ workspaceId, path, maxEntries })
        )
      )
  );

  server.registerTool(
    "code.search",
    {
      description: "Run bounded structured text, path, symbol, definition, or reference search.",
      inputSchema: CodeSearchInputSchema,
      outputSchema: CodeSearchResultSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, query, mode, path, maxResults }) =>
      nativeCapabilityResult(async () =>
        CodeSearchResultSchema.parse(
          await context.code.search({ workspaceId, query, mode, path, maxResults })
        )
      )
  );

  server.registerTool(
    "context.build",
    {
      description: "Build a deterministic bounded context bundle from existing workspace capabilities.",
      inputSchema: ContextBuildInputSchema,
      outputSchema: ContextBuildResultSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, intent, target, maxBytes }) =>
      nativeCapabilityResult(async () =>
        ContextBuildResultSchema.parse(
          await context.context.build({ workspaceId, intent, target, maxBytes })
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
    "file.patch",
    {
      description:
        "Check or apply a bounded unified text patch with full preflight and conditional per-file commits.",
      inputSchema: FilePatchInputSchema,
      outputSchema: FilePatchResultSchema,
      annotations: MUTATING_FILE_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, patch, mode }) =>
      nativeCapabilityResult(async () =>
        FilePatchResultSchema.parse(await context.file.patch({ workspaceId, patch, mode }))
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
    "git.changes",
    {
      description: "Return a compact deterministic checkpoint of normalized Git changes.",
      inputSchema: GitChangesInputSchema,
      outputSchema: GitChangesResultSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, includePatch }) =>
      nativeCapabilityResult(async () =>
        GitChangesResultSchema.parse(await context.git.changes({ workspaceId, includePatch }))
      )
  );

  server.registerTool(
    "git.log",
    {
      description: "List a bounded structured local Git commit history for a READY workspace.",
      inputSchema: GitLogInputSchema,
      outputSchema: GitLogResultSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => GitLogResultSchema.parse(await context.git.log(input)))
  );

  server.registerTool(
    "git.show",
    {
      description: "Inspect one bounded historical Git commit for a READY workspace.",
      inputSchema: GitShowInputSchema,
      outputSchema: GitShowResultSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => GitShowResultSchema.parse(await context.git.show(input)))
  );

  server.registerTool(
    "git.range",
    {
      description: "Inspect bounded ancestry and commit ranges between two structured Git revisions.",
      inputSchema: GitRangeInputSchema,
      outputSchema: GitRangeResultSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => GitRangeResultSchema.parse(await context.git.range(input)))
  );

  server.registerTool(
    "git.diffHistory",
    {
      description: "Inspect a bounded historical diff between two structured Git revisions.",
      inputSchema: GitDiffHistoryInputSchema,
      outputSchema: GitDiffHistoryResultSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () =>
        GitDiffHistoryResultSchema.parse(await context.git.diffHistory(input))
      )
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
    "verify.list",
    {
      description: "List safe verification recipes discovered from workspace manifests and current policy.",
      inputSchema: VerifyListInputSchema,
      outputSchema: VerifyListResultSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId }) =>
      nativeCapabilityResult(async () =>
        VerifyListResultSchema.parse(await context.verify.list({ workspaceId }))
      )
  );

  server.registerTool(
    "verify.run",
    {
      description: "Run a currently allowed verification recipe through the retained-root process sandbox.",
      inputSchema: VerifyRunInputSchema,
      outputSchema: VerifyRunResultSchema,
      annotations: PROCESS_RUN_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, recipeId, background }) =>
      nativeCapabilityResult(async () => {
        const value = VerifyRunResultSchema.parse(
          await context.verify.run({ workspaceId, recipeId, background })
        );
        consoleState.recordProcessOperation(value.operation);
        return value;
      })
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
    "skill.list",
    {
      description: "List bounded live and pinned skill metadata without exposing host source paths.",
      inputSchema: {
        limit: z.number().int().positive().max(SKILL_TOOL_LIST_MAX).safe().optional(),
        sourceId: z.string().regex(/^ss_[a-f0-9]{32}$/).optional(),
        compatibility: z.enum(["NATIVE", "PARTIAL", "PROVIDER_REQUIRED", "UNSUPPORTED"]).optional(),
        pinned: z.boolean().optional()
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ limit, sourceId, compatibility, pinned }) =>
      skillToolResult(() => context.skill.list({ limit, sourceId, compatibility, pinned }))
  );

  server.registerTool(
    "skill.inspect",
    {
      description: "Inspect bounded skill metadata, compatibility, resource inventory, and an advisory plan for relevant native capabilities; actual operations require separate normal KodeGPT tool calls.",
      inputSchema: {
        skillId: z.string().regex(/^sk_[a-f0-9]{64}$/),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional()
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ skillId, fingerprint }) =>
      skillToolResult(() => context.skill.inspect({ skillId, fingerprint }))
  );

  server.registerTool(
    "skill.load",
    {
      description: "Load a bounded skill instruction body and explicitly requested UTF-8 resources as data/text only; returned resources are not executed.",
      inputSchema: {
        skillId: z.string().regex(/^sk_[a-f0-9]{64}$/),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        resources: z.array(z.string().min(1)).max(SKILL_TOOL_LOAD_RESOURCE_MAX).optional(),
        maxBytes: z.number().int().positive().max(SKILL_TOOL_LOAD_MAX_BYTES).safe().optional()
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ skillId, fingerprint, resources, maxBytes }) =>
      skillToolResult(() => context.skill.load({ skillId, fingerprint, resources, maxBytes }))
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

async function skillToolResult<T>(operation: () => Promise<T>) {
  try {
    return structuredToolResult(await operation());
  } catch (error) {
    if (error instanceof SkillError) {
      throw new Error(`${error.code}: Skill request failed`);
    }
    throw new Error("SKILL_SOURCE_UNAVAILABLE: Skill request failed");
  }
}

async function nativeCapabilityResult<T>(operation: () => Promise<T>) {
  try {
    return structuredToolResult(await operation());
  } catch (error) {
    const safe = toPublicCapabilityError(error);
    const details = safe.details === undefined ? "" : ` ${JSON.stringify(safe.details)}`;
    throw new Error(`${safe.code}: ${safe.message}${details}`);
  }
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
