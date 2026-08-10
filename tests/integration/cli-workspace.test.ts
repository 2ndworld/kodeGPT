import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ConnectorCredentialStore } from "../../packages/auth/src/index.js";
import { startKodegpt } from "../../apps/cli/src/commands/start.js";
import { listSurfaceTools } from "../../packages/mcp-server/src/index.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = join(root, "apps/cli/bin/kodegpt.mjs");
const temporaryRoots: string[] = [];

beforeAll(() => {
  const build = spawnSync("cargo", ["build", "--release", "-p", "kodegpt-runtime"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  expect(build.error).toBeUndefined();
  expect(build.status, build.stderr).toBe(0);

  const stage = spawnSync(process.execPath, [join(root, "scripts/stage-runtime.mjs")], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
  expect(stage.error).toBeUndefined();
  expect(stage.status, stage.stderr).toBe(0);

  const buildCli = spawnSync("pnpm", ["--filter", "kodegpt", "run", "build:cli"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
  expect(buildCli.error).toBeUndefined();
  expect(buildCli.status, buildCli.stderr).toBe(0);
}, 60_000);

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

function runCli(args: string[], stateRoot: string) {
  return spawnSync(process.execPath, [cliPath, ...args, "--state-root", stateRoot], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
}

function callMcpTool(
  port: number,
  token: string,
  name: string,
  args: Record<string, unknown>,
  id: string
): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {}
        }
      }
    });
    const req = httpRequest(
      `http://127.0.0.1:${port}/mcp`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${token}`,
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": name
        }
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk.toString("utf8");
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function textJson(response: any): any {
  if (response.error) return response.error;
  const content = response.result?.content?.[0];
  if (content?.type === "text") {
    return JSON.parse(content.text);
  }
  return response.result;
}

describe("CLI workspace trust integration flow", () => {
  it("supports local-only workspace trust admission and integration with MCP start", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "kodegpt-cli-trust-state-"));
    const trustedDir = await mkdtemp(join(tmpdir(), "kodegpt-cli-trusted-dir-"));
    const untrustedDir = await mkdtemp(join(tmpdir(), "kodegpt-cli-untrusted-dir-"));
    temporaryRoots.push(stateDir, trustedDir, untrustedDir);

    // 0. Rotate connector credential for stateDir so startKodegpt authentication is ready
    const rotateRes = runCli(["auth", "rotate"], stateDir);
    expect(rotateRes.status, rotateRes.stderr).toBe(0);

    // 1. Initial list should report no trusted workspaces
    const initialList = runCli(["workspace", "list"], stateDir);
    expect(initialList.status, initialList.stderr).toBe(0);
    expect(initialList.stdout).toContain("no trusted workspaces");

    // 2. Trust the directory via CLI
    const trustRes = runCli(["workspace", "trust", trustedDir, "--ceiling", "develop"], stateDir);
    expect(trustRes.status, trustRes.stderr).toBe(0);
    expect(trustRes.stdout).toContain("trusted");
    expect(trustRes.stdout).toContain("ceiling=develop");

    // Extract trust ID from output: "trusted <id> <canonicalRoot> ceiling=develop"
    const match = trustRes.stdout.match(/^trusted\s+(\S+)\s+/);
    expect(match).not.toBeNull();
    const trustId = match![1];

    // 3. List should now include the trusted workspace
    const secondList = runCli(["workspace", "list"], stateDir);
    expect(secondList.status, secondList.stderr).toBe(0);
    expect(secondList.stdout).toContain(trustId);
    expect(secondList.stdout).toContain("develop");

    // 4. Start KodeGPT MCP server using the same stateRoot and test MCP operations
    const runtimePath = join(root, "packages/runtime-linux-x64/bin/kodegpt-runtime");
    const started = await startKodegpt({
      stateRoot: stateDir,
      port: 18888,
      publicUrl: "https://localhost:18888",
      runtimePath
    });

    try {
      const port = started.status.port;
      const store = new ConnectorCredentialStore(stateDir);
      const credential = await store.rotate();

      // Verify MCP surface has NO trust tool
      const surfaceTools = listSurfaceTools();
      expect(surfaceTools.some((t) => t.name.includes("trust"))).toBe(false);

      // Verify workspace.open for trusted directory succeeds
      const openTrustedRes = await callMcpTool(
        port,
        credential.token,
        "workspace.open",
        { rootPath: trustedDir },
        "req_open_trusted"
      );
      const opened = textJson(openTrustedRes);
      expect(opened.id).toMatch(/^ws_/);

      // Verify workspace.open for untrusted directory is rejected
      const openUntrustedRes = await callMcpTool(
        port,
        credential.token,
        "workspace.open",
        { rootPath: untrustedDir },
        "req_open_untrusted"
      );
      expect(openUntrustedRes.error || openUntrustedRes.result?.isError).toBeTruthy();
    } finally {
      await started.close();
    }

    // 5. Untrust the workspace via CLI
    const untrustRes = runCli(["workspace", "untrust", trustId], stateDir);
    expect(untrustRes.status, untrustRes.stderr).toBe(0);
    expect(untrustRes.stdout).toContain(`untrusted ${trustId}`);

    // 6. List should be empty again
    const finalList = runCli(["workspace", "list"], stateDir);
    expect(finalList.status, finalList.stderr).toBe(0);
    expect(finalList.stdout).toContain("no trusted workspaces");
  }, 60_000);
});
