import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConnectorCredentialStore } from "../../packages/auth/src/index.js";
import { KernelClient } from "../../packages/core/src/kernel-client.js";
import { MCP_SURFACE_VERSION } from "../../packages/mcp-server/src/index.js";
import { WorkspaceTrustStore } from "../../packages/trust/src/index.js";
import { startKodegpt } from "../../apps/cli/src/commands/start.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TARGET = join(REPOSITORY_ROOT, "target", "task23-full-stack");
const RUNTIME = join(TARGET, "debug", "kodegpt-runtime");
const temporaryRoots: string[] = [];
const PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

type InspectRootResult = {
  canonicalRoot: string;
  identity: {
    deviceMajor: number;
    deviceMinor: number;
    inode: number;
  };
};

function buildRuntime(): void {
  const result = spawnSync(
    "cargo",
    ["build", "-p", "kodegpt-runtime", "--target-dir", TARGET],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

function requestMeta() {
  return {
    [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
    [CLIENT_CAPABILITIES_META_KEY]: {}
  };
}

async function mcpRequest(
  port: number,
  token: string,
  method: string,
  params: Record<string, unknown>,
  id: string,
  name?: string
): Promise<Record<string, any>> {
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "mcp-protocol-version": PROTOCOL_VERSION,
          "mcp-method": method,
          ...(name === undefined ? {} : { "mcp-name": name })
        }
      },
      (incoming) => {
        let responseBody = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => {
          responseBody += chunk;
        });
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body: responseBody }));
      }
    );
    request.once("error", reject);
    request.end(body);
  });
  expect(response.status, response.body).toBe(200);
  const payload = JSON.parse(response.body) as Record<string, any>;
  expect(payload.error).toBeUndefined();
  return payload;
}

async function callTool(
  port: number,
  token: string,
  name: string,
  argumentsValue: Record<string, unknown>,
  id: string
): Promise<Record<string, any>> {
  const payload = await mcpRequest(
    port,
    token,
    "tools/call",
    { name, arguments: argumentsValue, _meta: requestMeta() },
    id,
    name
  );
  return payload.result as Record<string, any>;
}

function textJson(result: Record<string, any>): any {
  const content = result.content as Array<Record<string, unknown>>;
  expect(content?.[0]).toMatchObject({ type: "text" });
  return JSON.parse(String(content[0]?.text ?? "null"));
}

beforeAll(() => buildRuntime(), 60_000);

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("KodeGPT v0.1 full-stack temporary-state flow", () => {
  it("runs modern MCP workspace/file/git/process/artifact/console lifecycle across two trusted workspaces", async () => {
    const stateRoot = await tempRoot("kodegpt-task23-state-");
    const workspaceA = await tempRoot("kodegpt-task23-a-");
    const workspaceB = await tempRoot("kodegpt-task23-b-");
    await mkdir(join(workspaceA, "nested"));
    await mkdir(join(workspaceA, "src"));
    await writeFile(join(workspaceA, "tracked.txt"), "before\n");
    await writeFile(join(workspaceA, "src/main.ts"), "export function needle() {}\nneedle();\n");
    await writeFile(join(workspaceA, "package.json"), '{"name":"workspace-a","private":true}\n');
    await writeFile(join(workspaceA, "pnpm-workspace.yaml"), "packages: []\n");
    await writeFile(join(workspaceB, "other.txt"), "workspace-b\n");
    runGit(workspaceA, ["init", "-q"]);
    runGit(workspaceA, ["add", "tracked.txt"]);

    const trust = new WorkspaceTrustStore(stateRoot);
    const inspector = await KernelClient.start({ runtimePath: RUNTIME, stateRoot });
    try {
      for (const rootPath of [workspaceA, workspaceB]) {
        const inspected = await inspector.request<InspectRootResult>("system.inspect_root", {
          path: rootPath
        });
        await trust.trust({
          canonicalRoot: inspected.canonicalRoot,
          identity: inspected.identity,
          profileCeiling: "trusted"
        });
      }
    } finally {
      await inspector.stop();
    }

    const credential = await new ConnectorCredentialStore(stateRoot).rotate();
    const started = await startKodegpt({ runtimePath: RUNTIME, stateRoot, port: 43_129 });
    try {
      expect(started.status.host).toBe("127.0.0.1");
      const port = started.status.port;

      const discover = await mcpRequest(
        port,
        credential.token,
        "server/discover",
        { _meta: requestMeta() },
        "req_full_discover"
      );
      expect(discover.result.supportedVersions).toEqual([PROTOCOL_VERSION]);
      expect(discover.result.resultType).toBe("complete");

      const capabilities = textJson(
        await callTool(port, credential.token, "system.capabilities", {}, "req_full_caps")
      );
      expect(capabilities).toMatchObject({
        mcpProtocolVersion: PROTOCOL_VERSION,
        mcpSurfaceVersion: MCP_SURFACE_VERSION,
        filesystemBoundaryAvailable: true
      });

      const openedA = textJson(
        await callTool(
          port,
          credential.token,
          "workspace.open",
          { rootPath: workspaceA },
          "req_full_open_a"
        )
      );
      const openedB = textJson(
        await callTool(
          port,
          credential.token,
          "workspace.open",
          { rootPath: workspaceB },
          "req_full_open_b"
        )
      );
      expect(openedA.id).toMatch(/^ws_/);
      expect(openedB.id).toMatch(/^ws_/);
      expect(openedA.id).not.toBe(openedB.id);

      expect(
        textJson(
          await callTool(
            port,
            credential.token,
            "file.write",
            { workspaceId: openedA.id, path: "tracked.txt", content: "after hello\n" },
            "req_full_write"
          )
        )
      ).toMatchObject({ bytesWritten: 12 });

      const read = textJson(
        await callTool(
          port,
          credential.token,
          "file.read",
          { workspaceId: openedA.id, path: "tracked.txt" },
          "req_full_read"
        )
      );
      expect(read.contents).toBe("after hello\n");

      const search = textJson(
        await callTool(
          port,
          credential.token,
          "file.search",
          { workspaceId: openedA.id, query: "hello" },
          "req_full_search"
        )
      );
      expect(JSON.stringify(search)).toContain("tracked.txt");

      const tree = textJson(
        await callTool(
          port,
          credential.token,
          "file.tree",
          { workspaceId: openedA.id },
          "req_full_tree"
        )
      );
      expect(JSON.stringify(tree)).toContain("tracked.txt");

      const inspectResult = await callTool(
        port,
        credential.token,
        "workspace.inspect",
        { workspaceId: openedA.id },
        "req_full_workspace_inspect"
      );
      const inspect = textJson(inspectResult);
      expect(inspectResult.structuredContent).toEqual(inspect);
      expect(inspect).toMatchObject({
        schemaVersion: 1,
        workspaceId: openedA.id,
        root: ".",
        projectTypes: ["node-pnpm"],
        truncated: false
      });

      const codeSearchResult = await callTool(
        port,
        credential.token,
        "code.search",
        { workspaceId: openedA.id, query: "needle", mode: "definition", path: "src" },
        "req_full_code_search"
      );
      const codeSearch = textJson(codeSearchResult);
      expect(codeSearchResult.structuredContent).toEqual(codeSearch);
      expect(codeSearch).toMatchObject({
        schemaVersion: 1,
        mode: "definition",
        precision: "heuristic",
        truncated: false
      });
      expect(codeSearch.matches).toEqual([
        {
          path: "src/main.ts",
          line: 1,
          column: 17,
          kind: "definition",
          preview: "export function needle() {}"
        }
      ]);

      const gitChangesResult = await callTool(
        port,
        credential.token,
        "git.changes",
        { workspaceId: openedA.id, includePatch: true },
        "req_full_git_changes"
      );
      const gitChanges = textJson(gitChangesResult);
      expect(gitChangesResult.structuredContent).toEqual(gitChanges);
      expect(gitChanges).toMatchObject({
        schemaVersion: 1,
        workspaceId: openedA.id,
        clean: false,
        summary: { changedFiles: 4 },
        truncated: false
      });
      expect(gitChanges.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(gitChanges.changedPaths).toContainEqual({
        path: "tracked.txt",
        indexStatus: "A",
        worktreeStatus: "M"
      });
      expect(gitChanges.patchPreview).toContain("tracked.txt");
      expect(gitChanges.patchArtifact.uri).toMatch(/^artifact:\/\/ka_/);
      expect(JSON.stringify(gitChanges)).not.toContain(workspaceA);

      const gitStatus = textJson(
        await callTool(
          port,
          credential.token,
          "git.status",
          { workspaceId: openedA.id },
          "req_full_git_status"
        )
      );
      expect(gitStatus.exitCode).toBe(0);
      expect(gitStatus.artifact.uri).toMatch(/^artifact:\/\/ka_/);

      const gitDiff = textJson(
        await callTool(
          port,
          credential.token,
          "git.diff",
          { workspaceId: openedA.id },
          "req_full_git_diff"
        )
      );
      expect(gitDiff.exitCode).toBe(0);
      expect(gitDiff.stdoutPreview).toContain("tracked.txt");

      const foreground = textJson(
        await callTool(
          port,
          credential.token,
          "process.run",
          {
            workspaceId: openedA.id,
            logicalExecutable: "python3",
            argv: ["-c", "print('foreground-ok')"],
            background: false
          },
          "req_full_process_fg"
        )
      );
      expect(foreground.state).toBe("completed");
      expect(foreground.exitCode).toBe(0);
      expect(foreground.stdoutPreview).toContain("foreground-ok");
      expect(foreground.artifact.uri).toMatch(/^artifact:\/\/ka_/);

      const artifact = textJson(
        await callTool(
          port,
          credential.token,
          "artifact.read",
          { uri: foreground.artifact.uri, offset: 0, maxBytes: 1024 },
          "req_full_artifact"
        )
      );
      expect(artifact.uri).toBe(foreground.artifact.uri);
      expect(artifact.bytesRead).toBeGreaterThan(0);

      const background = textJson(
        await callTool(
          port,
          credential.token,
          "process.run",
          {
            workspaceId: openedA.id,
            logicalExecutable: "python3",
            argv: ["-c", "import time; time.sleep(30)"],
            background: true
          },
          "req_full_process_bg"
        )
      );
      expect(background.operationId).toMatch(/^op_/);
      expect(background.state).toBe("running");

      const processStatus = textJson(
        await callTool(
          port,
          credential.token,
          "process.status",
          { workspaceId: openedA.id, operationId: background.operationId },
          "req_full_process_status"
        )
      );
      expect(processStatus.operationId).toBe(background.operationId);

      const cancelled = textJson(
        await callTool(
          port,
          credential.token,
          "process.cancel",
          { workspaceId: openedA.id, operationId: background.operationId },
          "req_full_process_cancel"
        )
      );
      expect(cancelled).toMatchObject({
        operationId: background.operationId,
        state: "cancelled"
      });

      const consoleResult = await callTool(
        port,
        credential.token,
        "console.state",
        {},
        "req_full_console"
      );
      expect(consoleResult.structuredContent).toMatchObject({
        schemaVersion: 1,
        host: { uiSupported: false }
      });
      expect(consoleResult.content?.[0]).toMatchObject({ type: "text" });
      expect(JSON.stringify(consoleResult.structuredContent)).toContain(openedA.id);

      const extensions = textJson(
        await callTool(port, credential.token, "extension.list", {}, "req_full_extensions")
      );
      expect(extensions).toEqual([]);

      await callTool(
        port,
        credential.token,
        "workspace.close",
        { workspaceId: openedA.id },
        "req_full_close_a"
      );
      await callTool(
        port,
        credential.token,
        "workspace.close",
        { workspaceId: openedB.id },
        "req_full_close_b"
      );
      const remaining = textJson(
        await callTool(port, credential.token, "workspace.list", {}, "req_full_list_after_close")
      );
      expect(remaining).toEqual([]);
    } finally {
      await started.close();
    }
  }, 45_000);
});
