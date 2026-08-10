import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

  it("keeps ext-apps isolated to dev-console and forbids server helper imports", async () => {
    const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
    const packageRoot = dirname(packagePath);
    const devConsoleManifest = JSON.parse(
      await readFile(join(packageRoot, "../dev-console/package.json"), "utf8")
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(devConsoleManifest.dependencies?.["@modelcontextprotocol/ext-apps"]).toBe("1.7.5");
    expect(devConsoleManifest.devDependencies?.esbuild).toBe("0.28.1");

    const source = await Promise.all(
      ["server.ts", "tools.ts", "tool-context.ts"].map((file) =>
        readFile(join(packageRoot, "src", file), "utf8")
      )
    );
    const combined = source.join("\n");
    expect(combined).not.toContain("@modelcontextprotocol/sdk");
    expect(combined).not.toContain("@modelcontextprotocol/ext-apps/server");
  });
});
