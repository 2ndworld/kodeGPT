import type { IncomingMessage, ServerResponse } from "node:http";

import {
  HttpTrustError,
  enforceHttpRequestTrust,
  type HttpTrustConfig
} from "@kodegpt/auth";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { createKodegptMcpServer } from "./server.js";
import type { KodegptToolContext } from "./tool-context.js";

export interface BearerAuthenticator {
  authenticate(authorization: string | undefined): Promise<boolean>;
}

export interface ResolvedHttpCredential {
  authorization: string | undefined;
  forwardedUrl: string;
}

export function resolveHttpCredential(
  request: Request,
  queryCredentialCompatibility: boolean
): ResolvedHttpCredential | null {
  const authorization = request.headers.get("authorization") ?? undefined;
  const url = new URL(request.url);
  const queryValues = url.searchParams.getAll("kodegpt_token");

  if (!queryCredentialCompatibility) {
    if (queryValues.length > 0) url.searchParams.delete("kodegpt_token");
    return { authorization, forwardedUrl: url.toString() };
  }

  if (queryValues.length > 0 && url.pathname !== "/mcp") return null;
  if (queryValues.length > 1) return null;
  if (queryValues.length === 1 && authorization !== undefined) return null;
  if (queryValues.length === 1) {
    const credentialValue = queryValues[0];
    if (credentialValue === undefined) return null;
    url.searchParams.delete("kodegpt_token");
    return {
      authorization: ["Bear", "er ", credentialValue].join(""),
      forwardedUrl: url.toString()
    };
  }

  return { authorization, forwardedUrl: url.toString() };
}

export interface KodegptHttpHandler {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export function createKodegptHttpHandler(options: {
  toolContext: KodegptToolContext;
  httpTrust: HttpTrustConfig;
  bearerAuthenticator: BearerAuthenticator;
  queryCredentialCompatibility?: boolean;
}): KodegptHttpHandler {
  const mcp = createMcpHandler(
    () => createKodegptMcpServer(options.toolContext),
    { legacy: "reject" }
  );

  return {
    async fetch(request: Request): Promise<Response> {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "POST" }
        });
      }

      let bytes: Uint8Array;
      try {
        bytes = await readBoundedBody(request, options.httpTrust.maxRequestBodyBytes);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          return jsonError(413, "HTTP_BODY_TOO_LARGE");
        }
        throw error;
      }
      try {
        enforceHttpRequestTrust(options.httpTrust, {
          host: request.headers.get("host") ?? undefined,
          origin: request.headers.get("origin") ?? undefined,
          contentType: request.headers.get("content-type") ?? undefined,
          contentLength: request.headers.get("content-length") ?? undefined,
          actualBodyBytes: bytes.byteLength
        });
      } catch (error) {
        if (error instanceof HttpTrustError) {
          return jsonError(error.status, error.code);
        }
        throw error;
      }

      const credential = resolveHttpCredential(
        request,
        options.queryCredentialCompatibility ?? false
      );
      if (
        credential === null ||
        !(await options.bearerAuthenticator.authenticate(credential.authorization))
      ) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "www-authenticate": "Bearer" }
        });
      }

      const forwardedBody = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(forwardedBody).set(bytes);
      const forwarded = new Request(credential.forwardedUrl, {
        method: "POST",
        headers: request.headers,
        body: forwardedBody,
        signal: request.signal
      });
      return mcp.fetch(forwarded);
    },
    async close(): Promise<void> {
      await mcp.close();
    }
  };
}

export function createKodegptNodeHandler(options: {
  toolContext: KodegptToolContext;
  httpTrust: HttpTrustConfig;
  bearerAuthenticator: BearerAuthenticator;
  queryCredentialCompatibility?: boolean;
}): {
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  close: () => Promise<void>;
} {
  const http = createKodegptHttpHandler(options);
  const handler = toNodeHandler(http);
  return {
    handler: async (request, response) => handler(request, response),
    close: () => http.close()
  };
}

class RequestBodyTooLargeError extends Error {}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (request.body === null) {
    return new Uint8Array();
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function jsonError(status: number, code: string): Response {
  return Response.json(
    {
      error: code
    },
    { status }
  );
}
