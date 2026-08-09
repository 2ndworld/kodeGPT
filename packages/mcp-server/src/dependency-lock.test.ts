import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("MCP v2 dependency lock", () => {
  it("pins the exact approved modern tuple with client test-only", async () => {
    const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
    const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(manifest.dependencies).toMatchObject({
      "@modelcontextprotocol/server": "2.0.0",
      "@modelcontextprotocol/core": "2.0.0",
      "@modelcontextprotocol/node": "2.0.0-beta.5"
    });
    expect(manifest.devDependencies).toEqual({
      "@modelcontextprotocol/client": "2.0.0-beta.5"
    });
    expect(manifest.dependencies).not.toHaveProperty("@modelcontextprotocol/sdk");
  });
});
