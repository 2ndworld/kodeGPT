import { describe, expect, it } from "vitest";

import { createKodegptToolContext } from "./tool-context.js";

function baseOptions(calls: string[]) {
  return {
    workspaceManager: {
      listWorkspaces: () => [],
      listTrustedWorkspaces: () => [],
      closeWorkspace: async () => {
        calls.push("workspace.close");
      }
    } as never,
    executionManager: {} as never,
    artifactStore: {} as never,
    extensionRegistry: {} as never,
    inspectProfile: () => ({}),
    capabilities: () => ({}),
    health: () => ({})
  };
}

function preview(calls: string[]) {
  return {
    start: async () => ({}) as never,
    inspect: async () => ({}) as never,
    stop: async () => {
      calls.push("preview.stop");
      return {} as never;
    },
    releaseWorkspace: () => {
      calls.push("preview.releaseWorkspace");
    }
  };
}

function browser(calls: string[]) {
  return {
    openPreview: async () => ({}) as never,
    inspect: async () => ({}) as never,
    click: async () => ({}) as never,
    type: async () => ({}) as never,
    screenshot: async () => ({}) as never,
    console: async () => ({}) as never,
    networkFailures: async () => ({}) as never,
    releasePreview: async () => {
      calls.push("browser.releasePreview");
    },
    releaseWorkspace: async () => {
      calls.push("browser.releaseWorkspace");
    }
  };
}

describe("browser tool context lifecycle", () => {
  it("releases the browser session before preview.stop", async () => {
    const calls: string[] = [];
    const context = createKodegptToolContext({
      ...baseOptions(calls),
      preview: preview(calls),
      browser: browser(calls)
    });

    await context.preview.stop({ workspaceId: "ws_test", previewId: "pv_test" });
    expect(calls).toEqual(["browser.releasePreview", "preview.stop"]);
  });

  it("releases browser and preview registries only after workspace close succeeds", async () => {
    const calls: string[] = [];
    const context = createKodegptToolContext({
      ...baseOptions(calls),
      preview: preview(calls),
      browser: browser(calls)
    });

    await context.workspace.close({ workspaceId: "ws_test" });
    expect(calls).toEqual([
      "workspace.close",
      "browser.releaseWorkspace",
      "preview.releaseWorkspace"
    ]);
  });
});
