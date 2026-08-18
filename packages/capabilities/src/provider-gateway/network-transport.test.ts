import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ProviderAdapterManifest, ProviderRequestBudget } from "./contracts.js";
import { DefaultProviderNetworkTransport, type ProviderHttpsRequestInput } from "./network-transport.js";

function manifest(input: {
  redirect?: { fromOrigin: string; toOrigin: string } | null;
  method?: "POST" | "PUT";
} = {}): ProviderAdapterManifest {
  const origins = input.redirect === undefined || input.redirect === null
    ? ["https://api.fixture.example"]
    : [input.redirect.fromOrigin, input.redirect.toOrigin];
  return {
    adapterId: "test.fixture.read.v1",
    adapterContractVersion: "1",
    implementationDigest: "a".repeat(64),
    inventoryMode: "STATIC",
    networkPolicy: {
      kind: "internet",
      origins,
      redirect: input.redirect ?? null
    },
    credentialBroker: { kind: "none" },
    operations: [{
      id: "record.read",
      method: input.method ?? "POST",
      origin: origins[0]!,
      pathTemplate: "/records/{recordId}",
      allowedQueryKeys: ["view"],
      fixedHeaders: { accept: "application/json", "content-type": "application/json" },
      inputSchema: z.object({
        recordId: z.string().min(1),
        view: z.string().optional(),
        payload: z.unknown().optional()
      }).strict(),
      encodeRequest: (value) => {
        const typed = value as { recordId: string; view?: string; payload?: unknown };
        const query: Record<string, string> = {};
        if (typed.view !== undefined) query.view = typed.view;
        return {
          pathParameters: { recordId: typed.recordId },
          query,
          body: typed.payload
        };
      }
    }],
    mappings: []
  };
}

function budget(): ProviderRequestBudget & { claimRequest: ReturnType<typeof vi.fn> } {
  return { claimRequest: vi.fn() };
}

describe("DefaultProviderNetworkTransport", () => {
  it("connects only to the prevalidated address while preserving TLS hostname", async () => {
    const calls: ProviderHttpsRequestInput[] = [];
    const resolver = { lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 as const }]) };
    const requester = { request: vi.fn(async (input: ProviderHttpsRequestInput) => {
      calls.push(input);
      return { statusCode: 200, headers: {}, body: Buffer.from("{\"ok\":true}") };
    }) };
    const requestBudget = budget();
    const transport = new DefaultProviderNetworkTransport({ resolver, requester });

    const result = await transport.request({
      manifest: manifest(),
      operationId: "record.read",
      operationInput: { recordId: "42", view: "compact", payload: { x: 1 } },
      credential: { kind: "bearer", value: "credential-canary" },
      signal: new AbortController().signal,
      budget: requestBudget
    });

    expect(resolver.lookup).toHaveBeenCalledWith("api.fixture.example");
    expect(requestBudget.claimRequest).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      address: "203.0.113.10",
      family: 4,
      hostname: "api.fixture.example",
      servername: "api.fixture.example",
      port: 443,
      method: "POST",
      path: "/records/42?view=compact"
    });
    expect(calls[0]?.headers.authorization).toBe("Bearer credential-canary");
    expect(calls[0]?.body?.toString("utf8")).toBe('{"x":1}');
    expect(result.statusCode).toBe(200);
    expect(result.body.toString("utf8")).toBe('{"ok":true}');
  });

  it("preserves a compiled PUT method without exposing method selection to callers", async () => {
    const calls: ProviderHttpsRequestInput[] = [];
    const transport = new DefaultProviderNetworkTransport({
      resolver: { lookup: async () => [{ address: "203.0.113.10", family: 4 as const }] },
      requester: { request: async (input: ProviderHttpsRequestInput) => {
        calls.push(input);
        return { statusCode: 200, headers: {}, body: Buffer.from("{\"ok\":true}") };
      } }
    });

    await transport.request({
      manifest: manifest({ method: "PUT" }),
      operationId: "record.read",
      operationInput: { recordId: "42", payload: { ok: true } },
      credential: null,
      signal: new AbortController().signal,
      budget: budget()
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PUT");
  });

  it("rejects private DNS answers before any request is created", async () => {
    const requester = { request: vi.fn() };
    const transport = new DefaultProviderNetworkTransport({
      resolver: { lookup: async () => [{ address: "127.0.0.1", family: 4 as const }] },
      requester
    });
    await expect(transport.request({
      manifest: manifest(),
      operationId: "record.read",
      operationInput: { recordId: "42" },
      credential: null,
      signal: new AbortController().signal,
      budget: budget()
    })).rejects.toMatchObject({ code: "PROVIDER_NETWORK_DENIED" });
    expect(requester.request).not.toHaveBeenCalled();
  });

  it("rejects traversal/control input, unapproved query keys, and oversized request bodies", async () => {
    const requester = { request: vi.fn() };
    const transport = new DefaultProviderNetworkTransport({
      resolver: { lookup: async () => [{ address: "203.0.113.10", family: 4 as const }] },
      requester
    });
    const base = {
      manifest: manifest(), operationId: "record.read", credential: null,
      signal: new AbortController().signal, budget: budget()
    };
    await expect(transport.request({ ...base, operationInput: { recordId: ".." } }))
      .rejects.toMatchObject({ code: "PROVIDER_INPUT_INVALID" });

    const badManifest = manifest();
    badManifest.operations[0]!.encodeRequest = () => ({ query: { unapproved: "x" } });
    await expect(transport.request({ ...base, manifest: badManifest, operationInput: { recordId: "42" } }))
      .rejects.toMatchObject({ code: "PROVIDER_INPUT_INVALID" });

    await expect(transport.request({ ...base, operationInput: { recordId: "42", payload: "x".repeat(256 * 1024 + 1) } }))
      .rejects.toMatchObject({ code: "PROVIDER_INPUT_INVALID" });
    expect(requester.request).not.toHaveBeenCalled();
  });

  it("denies redirects by default and permits exactly one compiled cross-origin hop without credentials", async () => {
    const firstCalls: ProviderHttpsRequestInput[] = [];
    const denyRequester = { request: vi.fn(async (input: ProviderHttpsRequestInput) => {
      firstCalls.push(input);
      return { statusCode: 302, headers: { location: "https://redirect.fixture.example/next" }, body: Buffer.alloc(0) };
    }) };
    const resolver = { lookup: async () => [{ address: "203.0.113.10", family: 4 as const }] };
    const denyTransport = new DefaultProviderNetworkTransport({ resolver, requester: denyRequester });
    await expect(denyTransport.request({
      manifest: manifest(), operationId: "record.read", operationInput: { recordId: "42" },
      credential: { kind: "bearer", value: "credential-canary" }, signal: new AbortController().signal, budget: budget()
    })).rejects.toMatchObject({ code: "PROVIDER_NETWORK_DENIED" });

    const calls: ProviderHttpsRequestInput[] = [];
    const allowRequester = { request: vi.fn(async (input: ProviderHttpsRequestInput): Promise<{
      statusCode: number;
      headers: Readonly<Record<string, string | readonly string[]>>;
      body: Buffer;
    }> => {
      calls.push(input);
      if (calls.length === 1) {
        return { statusCode: 302, headers: { location: "https://redirect.fixture.example/next" }, body: Buffer.alloc(0) };
      }
      return { statusCode: 200, headers: {}, body: Buffer.from("ok") };
    }) };
    const requestBudget = budget();
    const allowTransport = new DefaultProviderNetworkTransport({ resolver, requester: allowRequester });
    await expect(allowTransport.request({
      manifest: manifest({ redirect: { fromOrigin: "https://api.fixture.example", toOrigin: "https://redirect.fixture.example" } }),
      operationId: "record.read", operationInput: { recordId: "42" },
      credential: { kind: "bearer", value: "credential-canary" }, signal: new AbortController().signal, budget: requestBudget
    })).resolves.toMatchObject({ statusCode: 200 });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.authorization).toBe("Bearer credential-canary");
    expect(calls[1]?.hostname).toBe("redirect.fixture.example");
    expect(calls[1]?.path).toBe("/next");
    expect(calls[1]?.headers.authorization).toBeUndefined();
    expect(requestBudget.claimRequest).toHaveBeenCalledTimes(2);
  });

  it("maps rate limits, auth rejection, response overflow, cancellation, and transport failures", async () => {
    const resolver = { lookup: async () => [{ address: "203.0.113.10", family: 4 as const }] };
    const run = async (response: unknown, credential: { kind: "bearer"; value: string } | null = null) => {
      const transport = new DefaultProviderNetworkTransport({
        resolver,
        requester: { request: async () => response as never }
      });
      return transport.request({ manifest: manifest(), operationId: "record.read", operationInput: { recordId: "42" }, credential, signal: new AbortController().signal, budget: budget() });
    };
    await expect(run({ statusCode: 429, headers: {}, body: Buffer.alloc(0) })).rejects.toMatchObject({
      code: "PROVIDER_RATE_LIMITED",
      details: {
        reason: "RATE_LIMITED",
        retryable: true,
        suggestedAction: "retry"
      }
    });
    await expect(run({ statusCode: 401, headers: {}, body: Buffer.alloc(0) }, { kind: "bearer", value: "x" })).rejects.toMatchObject({
      code: "PROVIDER_CREDENTIAL_REJECTED",
      details: {
        reason: "AUTHENTICATION_REQUIRED",
        retryable: false,
        suggestedAction: "authenticate"
      }
    });
    await expect(run({ statusCode: 200, headers: {}, body: Buffer.alloc(2 * 1024 * 1024 + 1) })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });

    const aborted = new AbortController();
    aborted.abort();
    const transport = new DefaultProviderNetworkTransport({ resolver, requester: { request: vi.fn() } });
    await expect(transport.request({ manifest: manifest(), operationId: "record.read", operationInput: { recordId: "42" }, credential: null, signal: aborted.signal, budget: budget() }))
      .rejects.toMatchObject({ code: "PROVIDER_CANCELLED" });
  });
});
