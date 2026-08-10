import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createHttpTrustConfig,
  enforceHttpRequestTrust
} from "../../packages/auth/src/index.js";

describe("manual HTTPS exposure", () => {
  it("adds only the exact HTTPS public authority while preserving loopback authorities", () => {
    const config = createHttpTrustConfig({
      allowedHosts: ["127.0.0.1:43121", "localhost:43121"],
      allowedOriginHosts: ["127.0.0.1:43121", "localhost:43121"],
      publicUrl: "https://kodegpt.example.test/mcp",
      maxRequestBodyBytes: 1024
    });

    expect(config.allowedHosts).toEqual([
      "127.0.0.1:43121",
      "kodegpt.example.test",
      "localhost:43121"
    ]);
    expect(config.publicUrl).toBe("https://kodegpt.example.test/mcp");
    expect(() =>
      enforceHttpRequestTrust(config, {
        host: "kodegpt.example.test",
        origin: "https://kodegpt.example.test",
        contentType: "application/json",
        contentLength: "2",
        actualBodyBytes: 2
      })
    ).not.toThrow();
    for (const [host, origin] of [
      ["sub.kodegpt.example.test", "https://kodegpt.example.test"],
      ["kodegpt.example.test", "https://sub.kodegpt.example.test"],
      ["kodegpt.example.test", "http://kodegpt.example.test"]
    ] as const) {
      expect(() =>
        enforceHttpRequestTrust(config, {
          host,
          origin,
          contentType: "application/json",
          contentLength: "2",
          actualBodyBytes: 2
        })
      ).toThrow();
    }
  });

  it("keeps the listener loopback-only and starts no exposure subprocess", async () => {
    const sourcePath = fileURLToPath(
      new URL("../../apps/cli/src/commands/start.ts", import.meta.url)
    );
    const source = await readFile(sourcePath, "utf8");
    expect(source).toContain('const LOOPBACK_HOST = "127.0.0.1" as const');
    expect(source).toContain("dependencies.bindLoopback({ mcp, port })");
    expect(source).not.toMatch(/from\s+["']node:child_process["']/);
    expect(source).not.toMatch(/\b(?:spawn|exec|fork)\s*\(/);
    expect(source).not.toMatch(/\b(?:ngrok|cloudflared|localtunnel)\b/i);
  });
});
