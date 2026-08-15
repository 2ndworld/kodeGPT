import { describe, expect, it } from "vitest";

import { MCP_SURFACE_VERSION } from "./surface-version.js";
import { createKodegptMcpServer, listSurfaceTools } from "./server.js";
import type { KodegptToolContext } from "./tool-context.js";

const LOCKED_SURFACE = [
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
  { name: "git.branchCreate", required: ["workspaceId", "name"] },
  { name: "git.branchDelete", required: ["workspaceId", "name"] },
  { name: "git.branchSwitch", required: ["workspaceId", "name"] },
  { name: "git.changes", required: ["workspaceId"] },
  { name: "git.commit", required: ["workspaceId", "message"] },
  { name: "git.diff", required: ["workspaceId"] },
  { name: "git.diffHistory", required: ["workspaceId", "baseRevision", "headRevision"] },
  { name: "git.log", required: ["workspaceId"] },
  { name: "git.range", required: ["workspaceId", "baseRevision", "headRevision"] },
  { name: "git.show", required: ["workspaceId"] },
  { name: "git.stage", required: ["workspaceId", "paths"] },
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
] as const;

const expectedTools = LOCKED_SURFACE.map(({ name }) => name);

describe("KodeGPT MCP semantic surface", () => {
  it("locks surface version and tool-name/required-field snapshot", () => {
    expect(MCP_SURFACE_VERSION).toBe("0.5");
    expect(listSurfaceTools()).toEqual(LOCKED_SURFACE);
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
