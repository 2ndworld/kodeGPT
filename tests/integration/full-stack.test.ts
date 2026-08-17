import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConnectorCredentialStore } from "../../packages/auth/src/index.js";
import {
  RemoteCiRepositoryResolver,
  RemoteCiService,
  type RemoteCiAdapter
} from "../../packages/capabilities/src/index.js";
import { KernelClient } from "../../packages/core/src/kernel-client.js";
import { MCP_SURFACE_VERSION } from "../../packages/mcp-server/src/index.js";
import { WorkspaceTrustStore } from "../../packages/trust/src/index.js";
import { defaultStartDependencies, startKodegpt } from "../../apps/cli/src/commands/start.js";

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
    const hostOnlyRoot = await tempRoot("kodegpt-task23-host-only-");
    const hostOnlySecret = join(hostOnlyRoot, "secret.txt");
    await writeFile(hostOnlySecret, "must-not-be-visible\n");
    await mkdir(join(workspaceA, "nested"));
    await mkdir(join(workspaceA, "src"));
    await mkdir(join(workspaceA, "frontend"));
    await mkdir(join(workspaceA, "node_modules/pkg"), { recursive: true });
    await mkdir(join(workspaceA, ".worktrees/old"), { recursive: true });
    await mkdir(join(workspaceA, "target/generated"), { recursive: true });
    await writeFile(join(workspaceA, "tracked.txt"), "before\n");
    await writeFile(join(workspaceA, "src/main.ts"), "export function needle() {}\nneedle();\n");
    await writeFile(
      join(workspaceA, "frontend/package.json"),
      JSON.stringify({
        name: "frontend",
        scripts: { test: "frontend-test", lint: "frontend-lint", typecheck: "frontend-typecheck", build: "frontend-build" }
      }) + "\n"
    );
    await writeFile(
      join(workspaceA, "node_modules/pkg/package.json"),
      JSON.stringify({ name: "dependency-copy", marker: "dependency-marker" }) + "\n"
    );
    await writeFile(
      join(workspaceA, ".worktrees/old/package.json"),
      JSON.stringify({ name: "worktree-copy", marker: "worktree-marker" }) + "\n"
    );
    await writeFile(
      join(workspaceA, "target/generated/package.json"),
      JSON.stringify({ name: "generated-copy", marker: "generated-marker" }) + "\n"
    );
    await writeFile(
      join(workspaceA, "package.json"),
      JSON.stringify({
        name: "workspace-a",
        private: true,
        packageManager: "pnpm@10.15.0",
        scripts: { test: "node -e \"console.log('verify-ok')\"" }
      }) + "\n"
    );
    await writeFile(join(workspaceA, "pnpm-workspace.yaml"), "packages: []\n");
    await writeFile(join(workspaceA, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(join(workspaceB, "other.txt"), "workspace-b\n");
    runGit(workspaceA, ["init", "-q"]);
    await writeFile(
      join(workspaceA, ".git/info/exclude"),
      "/frontend/\n/node_modules/\n/.worktrees/\n/target/\n"
    );
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

      const literalDependencySearch = textJson(
        await callTool(
          port,
          credential.token,
          "file.search",
          { workspaceId: openedA.id, query: "dependency-marker", path: "node_modules" },
          "req_full_literal_dependency_search"
        )
      );
      expect(JSON.stringify(literalDependencySearch)).toContain("node_modules/pkg/package.json");

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
      const serializedInspect = JSON.stringify(inspect);
      expect(serializedInspect).not.toContain("node_modules");
      expect(serializedInspect).not.toContain(".worktrees");
      expect(serializedInspect).not.toContain("target/generated");
      expect(serializedInspect).not.toContain(".git");

      const manifestSearch = textJson(
        await callTool(
          port,
          credential.token,
          "code.search",
          { workspaceId: openedA.id, query: "package.json", mode: "path" },
          "req_full_semantic_manifest_search"
        )
      );
      expect(manifestSearch.matches).toContainEqual({ path: "package.json", kind: "path" });
      expect(manifestSearch.matches).toContainEqual({ path: "frontend/package.json", kind: "path" });
      const serializedManifestSearch = JSON.stringify(manifestSearch);
      expect(serializedManifestSearch).not.toContain("node_modules");
      expect(serializedManifestSearch).not.toContain(".worktrees");
      expect(serializedManifestSearch).not.toContain("target/generated");
      expect(serializedManifestSearch).not.toContain(".git");

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
        truncated: false,
        truncationReasons: []
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

      const verifyListResult = await callTool(
        port,
        credential.token,
        "verify.list",
        { workspaceId: openedA.id },
        "req_full_verify_list"
      );
      const verifyList = textJson(verifyListResult);
      expect(verifyListResult.structuredContent).toEqual(verifyList);
      expect(verifyList.recipes).toContainEqual({
        id: "package:test",
        label: "Package test",
        category: "test",
        logicalExecutable: "pnpm",
        argv: ["run", "test"],
        cwd: ".",
        source: "package-script",
        allowed: true
      });
      expect(verifyList.recipes).toContainEqual({
        id: "package:frontend:test",
        label: "Package test",
        category: "test",
        logicalExecutable: "pnpm",
        argv: ["run", "test"],
        cwd: "frontend",
        source: "package-script",
        allowed: true
      });
      expect(JSON.stringify(verifyList)).not.toContain("node_modules");
      expect(JSON.stringify(verifyList)).not.toContain(".worktrees");
      expect(JSON.stringify(verifyList)).not.toContain("target/generated");
      expect(JSON.stringify(verifyList)).not.toContain("/home/");
      expect(JSON.stringify(verifyList)).not.toContain("/usr/");

      const verifyRun = textJson(
        await callTool(
          port,
          credential.token,
          "verify.run",
          { workspaceId: openedA.id, recipeId: "package:test", background: false },
          "req_full_verify_run"
        )
      );
      expect(verifyRun, JSON.stringify(verifyRun)).toMatchObject({
        schemaVersion: 1,
        workspaceId: openedA.id,
        recipe: { id: "package:test", allowed: true },
        operation: { state: "completed", exitCode: 0 }
      });
      expect(verifyRun.operation.stdoutPreview).toContain("verify-ok");

      const contextBuildResult = await callTool(
        port,
        credential.token,
        "context.build",
        {
          workspaceId: openedA.id,
          intent: "review",
          target: "src/main.ts",
          maxBytes: 4_096
        },
        "req_full_context_build"
      );
      const contextBuild = textJson(contextBuildResult);
      expect(contextBuildResult.structuredContent).toEqual(contextBuild);
      expect(contextBuild).toMatchObject({
        schemaVersion: 1,
        intent: "review",
        target: "src/main.ts"
      });
      expect(contextBuild.selectedFiles[0]).toEqual({
        path: "src/main.ts",
        reason: "exact-target",
        content: "export function needle() {}\nneedle();\n",
        truncated: false
      });
      expect(contextBuild.selectedFiles).toContainEqual(
        expect.objectContaining({ path: "package.json", reason: "governing-manifest" })
      );
      expect(contextBuild.totalBytes).toBeLessThanOrEqual(4_096);
      const serializedContextBuild = JSON.stringify(contextBuild);
      expect(serializedContextBuild).not.toContain(workspaceA);
      expect(serializedContextBuild).not.toContain("node_modules");
      expect(serializedContextBuild).not.toContain(".worktrees");
      expect(serializedContextBuild).not.toContain("target/generated");

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
        summary: { changedFiles: 5 },
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
      expect(gitChanges.patchCoverage).toEqual({
        staged: true,
        worktree: true,
        untracked: false
      });
      expect(JSON.stringify(gitChanges)).not.toContain(workspaceA);

      await callTool(
        port,
        credential.token,
        "file.write",
        { workspaceId: openedA.id, path: "tracked.txt", content: "after second\n" },
        "req_full_write_second"
      );
      const gitChangesAfterContent = textJson(
        await callTool(
          port,
          credential.token,
          "git.changes",
          { workspaceId: openedA.id },
          "req_full_git_changes_after_content"
        )
      );
      expect(gitChangesAfterContent.changedPaths).toContainEqual({
        path: "tracked.txt",
        indexStatus: "A",
        worktreeStatus: "M"
      });
      expect(gitChangesAfterContent.fingerprint).not.toBe(gitChanges.fingerprint);

      const patchText = "--- a/tracked.txt\n+++ b/tracked.txt\n@@ -1 +1 @@\n-after second\n+after patched\n";
      const patchCheckResult = await callTool(
        port,
        credential.token,
        "file.patch",
        { workspaceId: openedA.id, patch: patchText },
        "req_full_patch_check"
      );
      const patchCheck = textJson(patchCheckResult);
      expect(patchCheckResult.structuredContent).toEqual(patchCheck);
      expect(patchCheck).toMatchObject({
        schemaVersion: 1,
        workspaceId: openedA.id,
        mode: "check",
        committedPaths: [],
        files: [{ path: "tracked.txt", action: "update", committed: false }]
      });
      expect(await readFile(join(workspaceA, "tracked.txt"), "utf8")).toBe("after second\n");

      const patchApplyResult = await callTool(
        port,
        credential.token,
        "file.patch",
        { workspaceId: openedA.id, patch: patchText, mode: "apply" },
        "req_full_patch_apply"
      );
      const patchApply = textJson(patchApplyResult);
      expect(patchApplyResult.structuredContent).toEqual(patchApply);
      expect(patchApply).toMatchObject({
        schemaVersion: 1,
        workspaceId: openedA.id,
        mode: "apply",
        committedPaths: ["tracked.txt"],
        files: [{ path: "tracked.txt", action: "update", committed: true }]
      });
      expect(await readFile(join(workspaceA, "tracked.txt"), "utf8")).toBe("after patched\n");
      expect(JSON.stringify(patchApply)).not.toContain(workspaceA);

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

      for (const smoke of [
        {
          logicalExecutable: "node",
          argv: ["-e", "console.log('kodegpt-node-smoke')"],
          marker: "kodegpt-node-smoke"
        },
        { logicalExecutable: "cargo", argv: ["--version"], marker: "cargo " },
        { logicalExecutable: "rustc", argv: ["--version"], marker: "rustc " }
      ]) {
        const result = textJson(
          await callTool(
            port,
            credential.token,
            "process.run",
            {
              workspaceId: openedA.id,
              logicalExecutable: smoke.logicalExecutable,
              argv: smoke.argv,
              background: false
            },
            `req_full_process_${smoke.logicalExecutable}`
          )
        );
        expect(result.state, JSON.stringify(result)).toBe("completed");
        expect(result.exitCode, JSON.stringify(result)).toBe(0);
        expect(result.stdoutPreview).toContain(smoke.marker);
      }

      const trustedShellScript = [
        "git --version",
        "printf 'shell-write\\n' > shell-created.txt",
        "printf 'HOME=%s\\nPATH=%s\\n' \"$HOME\" \"$PATH\"",
        `test ! -e ${JSON.stringify(hostOnlySecret)}`
      ].join("; ");
      const trustedShell = textJson(
        await callTool(
          port,
          credential.token,
          "process.run",
          {
            workspaceId: openedA.id,
            logicalExecutable: "bash",
            argv: ["--noprofile", "--norc", "-c", trustedShellScript],
            background: false
          },
          "req_full_process_trusted_shell"
        )
      );
      expect(trustedShell.state, JSON.stringify(trustedShell)).toBe("completed");
      expect(trustedShell.exitCode, JSON.stringify(trustedShell)).toBe(0);
      expect(trustedShell.stdoutPreview).toContain("git version");
      expect(trustedShell.stdoutPreview).toContain("HOME=/home/kodegpt");
      expect(trustedShell.stdoutPreview).toContain(
        "PATH=/opt/kodegpt-toolchain/bin:/opt/kodegpt-toolchain-1/bin:/usr/local/bin:/usr/bin:/bin"
      );
      expect(await readFile(join(workspaceA, "shell-created.txt"), "utf8")).toBe("shell-write\n");

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

  it("exercises all five Remote-CI tools through a fake provider with durable bounded audit and redaction", async () => {
    const stateRoot = await tempRoot("kodegpt-ci-full-state-");
    const workspace = await tempRoot("kodegpt-ci-full-workspace-");
    const fakeCredential = "fixture-ci-credential-value";
    const providerCalls: string[] = [];
    const oid = "a".repeat(40);
    const run = {
      id: "10",
      name: "Build commit",
      workflow: "CI",
      status: "COMPLETED" as const,
      conclusion: "SUCCESS" as const,
      headOid: oid,
      ref: "main",
      event: "push",
      url: "https://github.com/2ndworld/kodeGPT/actions/runs/10",
      createdAt: "2026-08-16T01:00:00.000Z",
      startedAt: "2026-08-16T01:00:01.000Z",
      updatedAt: "2026-08-16T01:01:00.000Z"
    };
    const failedJob = {
      id: "20",
      name: "test",
      status: "COMPLETED" as const,
      conclusion: "FAILURE" as const,
      startedAt: "2026-08-16T01:00:02.000Z",
      completedAt: "2026-08-16T01:00:50.000Z",
      url: "https://github.com/2ndworld/kodeGPT/runs/10/jobs/20",
      steps: [{
        number: 2,
        name: "Run tests",
        status: "COMPLETED" as const,
        conclusion: "FAILURE" as const,
        startedAt: "2026-08-16T01:00:10.000Z",
        completedAt: "2026-08-16T01:00:20.000Z"
      }]
    };
    const fakeProvider: RemoteCiAdapter = {
      repository: async () => {
        providerCalls.push("repository");
        return { defaultBranch: "main", providerRequests: 1 };
      },
      statusEvidence: async () => {
        providerCalls.push("status");
        return {
          checks: [],
          runs: [run],
          providerPageLimited: false,
          summaryLimitReached: false,
          providerRequests: 1
        };
      },
      runs: async () => {
        providerCalls.push("runs");
        return { items: [run], providerPageLimited: false, limitReached: false, providerRequests: 1 };
      },
      run: async () => {
        providerCalls.push("run");
        return {
          run,
          jobs: [],
          annotations: [],
          providerPageLimited: false,
          jobLimitReached: false,
          stepLimitReached: false,
          providerRequests: 2
        };
      },
      failureMetadata: async ({ selectJob }) => {
        providerCalls.push("failure-metadata");
        return {
          run: { ...run, conclusion: "FAILURE" as const },
          jobs: [failedJob],
          selectedJobId: selectJob([failedJob]),
          annotations: [{
            path: "src/index.ts",
            startLine: 10,
            endLine: 10,
            startColumn: null,
            endColumn: null,
            level: "FAILURE" as const,
            message: `failure mentions ${fakeCredential}`,
            title: "Failure"
          }],
          providerPageLimited: false,
          jobLimitReached: false,
          stepLimitReached: false,
          annotationLimitReached: false,
          providerRequests: 2
        };
      },
      failureLog: async () => {
        providerCalls.push("failure-log");
        return {
          bytes: new TextEncoder().encode(
            `Authorization: Bearer ${fakeCredential}\nGH_TOKEN=${fakeCredential}\nerror: assertion failed\n`
          ),
          truncated: false,
          providerRequests: 1
        };
      }
    };

    await writeFile(join(workspace, "tracked.txt"), "remote-ci\n");
    runGit(workspace, ["init", "-q"]);
    runGit(workspace, ["config", "user.name", "KodeGPT Test"]);
    runGit(workspace, ["config", "user.email", "kodegpt@example.invalid"]);
    runGit(workspace, ["add", "tracked.txt"]);
    runGit(workspace, ["commit", "-qm", "fixture"]);
    runGit(workspace, ["branch", "-M", "main"]);
    runGit(workspace, ["remote", "add", "origin", "https://github.com/2ndworld/kodeGPT.git"]);

    const trust = new WorkspaceTrustStore(stateRoot);
    const inspector = await KernelClient.start({ runtimePath: RUNTIME, stateRoot });
    try {
      const inspected = await inspector.request<InspectRootResult>("system.inspect_root", { path: workspace });
      await trust.trust({
        canonicalRoot: inspected.canonicalRoot,
        identity: inspected.identity,
        profileCeiling: "trusted"
      });
    } finally {
      await inspector.stop();
    }

    const credential = await new ConnectorCredentialStore(stateRoot).rotate();
    let operation = 0;
    const started = await startKodegpt(
      { runtimePath: RUNTIME, stateRoot, port: 43_130 },
      {
        ...defaultStartDependencies,
        createRemoteCi: (dependencies) => {
          const service = new RemoteCiService({
            resolver: new RemoteCiRepositoryResolver({
              selections: dependencies.selections,
              repository: dependencies.repository
            }),
            roots: dependencies.roots,
            revisions: dependencies.revisions,
            credentialProvider: {
              getCredential: async () => ({ source: "gh", token: fakeCredential })
            },
            adapterFactory: { create: () => fakeProvider },
            audit: dependencies.audit,
            operationIdFactory: () => `op_ci_full_${++operation}`
          });
          return {
            repository: (input) => service.repository(input),
            status: (input) => service.status(input),
            runs: (input) => service.runs(input),
            run: (input) => service.run(input),
            failure: (input) => service.failure(input)
          };
        }
      }
    );
    try {
      const port = started.status.port;
      const opened = textJson(
        await callTool(port, credential.token, "workspace.open", { rootPath: workspace }, "req_ci_open")
      );
      const repository = textJson(
        await callTool(port, credential.token, "ci.repository", { workspaceId: opened.id }, "req_ci_repository")
      );
      const status = textJson(await callTool(port, credential.token, "ci.status", {}, "req_ci_status"));
      const runs = textJson(
        await callTool(port, credential.token, "ci.runs", { workspaceId: opened.id }, "req_ci_runs")
      );
      const runDetail = textJson(
        await callTool(port, credential.token, "ci.run", { workspaceId: opened.id, runId: "10" }, "req_ci_run")
      );
      const failureResult = await callTool(
        port,
        credential.token,
        "ci.failure",
        { workspaceId: opened.id, runId: "10" },
        "req_ci_failure"
      );
      const failure = textJson(failureResult);

      expect(repository).toMatchObject({ provider: "github", repository: { fullName: "2ndworld/kodeGPT" } });
      expect(status).toMatchObject({ provider: "github", state: "PASS" });
      expect(runs.runs).toHaveLength(1);
      expect(runDetail).toMatchObject({ run: { id: "10" } });
      expect(failureResult.structuredContent).toEqual(failure);
      expect(JSON.stringify(failure)).not.toContain(fakeCredential);
      expect(JSON.stringify(failure)).not.toContain("Authorization: Bearer");
      expect(JSON.stringify(failure)).toContain("[REDACTED]");
      expect(providerCalls).toEqual([
        "repository",
        "status",
        "runs",
        "run",
        "failure-metadata",
        "failure-log"
      ]);

      const auditSource = await readFile(join(stateRoot, "logs/security/audit.jsonl"), "utf8");
      for (const action of ["ci_repository", "ci_status", "ci_runs", "ci_run", "ci_failure"]) {
        expect(auditSource).toContain(action);
      }
      expect(auditSource).toContain("2ndworld/kodeGPT");
      expect(auditSource).toContain("github");
      expect(auditSource).not.toContain(fakeCredential);
      expect(auditSource).not.toContain("Authorization: Bearer");
      expect(auditSource).not.toContain("assertion failed");
    } finally {
      await started.close();
    }
  }, 45_000);
});
