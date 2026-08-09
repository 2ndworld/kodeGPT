import { describe, expect, it } from "vitest";

import { MCP_SURFACE_VERSION } from "./surface-version.js";
import { createKodegptMcpServer, listSurfaceTools } from "./server.js";

const expectedTools = [
  "file.read",
  "file.search",
  "file.tree",
  "profile.current",
  "profile.inspect",
  "system.capabilities",
  "system.health",
  "workspace.close",
  "workspace.info",
  "workspace.list",
  "workspace.open"
] as const;

describe("KodeGPT MCP semantic surface", () => {
  it("locks surface version and tool-name/required-field snapshot", () => {
    expect(MCP_SURFACE_VERSION).toBe("0.1");
    expect(listSurfaceTools()).toEqual([
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
    ]);
  });

  it("registers only the locked semantic tool names", () => {
    const server = createKodegptMcpServer({
      workspace: {
        list: async () => [],
        open: async () => ({}),
        close: async () => undefined,
        info: async () => ({}),
        readFile: async () => ({}),
        search: async () => [],
        tree: async () => []
      },
      profile: {
        current: async () => ({}),
        inspect: async () => ({})
      },
      system: {
        capabilities: async () => ({}),
        health: async () => ({ ok: true })
      }
    });

    expect(listSurfaceTools().map(({ name }) => name)).toEqual([...expectedTools]);
    expect(server).toBeDefined();
  });
});
