import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { serveKodegptStdio } from "../../packages/mcp-server/src/stdio.js";
import type { KodegptToolContext } from "../../packages/mcp-server/src/tool-context.js";

const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

const lifecycleAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
};

const mutatingFileAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
};

const context: KodegptToolContext = {
  workspace: {
    list: async () => [],
    open: async ({ rootPath }) => ({ id: "ws_stdio", canonicalRoot: rootPath }),
    close: async () => ({ ok: true }),
    info: async ({ workspaceId }) => ({ id: workspaceId }),
    readFile: async () => ({ contents: "hello", bytesRead: 5, eof: true }),
    writeFile: async () => ({ bytesWritten: 5, created: true }),
    editFile: async () => ({ bytesWritten: 5, replacements: 1 }),
    search: async () => [],
    tree: async () => []
  },
  profile: {
    current: async () => ({ name: "observe" }),
    inspect: async ({ name }) => ({ name })
  },
  system: {
    capabilities: async () => ({ filesystemBoundaryAvailable: true }),
    health: async () => ({ ok: true })
  }
};

function meta(): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
    [CLIENT_CAPABILITIES_META_KEY]: {}
  };
}

function writeMessage(stdin: PassThrough, message: unknown): void {
  stdin.write(`${JSON.stringify(message)}\n`);
}

function nextMessage(stdout: PassThrough): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      stdout.off("data", onData);
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, any>);
      } catch (error) {
        reject(error);
      }
    };
    stdout.on("data", onData);
  });
}

describe("strict MCP 2026-07-28 stdio transport", () => {
  it("uses modern discovery and the same locked tools/list registry", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const handle = serveKodegptStdio(context, { stdin, stdout });
    try {
      const discoverResponse = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "stdio-discover",
        method: "server/discover",
        params: { _meta: meta() }
      });
      const discovered = await discoverResponse;
      expect(discovered.result.supportedVersions).toEqual(["2026-07-28"]);
      expect(discovered.result.resultType).toBe("complete");
      expect(discovered.result._meta[SERVER_INFO_META_KEY]).toEqual({
        name: "KodeGPT",
        version: "0.1.0"
      });

      const toolsResponse = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "stdio-tools",
        method: "tools/list",
        params: { _meta: meta() }
      });
      const payload = await toolsResponse;
      expect(payload.result.resultType).toBe("complete");
      const tools = payload.result.tools as Array<Record<string, any>>;
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "file.edit",
        "file.read",
        "file.search",
        "file.tree",
        "file.write",
        "profile.current",
        "profile.inspect",
        "system.capabilities",
        "system.health",
        "workspace.close",
        "workspace.info",
        "workspace.list",
        "workspace.open"
      ]);
      expect(tools.some((tool) => tool.name.includes("trust"))).toBe(false);

      for (const tool of tools) {
        if (tool.name === "workspace.open" || tool.name === "workspace.close") {
          expect(tool.annotations).toEqual(lifecycleAnnotations);
        } else if (tool.name === "file.write" || tool.name === "file.edit") {
          expect(tool.annotations).toEqual(mutatingFileAnnotations);
        } else {
          expect(tool.annotations).toEqual(readOnlyAnnotations);
        }
      }

      const required = Object.fromEntries(
        tools.map((tool) => [tool.name, tool.inputSchema.required ?? []])
      );
      expect(required).toEqual({
        "file.edit": ["workspaceId", "path", "oldText", "newText", "expectedReplacements"],
        "file.read": ["workspaceId", "path"],
        "file.search": ["workspaceId", "query"],
        "file.tree": ["workspaceId"],
        "file.write": ["workspaceId", "path", "content"],
        "profile.current": ["workspaceId"],
        "profile.inspect": ["name"],
        "system.capabilities": [],
        "system.health": [],
        "workspace.close": ["workspaceId"],
        "workspace.info": ["workspaceId"],
        "workspace.list": [],
        "workspace.open": ["rootPath"]
      });

      const writeResponse = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "stdio-write",
        method: "tools/call",
        params: {
          name: "file.write",
          arguments: { workspaceId: "ws_stdio", path: "created.txt", content: "hello" },
          _meta: meta()
        }
      });
      const writePayload = await writeResponse;
      expect(JSON.parse(writePayload.result.content[0].text)).toEqual({
        bytesWritten: 5,
        created: true
      });

      const editResponse = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "stdio-edit",
        method: "tools/call",
        params: {
          name: "file.edit",
          arguments: {
            workspaceId: "ws_stdio",
            path: "created.txt",
            oldText: "hello",
            newText: "world",
            expectedReplacements: 1
          },
          _meta: meta()
        }
      });
      const editPayload = await editResponse;
      expect(JSON.parse(editPayload.result.content[0].text)).toEqual({
        bytesWritten: 5,
        replacements: 1
      });
    } finally {
      await handle.close();
    }
  });

  it("rejects a legacy initialize request instead of negotiating a compatibility session", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const handle = serveKodegptStdio(context, { stdin, stdout });
    try {
      const responsePromise = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "legacy-init",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "legacy", version: "1" }
        }
      });
      const response = await responsePromise;
      expect(response.error).toBeDefined();
      expect(response.result).toBeUndefined();
    } finally {
      await handle.close();
    }
  });
});
