import { describe, expect, it } from "vitest";

const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

import { createHttpTrustConfig } from "../../packages/auth/src/http-trust.js";
import { createKodegptHttpHandler } from "../../packages/mcp-server/src/http.js";
import type { KodegptToolContext } from "../../packages/mcp-server/src/tool-context.js";

const gitResult = {
  schemaVersion: 1,
  exitCode: 0,
  stdoutPreview: "",
  stderrPreview: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  artifact: {
    schemaVersion: 1,
    artifactId: "ka_http",
    mediaType: "application/vnd.kodegpt.execution-stream",
    bytesWritten: 0,
    sourceTruncated: false
  }
};

const toolContext: KodegptToolContext = {
  workspace: {
    list: async () => [],
    open: async ({ rootPath }) => ({ id: "ws_test", canonicalRoot: rootPath }),
    close: async () => undefined,
    info: async ({ workspaceId }) => ({ id: workspaceId }),
    readFile: async () => ({ contents: "hello", bytesRead: 5, eof: true }),
    writeFile: async () => ({ bytesWritten: 5, created: true }),
    editFile: async () => ({ bytesWritten: 5, replacements: 1 }),
    search: async () => [],
    tree: async () => []
  },
  git: {
    status: async () => gitResult,
    diff: async () => gitResult
  },
  profile: {
    current: async () => ({ name: "observe" }),
    inspect: async ({ name }) => ({ name })
  },
  system: {
    capabilities: async () => ({ filesystemBoundaryAvailable: true }),
    health: async () => ({ ok: true })
  }
};

const trust = createHttpTrustConfig({
  allowedHosts: ["127.0.0.1:43121"],
  allowedOriginHosts: ["127.0.0.1:43121"],
  maxRequestBodyBytes: 64 * 1024
});

function meta(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
    [CLIENT_CAPABILITIES_META_KEY]: {},
    ...extra
  };
}

function discoverBody(id: string, requestMeta: Record<string, unknown> | null = meta()) {
  return {
    jsonrpc: "2.0",
    id,
    method: "server/discover",
    params: requestMeta === null ? {} : { _meta: requestMeta }
  };
}

async function post(
  handler: ReturnType<typeof createKodegptHttpHandler>,
  body: unknown,
  options: {
    host?: string | null;
    origin?: string;
    contentType?: string;
    authorization?: string;
    protocolVersion?: string;
    mcpMethod?: string;
    mcpName?: string;
  } = {}
): Promise<Response> {
  const text = JSON.stringify(body);
  const headers = new Headers({
    "content-type": options.contentType ?? "application/json",
    "content-length": String(Buffer.byteLength(text)),
    "mcp-protocol-version": options.protocolVersion ?? "2026-07-28",
    "mcp-method": options.mcpMethod ?? "server/discover"
  });
  if (options.host !== null) headers.set("host", options.host ?? "127.0.0.1:43121");
  if (options.origin !== undefined) headers.set("origin", options.origin);
  if (options.authorization !== undefined) headers.set("authorization", options.authorization);
  if (options.mcpName !== undefined) headers.set("mcp-name", options.mcpName);
  return handler.fetch(
    new Request("http://127.0.0.1:43121/mcp", {
      method: "POST",
      headers,
      body: text
    })
  );
}

function validAuthorization(): string {
  return ["Bear", "er", " accepted-by-test-authenticator"].join("");
}

function createHandler() {
  return createKodegptHttpHandler({
    toolContext,
    httpTrust: trust,
    bearerAuthenticator: {
      authenticate: async (authorization) => authorization === validAuthorization()
    }
  });
}

describe("strict MCP 2026-07-28 HTTP transport", () => {
  it("applies HTTP trust and bearer authentication before MCP dispatch", async () => {
    const handler = createHandler();
    try {
      expect((await post(handler, discoverBody("missing-auth"))).status).toBe(401);
      expect(
        (
          await post(handler, discoverBody("missing-host"), {
            host: null,
            authorization: validAuthorization()
          })
        ).status
      ).toBe(400);
      expect(
        (
          await post(handler, discoverBody("bad-host"), {
            host: "evil.example.test",
            authorization: validAuthorization()
          })
        ).status
      ).toBe(421);
      expect(
        (
          await post(handler, discoverBody("bad-origin"), {
            origin: "https://evil.example.test",
            authorization: validAuthorization()
          })
        ).status
      ).toBe(403);
      expect(
        (
          await post(handler, discoverBody("bad-media"), {
            contentType: "text/plain",
            authorization: validAuthorization()
          })
        ).status
      ).toBe(415);

      const oversized = " ".repeat(64 * 1024 + 1);
      const oversizedResponse = await handler.fetch(
        new Request("http://127.0.0.1:43121/mcp", {
          method: "POST",
          headers: {
            host: "127.0.0.1:43121",
            authorization: validAuthorization(),
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(oversized))
          },
          body: oversized
        })
      );
      expect(oversizedResponse.status).toBe(413);
    } finally {
      await handler.close();
    }
  });

  it("rejects malformed modern metadata and method/name header mismatches", async () => {
    const handler = createHandler();
    try {
      expect(
        (
          await post(handler, discoverBody("no-meta", null), {
            authorization: validAuthorization()
          })
        ).status
      ).toBe(400);
      expect(
        (
          await post(
            handler,
            discoverBody("no-cap", { [PROTOCOL_VERSION_META_KEY]: "2026-07-28" }),
            { authorization: validAuthorization() }
          )
        ).status
      ).toBe(400);
      expect(
        (
          await post(
            handler,
            discoverBody("version-mismatch", {
              [PROTOCOL_VERSION_META_KEY]: "2025-11-25",
              [CLIENT_CAPABILITIES_META_KEY]: {}
            }),
            { authorization: validAuthorization() }
          )
        ).status
      ).toBe(400);
      expect(
        (
          await post(handler, discoverBody("method-mismatch"), {
            authorization: validAuthorization(),
            mcpMethod: "tools/list"
          })
        ).status
      ).toBe(400);
      expect(
        (
          await post(
            handler,
            {
              jsonrpc: "2.0",
              id: "name-mismatch",
              method: "tools/call",
              params: {
                name: "system.health",
                arguments: {},
                _meta: meta()
              }
            },
            {
              authorization: validAuthorization(),
              mcpMethod: "tools/call",
              mcpName: "unexpected"
            }
          )
        ).status
      ).toBe(400);
    } finally {
      await handler.close();
    }
  });

  it("returns complete stateless discovery with optional valid clientInfo and no session id", async () => {
    const handler = createHandler();
    try {
      for (const [id, requestMeta] of [
        ["absent-client-info", meta()],
        [
          "valid-client-info",
          meta({
            [CLIENT_INFO_META_KEY]: { name: "KodeGPT test client", version: "0.1.0" }
          })
        ]
      ] as const) {
        const response = await post(handler, discoverBody(id, requestMeta), {
          authorization: validAuthorization()
        });
        expect(response.status).toBe(200);
        expect(response.headers.has("mcp-session-id")).toBe(false);
        const payload = (await response.json()) as Record<string, any>;
        expect(payload.result.supportedVersions).toEqual(["2026-07-28"]);
        expect(payload.result.resultType).toBe("complete");
        expect(payload.result._meta[SERVER_INFO_META_KEY]).toEqual({
          name: "KodeGPT",
          version: "0.1.0"
        });
      }

      const malformed = await post(
        handler,
        discoverBody(
          "bad-client-info",
          meta({ [CLIENT_INFO_META_KEY]: "not-an-object" })
        ),
        { authorization: validAuthorization() }
      );
      expect(malformed.status).toBe(400);
    } finally {
      await handler.close();
    }
  });

  it("exposes the locked semantic tools/list surface over modern HTTP", async () => {
    const handler = createHandler();
    try {
      const response = await post(
        handler,
        {
          jsonrpc: "2.0",
          id: "http-tools-list",
          method: "tools/list",
          params: { _meta: meta() }
        },
        {
          authorization: validAuthorization(),
          mcpMethod: "tools/list"
        }
      );
      expect(response.status).toBe(200);
      expect(response.headers.has("mcp-session-id")).toBe(false);
      const payload = (await response.json()) as Record<string, any>;
      expect(payload.result.resultType).toBe("complete");
      const tools = payload.result.tools as Array<Record<string, any>>;
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "file.edit",
        "file.read",
        "file.search",
        "file.tree",
        "file.write",
        "git.diff",
        "git.status",
        "profile.current",
        "profile.inspect",
        "system.capabilities",
        "system.health",
        "workspace.close",
        "workspace.info",
        "workspace.list",
        "workspace.open"
      ]);
      expect(tools.some((tool) => tool.name.includes("trust"))).toBe(false);
    } finally {
      await handler.close();
    }
  });

  it("rejects legacy GET and DELETE instead of exposing a session/SSE compatibility path", async () => {
    const handler = createHandler();
    try {
      for (const method of ["GET", "DELETE"]) {
        const response = await handler.fetch(
          new Request("http://127.0.0.1:43121/mcp", {
            method,
            headers: {
              host: "127.0.0.1:43121",
              authorization: validAuthorization()
            }
          })
        );
        expect(response.status).toBe(405);
        expect(response.headers.has("mcp-session-id")).toBe(false);
      }
    } finally {
      await handler.close();
    }
  });
});
