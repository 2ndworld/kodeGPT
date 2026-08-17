import { describe, expect, it } from "vitest";

import { MCP_SURFACE_VERSION } from "./surface-version.js";
import { createKodegptMcpServer, listSurfaceTools } from "./server.js";
import type { KodegptToolContext } from "./tool-context.js";

const LOCKED_SURFACE = [
  { name: "artifact.read", required: ["uri"] },
  { name: "ci.failure", required: ["runId"] },
  { name: "ci.repository", required: [] },
  { name: "ci.run", required: ["runId"] },
  { name: "ci.runs", required: [] },
  { name: "ci.status", required: [] },
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
  { name: "git.fetch", required: ["workspaceId", "ref"] },
  { name: "git.log", required: ["workspaceId"] },
  { name: "git.pull", required: ["workspaceId", "ref"] },
  { name: "git.push", required: ["workspaceId", "ref"] },
  { name: "git.range", required: ["workspaceId", "baseRevision", "headRevision"] },
  { name: "git.show", required: ["workspaceId"] },
  { name: "git.stage", required: ["workspaceId", "paths"] },
  { name: "git.status", required: ["workspaceId"] },
  { name: "github.issue.inspect", required: ["repository", "number"] },
  { name: "github.issue.list", required: ["repository"] },
  { name: "github.pr.inspect", required: ["repository", "number"] },
  { name: "github.pr.list", required: ["repository"] },
  { name: "github.repository.inspect", required: ["repository"] },
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
    expect(MCP_SURFACE_VERSION).toBe("0.8");
    const surface = listSurfaceTools();
    expect(surface).toEqual(LOCKED_SURFACE);
    expect(surface).toHaveLength(56);
    expect(surface.filter(({ name }) => name.startsWith("ci.")).map(({ name }) => name)).toEqual([
      "ci.failure",
      "ci.repository",
      "ci.run",
      "ci.runs",
      "ci.status"
    ]);
    expect(surface.filter(({ name }) => name.startsWith("github.")).map(({ name }) => name)).toEqual([
      "github.issue.inspect",
      "github.issue.list",
      "github.pr.inspect",
      "github.pr.list",
      "github.repository.inspect"
    ]);
    expect(surface.some(({ name }) => name.startsWith("provider."))).toBe(false);
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
