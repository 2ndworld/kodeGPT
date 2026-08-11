import {
  CodeSearchInputSchema,
  CodeSearchResultSchema,
  WorkspaceInspectInputSchema,
  WorkspaceInspectResultSchema,
  type CodeSearchResult,
  type WorkspaceInspectResult
} from "@kodegpt/capabilities";
import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { OpenWorkspace } from "../../core/src/index.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations.js";
import type { KodegptToolContext, WorkspaceToolContext } from "./tool-context.js";
import { registerKodegptTools } from "./tools.js";

type CapturedHandler = (...args: never[]) => Promise<unknown>;

const typedWorkspaceListResult: OpenWorkspace[] = [
  {
    id: "ws_1",
    canonicalRoot: "/workspace",
    effectivePolicy: {
      name: "observe",
      allowWrite: false,
      allowProcess: false,
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

const typedWorkspaceInspectResult: WorkspaceInspectResult = {
  schemaVersion: 1,
  workspaceId: "ws_1",
  root: ".",
  projectTypes: ["node-pnpm", "rust-cargo"],
  languages: [
    { name: "Rust", fileCount: 1 },
    { name: "TypeScript", fileCount: 2 }
  ],
  entrypoints: [{ path: "package.json", kind: "node-manifest" }],
  areas: [{ path: "packages/core", kind: "package" }],
  manifests: [{ path: "package.json", kind: "node-package" }],
  warnings: [],
  truncated: false
};

const typedCodeSearchResult: CodeSearchResult = {
  schemaVersion: 1,
  mode: "definition",
  precision: "heuristic",
  matches: [
    {
      path: "src/main.ts",
      line: 1,
      column: 10,
      kind: "definition",
      preview: "function needle() {}"
    }
  ],
  truncated: false
};

function makeContext(): KodegptToolContext {
  return {
    workspace: {
      list: async () => typedWorkspaceListResult,
      open: async () => typedWorkspaceListResult[0],
      close: async () => ({ ok: true }),
      info: async () => typedWorkspaceListResult[0],
      inspect: async () => typedWorkspaceInspectResult,
      readFile: async () => ({ contents: "", bytesRead: 0, eof: true }),
      writeFile: async () => ({ bytesWritten: 0, created: true }),
      editFile: async () => ({ bytesWritten: 0, replacements: 0 }),
      search: async () => [],
      tree: async () => []
    },
    git: {
      status: async () => ({} as never),
      diff: async () => ({} as never),
      changes: async () => ({} as never)
    },
    process: {
      run: async () => ({} as never),
      status: async () => ({} as never),
      cancel: async () => ({} as never)
    },
    artifact: {
      read: async () => ({} as never)
    },
    extension: {
      list: async () => []
    },
    profile: {
      current: async () => ({} as never),
      inspect: async () => ({})
    },
    system: {
      capabilities: async () => ({}),
      health: async () => ({ ok: true })
    },
    code: {
      search: async () => typedCodeSearchResult
    },
    file: {
      patch: async () => ({} as never)
    },
    verify: {
      list: async () => ({} as never),
      run: async () => ({} as never)
    },
    context: {
      build: async () => ({} as never)
    }
  };
}

describe("structured MCP tool results", () => {
  it("keeps workspace.list structured content identical to its text fallback", async () => {
    const handlers = new Map<string, CapturedHandler>();
    const server = {
      registerTool(name: string, _definition: unknown, handler: CapturedHandler) {
        handlers.set(name, handler);
      }
    } as unknown as McpServer;

    registerKodegptTools(server, makeContext());
    const handler = handlers.get("workspace.list");
    expect(handler).toBeDefined();

    const result = (await handler!()) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
    };

    expect(result.structuredContent).toEqual(typedWorkspaceListResult);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it("keeps workspace.inspect schemas, annotations, and structured fallback aligned", async () => {
    const handlers = new Map<string, CapturedHandler>();
    const definitions = new Map<string, Record<string, unknown>>();
    const server = {
      registerTool(name: string, definition: Record<string, unknown>, handler: CapturedHandler) {
        definitions.set(name, definition);
        handlers.set(name, handler);
      }
    } as unknown as McpServer;

    registerKodegptTools(server, makeContext());
    const handler = handlers.get("workspace.inspect");
    const definition = definitions.get("workspace.inspect");
    expect(handler).toBeDefined();
    expect(definition?.inputSchema).toBe(WorkspaceInspectInputSchema);
    expect(definition?.outputSchema).toBe(WorkspaceInspectResultSchema);
    expect(definition?.annotations).toEqual(READ_ONLY_TOOL_ANNOTATIONS);

    const result = (await handler!({ workspaceId: "ws_1" } as never)) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
    };

    expect(result.structuredContent).toEqual(typedWorkspaceInspectResult);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it("keeps code.search schemas, annotations, and structured fallback aligned", async () => {
    const handlers = new Map<string, CapturedHandler>();
    const definitions = new Map<string, Record<string, unknown>>();
    const server = {
      registerTool(name: string, definition: Record<string, unknown>, handler: CapturedHandler) {
        definitions.set(name, definition);
        handlers.set(name, handler);
      }
    } as unknown as McpServer;

    registerKodegptTools(server, makeContext());
    const handler = handlers.get("code.search");
    const definition = definitions.get("code.search");
    expect(handler).toBeDefined();
    expect(definition?.inputSchema).toBe(CodeSearchInputSchema);
    expect(definition?.outputSchema).toBe(CodeSearchResultSchema);
    expect(definition?.annotations).toEqual(READ_ONLY_TOOL_ANNOTATIONS);

    const result = (await handler!({
      workspaceId: "ws_1",
      query: "needle",
      mode: "definition"
    } as never)) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
    };

    expect(result.structuredContent).toEqual(typedCodeSearchResult);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });
});
