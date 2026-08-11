import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { serveKodegptStdio } from "../../packages/mcp-server/src/stdio.js";
import type { KodegptToolContext } from "../../packages/mcp-server/src/tool-context.js";
import {
  EXPECTED_MCP_REQUIRED_BY_NAME,
  EXPECTED_MCP_TOOL_NAMES
} from "../fixtures/mcp-surface.js";

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

const processRunAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
};

const processCancelAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
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
  git: {
    status: async () => ({
      schemaVersion: 1,
      exitCode: 0,
      stdoutPreview: " M tracked.txt\n",
      stderrPreview: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      sourceTruncated: false,
      bytesSpooled: 15
    }),
    diff: async () => ({
      schemaVersion: 1,
      exitCode: 0,
      stdoutPreview: "diff --git a/tracked.txt b/tracked.txt\n",
      stderrPreview: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      sourceTruncated: false,
      bytesSpooled: 40
    })
  },
  process: {
    run: async () => ({
      schemaVersion: 1,
      operationId: "op_stdio",
      state: "completed",
      exitCode: 0,
      stdoutPreview: "",
      stderrPreview: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      sourceTruncated: false,
      bytesSpooled: 0
    }),
    status: async () => ({
      schemaVersion: 1,
      operationId: "op_stdio",
      state: "completed",
      exitCode: 0,
      stdoutPreview: "",
      stderrPreview: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      sourceTruncated: false,
      bytesSpooled: 0
    }),
    cancel: async () => ({
      schemaVersion: 1,
      operationId: "op_stdio",
      state: "cancelled",
      stdoutPreview: "",
      stderrPreview: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      sourceTruncated: false,
      bytesSpooled: 0
    })
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
      expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_MCP_TOOL_NAMES].sort());
      expect(tools.some((tool) => tool.name.includes("trust"))).toBe(false);

      for (const tool of tools) {
        if (tool.name === "workspace.open" || tool.name === "workspace.close") {
          expect(tool.annotations).toEqual(lifecycleAnnotations);
        } else if (tool.name === "file.write" || tool.name === "file.edit") {
          expect(tool.annotations).toEqual(mutatingFileAnnotations);
        } else if (tool.name === "process.run" || tool.name === "verify.run") {
          expect(tool.annotations).toEqual(processRunAnnotations);
        } else if (tool.name === "process.cancel") {
          expect(tool.annotations).toEqual(processCancelAnnotations);
        } else {
          expect(tool.annotations).toEqual(readOnlyAnnotations);
        }
      }

      const required = Object.fromEntries(
        tools.map((tool) => [tool.name, tool.inputSchema.required ?? []])
      );
      expect(required).toEqual(EXPECTED_MCP_REQUIRED_BY_NAME);

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

      for (const name of ["git.status", "git.diff"] as const) {
        const gitResponse = nextMessage(stdout);
        writeMessage(stdin, {
          jsonrpc: "2.0",
          id: `stdio-${name}`,
          method: "tools/call",
          params: {
            name,
            arguments: { workspaceId: "ws_stdio" },
            _meta: meta()
          }
        });
        const gitPayload = await gitResponse;
        const result = JSON.parse(gitPayload.result.content[0].text);
        expect(result).toMatchObject({
          schemaVersion: 1,
          exitCode: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          sourceTruncated: false
        });
        expect(JSON.stringify(result)).not.toContain("ka_");
        expect(result).not.toHaveProperty("artifact");
        expect(result).not.toHaveProperty("pid");
        expect(result).not.toHaveProperty("processGroup");
      }
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
