import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEV_CONSOLE_CURRENT_RESOURCE_URI,
  DEV_CONSOLE_MIME_TYPE,
  DEV_CONSOLE_RESOURCE_URI,
  devConsoleResourceContent
} from "../../packages/dev-console/src/index.js";
import { listSurfaceTools } from "../../packages/mcp-server/src/server.js";

describe("MCP Apps Dev Console contract", () => {
  it("serves self-contained versioned and current resources with closed CSP", () => {
    for (const uri of [DEV_CONSOLE_RESOURCE_URI, DEV_CONSOLE_CURRENT_RESOURCE_URI] as const) {
      const resource = devConsoleResourceContent(uri);
      expect(resource.uri).toBe(uri);
      expect(resource.mimeType).toBe("text/html;profile=mcp-app");
      expect(resource.mimeType).toBe(DEV_CONSOLE_MIME_TYPE);
      expect(resource._meta.ui.csp).toEqual({
        connectDomains: [],
        resourceDomains: [],
        frameDomains: []
      });
      expect(resource.text).toContain("KodeGPT Dev Console");
      for (const view of ["Dashboard", "Evidence", "Processes", "Remote", "Security", "Diagnostics"]) {
        expect(resource.text).toContain(view);
      }
      expect(resource.text).toContain("Next actions");
      expect(resource.text).toContain("Verification");
      expect(resource.text).not.toMatch(/(?:src|href)=["']https?:\/\//i);
      expect(resource.text).not.toMatch(/url\(\s*["']?https?:\/\//i);
    }
  });

  it("exposes one console tool and keeps /current as resource alias only", () => {
    const consoleTools = listSurfaceTools().filter((tool) => tool.name.startsWith("console."));
    expect(consoleTools).toEqual([{ name: "console.state", required: [] }]);
    expect(listSurfaceTools().some((tool) => tool.name === "console.current")).toBe(false);
  });

  it("does not synchronously refresh Git from console.state and binds nested UI metadata", async () => {
    const sourcePath = fileURLToPath(
      new URL("../../packages/mcp-server/src/tools.ts", import.meta.url)
    );
    const source = await readFile(sourcePath, "utf8");
    const start = source.indexOf('server.registerTool(\n    "console.state"');
    const nextTool = source.indexOf("server.registerTool(", start + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(nextTool).toBeGreaterThan(start);
    const consoleBlock = source.slice(start, nextTool);
    expect(consoleBlock).toContain("ui: { resourceUri: DEV_CONSOLE_RESOURCE_URI }");
    expect(consoleBlock).not.toContain("context.git");
    expect(consoleBlock).not.toContain("context.ci");
    expect(consoleBlock).not.toContain("context.github");
    expect(consoleBlock).toContain("context.workspace.list()");
    expect(consoleBlock).toContain("context.system.health()");
  });
});
