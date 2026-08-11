import { describe, expect, it } from "vitest";

import { MCP_SURFACE_VERSION } from "./surface-version.js";
import { createKodegptMcpServer, listSurfaceTools } from "./server.js";
import type { KodegptToolContext } from "./tool-context.js";

const expectedTools = [
  "artifact.read",
  "console.state",
  "extension.list",
  "file.edit",
  "file.read",
  "file.search",
  "file.tree",
  "file.write",
  "git.diff",
  "git.status",
  "process.cancel",
  "process.run",
  "process.status",
  "profile.current",
  "profile.inspect",
  "system.capabilities",
  "system.health",
  "workspace.close",
  "workspace.info",
  "workspace.inspect",
  "workspace.list",
  "workspace.open"
] as const;

describe("KodeGPT MCP semantic surface", () => {
  it("locks surface version and tool-name/required-field snapshot", () => {
    expect(MCP_SURFACE_VERSION).toBe("0.2");
    expect(listSurfaceTools()).toEqual([
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
    ]);
  });

  it("registers only the locked semantic tool names", () => {
    const context = {
      workspace: {
        list: async () => [],
        open: async () => ({}),
        close: async () => undefined,
        info: async () => ({}),
        inspect: async () => ({}),
        readFile: async () => ({}),
        writeFile: async () => ({}),
        editFile: async () => ({}),
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
    } as unknown as KodegptToolContext;

    const server = createKodegptMcpServer(context);

    expect(listSurfaceTools().map(({ name }) => name)).toEqual([...expectedTools]);
    expect(server).toBeDefined();
  });
});
