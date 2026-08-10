import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { bridgeKodegpt } from "../../apps/cli/src/commands/bridge.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = join(root, "apps/cli/bin/kodegpt.mjs");
const runtimePath = join(root, "packages/runtime-linux-x64/bin/kodegpt-runtime");
const temporaryRoots: string[] = [];

import { existsSync } from "node:fs";

beforeAll(() => {
  if (!existsSync(runtimePath)) {
    const cargoBuild = spawnSync("cargo", ["build", "--release", "-p", "kodegpt-runtime"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024
    });
    expect(cargoBuild.error).toBeUndefined();
    expect(cargoBuild.status, cargoBuild.stderr).toBe(0);

    const stage = spawnSync(process.execPath, [join(root, "scripts/stage-runtime.mjs")], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    });
    expect(stage.error).toBeUndefined();
    expect(stage.status, stage.stderr).toBe(0);
  }

  if (!existsSync(cliPath)) {
    const buildCli = spawnSync("pnpm", ["--filter", "kodegpt", "run", "build:cli"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    });
    expect(buildCli.error).toBeUndefined();
    expect(buildCli.status, buildCli.stderr).toBe(0);
  }
}, 120_000);

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

function meta(): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {}
  };
}

function writeMessage(stdin: PassThrough, message: unknown): void {
  stdin.write(`${JSON.stringify(message)}\n`);
}

function nextMessage(stdout: PassThrough): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      stdout.off("data", onData);
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, any>);
      } catch (error) {
        reject(error);
      }
    };
    stdout.on("data", onData);
  });
}

describe("CLI stdio bridge integration flow", () => {
  it("runs production MCP stdio bridge over stdin/stdout with strict protocol adherence", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "kodegpt-bridge-state-"));
    const trustedDir = await mkdtemp(join(tmpdir(), "kodegpt-trusted-dir-"));
    const untrustedDir = await mkdtemp(join(tmpdir(), "kodegpt-untrusted-dir-"));
    temporaryRoots.push(stateDir, trustedDir, untrustedDir);

    // Trust trustedDir locally in stateDir via CLI workspace trust command
    const trustRes = spawnSync(
      process.execPath,
      [cliPath, "workspace", "trust", trustedDir, "--state-root", stateDir, "--ceiling", "develop"],
      { cwd: root, encoding: "utf8" }
    );
    expect(trustRes.status, trustRes.stderr).toBe(0);

    const stdin = new PassThrough();
    const stdout = new PassThrough();

    const bridged = await bridgeKodegpt({
      runtimePath,
      stateRoot: stateDir,
      streams: { stdin, stdout }
    });

    try {
      // 1. Discovery
      const discoverPromise = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "req_discover",
        method: "server/discover",
        params: { _meta: meta() }
      });
      const discoverRes = await discoverPromise;
      expect(discoverRes.error).toBeUndefined();
      expect(discoverRes.result.supportedVersions).toEqual(["2026-07-28"]);
      expect(discoverRes.result._meta["io.modelcontextprotocol/serverInfo"]).toEqual({
        name: "KodeGPT",
        version: "0.1.0"
      });

      // 2. Tools list (21 tools)
      const toolsPromise = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "req_tools",
        method: "tools/list",
        params: { _meta: meta() }
      });
      const toolsRes = await toolsPromise;
      expect(toolsRes.error).toBeUndefined();
      const tools = toolsRes.result.tools as Array<{ name: string; description?: string }>;
      expect(tools.length).toBe(21);
      const toolNames = tools.map((t) => t.name).sort();
      expect(toolNames).toEqual([
        "artifact.read",
        "console.state",
        "extension.list",
        "file.edit",
        "file.read",
        "file.search",
        "file.tree",
        "file.write",
        "git.diff",
        "git.status",
        "process.cancel",
        "process.run",
        "process.status",
        "profile.current",
        "profile.inspect",
        "system.capabilities",
        "system.health",
        "workspace.close",
        "workspace.info",
        "workspace.list",
        "workspace.open"
      ]);
      expect(toolNames.some((n) => n.includes("trust"))).toBe(false);

      // 3. System health
      const healthPromise = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "req_health",
        method: "tools/call",
        params: { name: "system.health", arguments: {}, _meta: meta() }
      });
      const healthRes = await healthPromise;
      expect(healthRes.error).toBeUndefined();
      const healthContent = JSON.parse(healthRes.result.content[0].text);
      expect(healthContent.ok).toBe(true);
      expect(healthContent.auditHealthy).toBe(true);
      expect(healthContent.filesystemBoundaryAvailable).toBe(true);

      // 4. Trusted workspace.open
      const openTrustedPromise = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "req_open_trusted",
        method: "tools/call",
        params: { name: "workspace.open", arguments: { rootPath: trustedDir }, _meta: meta() }
      });
      const openTrustedRes = await openTrustedPromise;
      expect(openTrustedRes.error).toBeUndefined();
      const opened = JSON.parse(openTrustedRes.result.content[0].text);
      expect(opened.id).toMatch(/^ws_/);
      const wsId = opened.id;

      // 5. file.write on trusted workspace
      const writePromise = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "req_write",
        method: "tools/call",
        params: {
          name: "file.write",
          arguments: { workspaceId: wsId, path: "hello.txt", content: "initial content\n" },
          _meta: meta()
        }
      });
      const writeRes = await writePromise;
      expect(writeRes.error).toBeUndefined();
      const writeData = JSON.parse(writeRes.result.content[0].text);
      expect(writeData.bytesWritten).toBe(16);
      expect(writeData.created).toBe(true);

      // 6. file.read on trusted workspace
      const readPromise = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "req_read",
        method: "tools/call",
        params: {
          name: "file.read",
          arguments: { workspaceId: wsId, path: "hello.txt" },
          _meta: meta()
        }
      });
      const readRes = await readPromise;
      expect(readRes.error).toBeUndefined();
      const readData = JSON.parse(readRes.result.content[0].text);
      expect(readData.contents).toBe("initial content\n");

      // 7. file.edit on trusted workspace
      const editPromise = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "req_edit",
        method: "tools/call",
        params: {
          name: "file.edit",
          arguments: {
            workspaceId: wsId,
            path: "hello.txt",
            oldText: "initial",
            newText: "updated",
            expectedReplacements: 1
          },
          _meta: meta()
        }
      });
      const editRes = await editPromise;
      expect(editRes.error).toBeUndefined();
      const editData = JSON.parse(editRes.result.content[0].text);
      expect(editData.bytesWritten).toBe(16);
      expect(editData.replacements).toBe(1);

      // Verify file contents after edit
      const readAfterEditPromise = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "req_read_after_edit",
        method: "tools/call",
        params: {
          name: "file.read",
          arguments: { workspaceId: wsId, path: "hello.txt" },
          _meta: meta()
        }
      });
      const readAfterEdit = await readAfterEditPromise;
      const readData2 = JSON.parse(readAfterEdit.result.content[0].text);
      expect(readData2.contents).toBe("updated content\n");

      // 8. Untrusted workspace rejection
      const openUntrustedPromise = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "req_open_untrusted",
        method: "tools/call",
        params: { name: "workspace.open", arguments: { rootPath: untrustedDir }, _meta: meta() }
      });
      const openUntrustedRes = await openUntrustedPromise;
      expect(openUntrustedRes.error || openUntrustedRes.result?.isError).toBeTruthy();
    } finally {
      await bridged.close();
    }

    // 9. Verify CLI executable binary help output includes bridge command
    const helpRes = spawnSync(process.execPath, [cliPath, "--help"], { cwd: root, encoding: "utf8" });
    expect(helpRes.status).toBe(0);
    expect(helpRes.stdout).toContain("kodegpt bridge");
  });
});
