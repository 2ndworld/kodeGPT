import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { listPublicActionDescriptors } from "@kodegpt/capabilities";
import { describe, expect, it } from "vitest";

import { MCP_SURFACE_VERSION } from "./surface-version.js";
import { createKodegptMcpServer, listSurfaceTools } from "./server.js";
import type { KodegptToolContext } from "./tool-context.js";

const LOCKED_SURFACE = [
  { name: "artifact.read", required: ["uri"] },
  { name: "browser.openPreview", required: ["workspaceId", "previewId"] },
  { name: "browser.inspect", required: ["workspaceId", "previewId"] },
  { name: "browser.click", required: ["workspaceId", "previewId", "target"] },
  { name: "browser.type", required: ["workspaceId", "previewId", "target", "text"] },
  { name: "browser.screenshot", required: ["workspaceId", "previewId"] },
  { name: "browser.console", required: ["workspaceId", "previewId"] },
  { name: "browser.networkFailures", required: ["workspaceId", "previewId"] },
  { name: "visual.captureMatrix", required: ["workspaceId", "previewId"] },
  { name: "visual.compare", required: ["workspaceId", "previewId", "referenceArtifact"] },
  { name: "ci.failure", required: ["runId"] },
  { name: "ci.rerun", required: ["runId"] },
  { name: "ci.cancel", required: ["runId"] },
  { name: "ci.dispatch", required: ["workflow", "ref"] },
  { name: "ci.repository", required: [] },
  { name: "ci.run", required: ["runId"] },
  { name: "ci.runs", required: [] },
  { name: "ci.status", required: [] },
  { name: "code.impact", required: ["workspaceId", "target"] },
  { name: "code.search", required: ["workspaceId", "query"] },
  { name: "console.state", required: [] },
  { name: "context.build", required: ["workspaceId", "intent"] },
  {
    name: "file.edit",
    required: ["workspaceId", "path", "oldText", "newText", "expectedReplacements"]
  },
  { name: "file.read", required: ["workspaceId", "path"] },
  { name: "file.patch", required: ["workspaceId", "patch"] },
  { name: "file.tree", required: ["workspaceId"] },
  { name: "file.write", required: ["workspaceId", "path", "content"] },
  { name: "git.branchCreate", required: ["workspaceId", "name"] },
  { name: "git.branchDelete", required: ["workspaceId", "name"] },
  { name: "git.branchSwitch", required: ["workspaceId", "name"] },
  { name: "git.worktreeCreate", required: ["workspaceId", "name", "branch"] },
  { name: "git.worktreeRemove", required: ["workspaceId", "name"] },
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
  { name: "github.pr.create", required: ["repository", "title", "headBranch", "baseBranch"] },
  { name: "github.pr.inspect", required: ["repository", "number"] },
  { name: "github.pr.list", required: ["repository"] },
  { name: "github.pr.merge", required: ["repository", "number", "expectedHeadOid"] },
  { name: "github.repository.inspect", required: ["repository"] },
  { name: "process.cancel", required: ["workspaceId", "operationId"] },
  { name: "process.run", required: ["workspaceId", "logicalExecutable", "argv"] },
  { name: "process.status", required: ["workspaceId", "operationId"] },
  { name: "preview.inspect", required: ["workspaceId", "previewId"] },
  { name: "preview.start", required: ["workspaceId", "logicalExecutable", "argv", "port"] },
  { name: "preview.stop", required: ["workspaceId", "previewId"] },
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
  { name: "workspace.checkpoint", required: ["workspaceId", "operation"] },
  { name: "workspace.info", required: ["workspaceId"] },
  { name: "workspace.inspect", required: ["workspaceId"] },
  { name: "workspace.list", required: [] },
  { name: "workspace.open", required: ["rootPath"] },
  { name: "workspace.trust", required: ["rootPath"] },
  { name: "workspace.untrust", required: ["trustId"] }
] as const;

const expectedTools = LOCKED_SURFACE.map(({ name }) => name);

describe("KodeGPT MCP semantic surface", () => {
  it("derives the public surface from the authoritative public action catalog", () => {
    const surface = listSurfaceTools();
    expect(surface).toEqual(
      listPublicActionDescriptors().map(({ id, requiredInputs }) => ({
        name: id,
        required: [...requiredInputs]
      }))
    );

    const toolsSource = readFileSync(fileURLToPath(new URL("./tools.ts", import.meta.url)), "utf8");
    expect(toolsSource).not.toContain("const SURFACE_TOOLS");
  });

  it("locks surface version and tool-name/required-field snapshot", () => {
    expect(MCP_SURFACE_VERSION).toBe("0.17");
    const surface = listSurfaceTools();
    expect(surface).toEqual(LOCKED_SURFACE);
    expect(surface).toHaveLength(75);
    expect(surface.filter(({ name }) => name.startsWith("ci.")).map(({ name }) => name)).toEqual([
      "ci.failure",
      "ci.rerun",
      "ci.cancel",
      "ci.dispatch",
      "ci.repository",
      "ci.run",
      "ci.runs",
      "ci.status"
    ]);
    expect(surface.filter(({ name }) => name.startsWith("github.")).map(({ name }) => name)).toEqual([
      "github.issue.inspect",
      "github.issue.list",
      "github.pr.create",
      "github.pr.inspect",
      "github.pr.list",
      "github.pr.merge",
      "github.repository.inspect"
    ]);
    expect(surface.some(({ name }) => name.startsWith("deploy."))).toBe(false);
    expect(surface.some(({ name }) => name === "file.search")).toBe(false);
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
      preview: {
        start: async () => ({}),
        inspect: async () => ({}),
        stop: async () => ({})
      },
      browser: {
        openPreview: async () => ({}),
        inspect: async () => ({}),
        click: async () => ({}),
        type: async () => ({}),
        screenshot: async () => ({}),
        console: async () => ({}),
        networkFailures: async () => ({}),
        releasePreview: async () => undefined,
        releaseWorkspace: async () => undefined
      },
      artifact: {
        read: async () => ({})
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
