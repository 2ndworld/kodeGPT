import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MCP_PROTOCOL_VERSION } from "../../apps/cli/src/commands/start.js";
import {
  DEV_CONSOLE_MIME_TYPE,
  DEV_CONSOLE_RESOURCE_URI,
  devConsoleResourceContent
} from "../../packages/dev-console/src/index.js";
import {
  MCP_SURFACE_VERSION,
  listSurfaceTools
} from "../../packages/mcp-server/src/index.js";
import { EXPECTED_MCP_SURFACE_TOOLS } from "../fixtures/mcp-surface.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("MCP 2026 + semantic surface conformance", () => {
  it("locks protocol 2026-07-28 and the current semantic surface fixture", () => {
    expect(MCP_PROTOCOL_VERSION).toBe("2026-07-28");
    expect(MCP_SURFACE_VERSION).toBeTruthy();
    expect(listSurfaceTools()).toEqual(EXPECTED_MCP_SURFACE_TOOLS);
    expect(listSurfaceTools().some((tool) => tool.name.includes("trust"))).toBe(false);
    expect(listSurfaceTools().some((tool) => tool.name === "shell.run")).toBe(false);
  });

  it("keeps modern stateless MCP and v2-native Apps boundaries free of legacy/deprecated server paths", async () => {
    const files = await Promise.all(
      [
        "packages/mcp-server/src/http.ts",
        "packages/mcp-server/src/stdio.ts",
        "packages/mcp-server/src/server.ts",
        "packages/mcp-server/src/tools.ts"
      ].map((path) => readFile(join(REPOSITORY_ROOT, path), "utf8"))
    );
    const source = files.join("\n");

    expect(source).toContain('legacy: "reject"');
    expect(source).not.toMatch(/Mcp-Session-Id|mcp-session-id/);
    expect(source).not.toContain("@modelcontextprotocol/sdk");
    expect(source).not.toContain("@modelcontextprotocol/ext-apps/server");
    expect(source).not.toContain("registerAppTool");
    expect(source).not.toContain("registerAppResource");
    expect(source).toContain('"io.modelcontextprotocol/ui"');
    expect(source).toContain("currentRequestSupportsUi(requestContext)");
    expect(source).toContain("ui: { resourceUri: DEV_CONSOLE_RESOURCE_URI }");
  });

  it("locks the Apps resource MIME, nested metadata, and closed external CSP", () => {
    const resource = devConsoleResourceContent(DEV_CONSOLE_RESOURCE_URI);
    expect(resource.mimeType).toBe(DEV_CONSOLE_MIME_TYPE);
    expect(resource.mimeType).toBe("text/html;profile=mcp-app");
    expect(resource._meta).toEqual({
      ui: {
        csp: {
          connectDomains: [],
          resourceDomains: [],
          frameDomains: []
        }
      }
    });
    expect(resource.text).not.toMatch(/(?:src|href)=["']https?:\/\//i);
    expect(resource.text).not.toMatch(/url\(\s*["']?https?:\/\//i);
  });
});
