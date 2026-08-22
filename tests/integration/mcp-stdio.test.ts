import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { searchPublicActions } from "../../packages/capabilities/src/public-action-search.js";
import { rankSkillsForQuery } from "../../packages/skills/src/skill-search.js";
import { discoverKodegpt } from "../../packages/mcp-server/src/discovery.js";
import { serveKodegptStdio } from "../../packages/mcp-server/src/stdio.js";
import type { KodegptToolContext } from "../../packages/mcp-server/src/tool-context.js";
import {
  EXPECTED_MCP_REQUIRED_BY_NAME,
  EXPECTED_MCP_TOOL_NAMES
} from "../fixtures/mcp-surface.js";

const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

const remoteCiReadOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
};

const browserSessionAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
};

const remoteCiMutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
};

const remoteCiCancelAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
};

const remoteGitHubCreateAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
};

const remoteGitHubMergeAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
};

const lifecycleAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
};

const mutatingFileAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
};

const localGitMutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
};

const remoteGitFetchAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
};

const remoteGitMutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
};

const processRunAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
};

const processCancelAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false
};

const context: KodegptToolContext = {
  workspace: {
    list: async () => [],
    open: async ({ rootPath }) => ({ id: "ws_stdio", canonicalRoot: rootPath }),
    close: async () => ({ ok: true }),
    info: async ({ workspaceId }) => ({ id: workspaceId }),
    readFile: async () => ({ contents: "hello", bytesRead: 5, eof: true }),
    writeFile: async () => ({ bytesWritten: 5, created: true }),
    editFile: async () => ({ bytesWritten: 5, replacements: 1 }),
    search: async () => [],
    tree: async () => []
  },
  git: {
    status: async () => ({
      schemaVersion: 1,
      exitCode: 0,
      stdoutPreview: " M tracked.txt\n",
      stderrPreview: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      sourceTruncated: false,
      bytesSpooled: 15
    }),
    diff: async () => ({
      schemaVersion: 1,
      exitCode: 0,
      stdoutPreview: "diff --git a/tracked.txt b/tracked.txt\n",
      stderrPreview: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      sourceTruncated: false,
      bytesSpooled: 40
    })
  },
  process: {
    run: async () => ({
      schemaVersion: 1,
      operationId: "op_stdio",
      state: "completed",
      exitCode: 0,
      stdoutPreview: "",
      stderrPreview: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      sourceTruncated: false,
      bytesSpooled: 0
    }),
    status: async () => ({
      schemaVersion: 1,
      operationId: "op_stdio",
      state: "completed",
      exitCode: 0,
      stdoutPreview: "",
      stderrPreview: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      sourceTruncated: false,
      bytesSpooled: 0
    }),
    cancel: async () => ({
      schemaVersion: 1,
      operationId: "op_stdio",
      state: "cancelled",
      stdoutPreview: "",
      stderrPreview: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      sourceTruncated: false,
      bytesSpooled: 0
    })
  },
  profile: {
    current: async () => ({ name: "observe" }),
    inspect: async ({ name }) => ({ name })
  },
  code: {
    search: async ({ query, mode }) => ({
      schemaVersion: 1,
      mode: mode ?? "text",
      precision: mode === "definition" || mode === "reference" || mode === "symbol" ? "structural" : "exact",
      matches: [
        {
          path: "src/main.ts",
          line: 3,
          column: 17,
          kind: mode ?? "text",
          preview: `export function ${query}() {}`
        }
      ],
      truncated: false,
      truncationReasons: []
    }),
    impact: async ({ target, kind }) => ({
      schemaVersion: 1,
      target: { kind: kind === "file" ? "file" : "symbol", value: target, resolvedPaths: ["src/main.ts"] },
      dependents: [],
      relatedTests: [],
      affectedAreas: ["src"],
      truncated: false,
      truncationReasons: []
    })
  },
  context: {
    build: async ({ workspaceId, intent, target }) => ({
      schemaVersion: 1,
      intent,
      ...(target === undefined ? {} : { target }),
      evidenceStatus: {
        workspace: "available",
        git: "available",
        search: "available",
        verification: "available"
      },
      workspace: {
        schemaVersion: 1,
        workspaceId,
        root: ".",
        scope: target === undefined ? { kind: "workspace" as const } : { kind: "target" as const, area: "src" },
        projectTypes: ["node-pnpm"],
        languages: [{ name: "TypeScript", fileCount: 1 }],
        entrypoints: [],
        areas: [],
        manifests: [],
        warnings: [],
        truncated: false
      },
      git: {
        schemaVersion: 1,
        workspaceId,
        clean: true,
        changedPaths: [],
        summary: { changedFiles: 0 },
        truncated: false,
        fingerprint: "a".repeat(64),
        sourceState: {
          headOid: "1".repeat(40),
          changesFingerprint: "a".repeat(64)
        }
      },
      selectedFiles: [
        {
          path: target ?? "src/main.ts",
          reason: "exact-target",
          content: "export function calculateInvoice() {}\n",
          region: { startLine: 3, endLine: 3 },
          truncated: false
        }
      ],
      relevantMatches: [],
      verifications: [],
      warnings: [],
      totalBytes: 38,
      truncated: false
    })
  },
  system: {
    capabilities: async () => ({ filesystemBoundaryAvailable: true }),
    discover: async (input) =>
      discoverKodegpt(input, {
        searchActions: searchPublicActions,
        rankSkills: rankSkillsForQuery,
        listSkills: async () => ({ schemaVersion: 1, skills: [], truncated: false, truncationReasons: [] }),
        inspectSkill: async () => {
          throw new Error("no skill candidates");
        },
        workspaceInfo: async ({ workspaceId }) => ({ id: workspaceId } as never)
      }),
    health: async () => ({ ok: true })
  }
};

function meta(): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
    [CLIENT_CAPABILITIES_META_KEY]: {}
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

describe("strict MCP 2026-07-28 stdio transport", () => {
  it("uses modern discovery and the same locked tools/list registry", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const handle = serveKodegptStdio(context, { stdin, stdout });
    try {
      const discoverResponse = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "stdio-discover",
        method: "server/discover",
        params: { _meta: meta() }
      });
      const discovered = await discoverResponse;
      expect(discovered.result.supportedVersions).toEqual(["2026-07-28"]);
      expect(discovered.result.resultType).toBe("complete");
      expect(discovered.result._meta[SERVER_INFO_META_KEY]).toEqual({
        name: "KodeGPT",
        version: "0.1.0"
      });

      const toolsResponse = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "stdio-tools",
        method: "tools/list",
        params: { _meta: meta() }
      });
      const payload = await toolsResponse;
      expect(payload.result.resultType).toBe("complete");
      const tools = payload.result.tools as Array<Record<string, any>>;
      expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_MCP_TOOL_NAMES].sort());
      expect(tools.filter((tool) => tool.name.includes("trust")).map((tool) => tool.name)).toEqual([
        "trust.list",
        "workspace.trust",
        "workspace.untrust"
      ]);

      for (const tool of tools) {
        if (
          tool.name === "workspace.open" ||
          tool.name === "workspace.close" ||
          tool.name === "workspace.checkpoint" ||
          tool.name === "workspace.trust" ||
          tool.name === "workspace.untrust"
        ) {
          expect(tool.annotations).toEqual(lifecycleAnnotations);
        } else if (
          tool.name === "file.write" ||
          tool.name === "file.edit" ||
          tool.name === "file.patch"
        ) {
          expect(tool.annotations).toEqual(mutatingFileAnnotations);
        } else if (
          tool.name === "git.stage" ||
          tool.name === "git.commit" ||
          tool.name === "git.branchCreate" ||
          tool.name === "git.branchSwitch" ||
          tool.name === "git.branchDelete" ||
          tool.name === "git.worktreeCreate" ||
          tool.name === "git.worktreeRemove"
        ) {
          expect(tool.annotations).toEqual(localGitMutationAnnotations);
        } else if (tool.name === "git.fetch") {
          expect(tool.annotations).toEqual(remoteGitFetchAnnotations);
        } else if (tool.name === "git.pull" || tool.name === "git.push") {
          expect(tool.annotations).toEqual(remoteGitMutationAnnotations);
        } else if (
          tool.name === "process.run" ||
          tool.name === "verify.run" ||
          tool.name === "preview.start"
        ) {
          expect(tool.annotations).toEqual(processRunAnnotations);
        } else if (tool.name === "process.cancel" || tool.name === "preview.stop") {
          expect(tool.annotations).toEqual(processCancelAnnotations);
        } else if (tool.name === "browser.openPreview") {
          expect(tool.annotations).toEqual(browserSessionAnnotations);
        } else if (tool.name === "browser.click" || tool.name === "browser.type") {
          expect(tool.annotations).toEqual(remoteCiCancelAnnotations);
        } else if (
          tool.name === "browser.screenshot" ||
          tool.name === "visual.captureMatrix" ||
          tool.name === "visual.compare"
        ) {
          expect(tool.annotations).toEqual(remoteCiMutationAnnotations);
        } else if (tool.name.startsWith("browser.")) {
          expect(tool.annotations).toEqual(remoteCiReadOnlyAnnotations);
        } else if (tool.name === "github.pr.create" || tool.name === "github.pr.feedback.reply") {
          expect(tool.annotations).toEqual(remoteGitHubCreateAnnotations);
        } else if (tool.name === "github.pr.merge") {
          expect(tool.annotations).toEqual(remoteGitHubMergeAnnotations);
        } else if (tool.name === "ci.rerun" || tool.name === "ci.dispatch") {
          expect(tool.annotations).toEqual(remoteCiMutationAnnotations);
        } else if (tool.name === "ci.cancel") {
          expect(tool.annotations).toEqual(remoteCiCancelAnnotations);
        } else if (
          tool.name.startsWith("ci.") ||
          tool.name.startsWith("github.")
        ) {
          expect(tool.annotations).toEqual(remoteCiReadOnlyAnnotations);
        } else {
          expect(tool.annotations).toEqual(readOnlyAnnotations);
        }
      }

      const required = Object.fromEntries(
        tools.map((tool) => [tool.name, tool.inputSchema.required ?? []])
      );
      expect(required).toEqual(EXPECTED_MCP_REQUIRED_BY_NAME);

      const mobileDiscoverResponse = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "stdio-system-discover-mobile",
        method: "tools/call",
        params: {
          name: "system.discover",
          arguments: { query: "cek tampilan mobile", workspaceId: "ws_stdio" },
          _meta: meta()
        }
      });
      const mobileDiscoverPayload = await mobileDiscoverResponse;
      const mobileDiscovery = JSON.parse(mobileDiscoverPayload.result.content[0].text);
      expect(mobileDiscovery.actions.slice(0, 3).map((match: { id: string }) => match.id)).toContain(
        "visual.captureMatrix"
      );

      const resumeDiscoverResponse = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "stdio-system-discover-resume",
        method: "tools/call",
        params: {
          name: "system.discover",
          arguments: { query: "lanjutkan pekerjaan sebelumnya" },
          _meta: meta()
        }
      });
      const resumeDiscoverPayload = await resumeDiscoverResponse;
      const resumeDiscovery = JSON.parse(resumeDiscoverPayload.result.content[0].text);
      const resumeAction = resumeDiscovery.actions[0];
      expect(resumeAction?.id).toBe("context.build");
      expect(resumeAction?.availability).toEqual({
        status: "CONTEXT_REQUIRED",
        reasons: ["WORKSPACE_REQUIRED"]
      });

      const exactBoundResponse = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "stdio-system-discover-512",
        method: "tools/call",
        params: {
          name: "system.discover",
          arguments: { query: "x".repeat(512) },
          _meta: meta()
        }
      });
      const exactBoundPayload = await exactBoundResponse;
      expect(exactBoundPayload.error).toBeUndefined();
      expect(JSON.parse(exactBoundPayload.result.content[0].text)).toMatchObject({
        schemaVersion: 1,
        query: "x".repeat(512)
      });

      const overByteResponse = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "stdio-system-discover-over-byte",
        method: "tools/call",
        params: {
          name: "system.discover",
          arguments: { query: "é".repeat(300) },
          _meta: meta()
        }
      });
      const overBytePayload = await overByteResponse;
      expect(overBytePayload.error ?? overBytePayload.result?.isError).toBeTruthy();

      const structuralSearchResponse = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "stdio-structural-search",
        method: "tools/call",
        params: {
          name: "code.search",
          arguments: {
            workspaceId: "ws_stdio",
            query: "calculateInvoice",
            mode: "definition"
          },
          _meta: meta()
        }
      });
      const structuralSearchPayload = await structuralSearchResponse;
      expect(JSON.parse(structuralSearchPayload.result.content[0].text)).toMatchObject({
        schemaVersion: 1,
        mode: "definition",
        precision: "structural",
        matches: [{ path: "src/main.ts", line: 3, kind: "definition" }]
      });

      const focusedContextResponse = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "stdio-focused-context",
        method: "tools/call",
        params: {
          name: "context.build",
          arguments: {
            workspaceId: "ws_stdio",
            intent: "implement",
            target: "src/main.ts",
            focus: "calculateInvoice"
          },
          _meta: meta()
        }
      });
      const focusedContextPayload = await focusedContextResponse;
      expect(JSON.parse(focusedContextPayload.result.content[0].text)).toMatchObject({
        schemaVersion: 1,
        intent: "implement",
        target: "src/main.ts",
        selectedFiles: [
          {
            path: "src/main.ts",
            reason: "exact-target",
            region: { startLine: 3, endLine: 3 },
            truncated: false
          }
        ]
      });

      const writeResponse = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "stdio-write",
        method: "tools/call",
        params: {
          name: "file.write",
          arguments: { workspaceId: "ws_stdio", path: "created.txt", content: "hello" },
          _meta: meta()
        }
      });
      const writePayload = await writeResponse;
      expect(JSON.parse(writePayload.result.content[0].text)).toEqual({
        bytesWritten: 5,
        created: true
      });

      const editResponse = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "stdio-edit",
        method: "tools/call",
        params: {
          name: "file.edit",
          arguments: {
            workspaceId: "ws_stdio",
            path: "created.txt",
            oldText: "hello",
            newText: "world",
            expectedReplacements: 1
          },
          _meta: meta()
        }
      });
      const editPayload = await editResponse;
      expect(JSON.parse(editPayload.result.content[0].text)).toEqual({
        bytesWritten: 5,
        replacements: 1
      });

      for (const name of ["git.status", "git.diff"] as const) {
        const gitResponse = nextMessage(stdout);
        writeMessage(stdin, {
          jsonrpc: "2.0",
          id: `stdio-${name}`,
          method: "tools/call",
          params: {
            name,
            arguments: { workspaceId: "ws_stdio" },
            _meta: meta()
          }
        });
        const gitPayload = await gitResponse;
        const result = JSON.parse(gitPayload.result.content[0].text);
        expect(result).toMatchObject({
          schemaVersion: 1,
          exitCode: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          sourceTruncated: false
        });
        expect(JSON.stringify(result)).not.toContain("ka_");
        expect(result).not.toHaveProperty("artifact");
        expect(result).not.toHaveProperty("pid");
        expect(result).not.toHaveProperty("processGroup");
      }
    } finally {
      await handle.close();
    }
  });

  it("rejects a legacy initialize request instead of negotiating a compatibility session", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const handle = serveKodegptStdio(context, { stdin, stdout });
    try {
      const responsePromise = nextMessage(stdout);
      writeMessage(stdin, {
        jsonrpc: "2.0",
        id: "legacy-init",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "legacy", version: "1" }
        }
      });
      const response = await responsePromise;
      expect(response.error).toBeDefined();
      expect(response.result).toBeUndefined();
    } finally {
      await handle.close();
    }
  });
});
