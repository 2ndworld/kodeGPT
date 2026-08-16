import { describe, expect, it } from "vitest";

import { ProviderAdapterRegistry } from "./adapter-registry.js";
import { GITHUB_READ_PROVIDER_MANIFEST } from "./github.js";

const REPOSITORY = "2ndworld/kodeGPT";
const AUTHORITY_FIELDS = [
  "url",
  "uri",
  "host",
  "hostname",
  "origin",
  "path",
  "method",
  "query",
  "headers",
  "authorization",
  "token",
  "graphql",
  "command"
] as const;

function mapping(semanticCapabilityId: string) {
  const found = GITHUB_READ_PROVIDER_MANIFEST.mappings.find(
    (candidate) => candidate.semanticCapabilityId === semanticCapabilityId
  );
  if (found === undefined) throw new Error(`missing mapping ${semanticCapabilityId}`);
  return found;
}

function operation(id: string) {
  const found = GITHUB_READ_PROVIDER_MANIFEST.operations.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing operation ${id}`);
  return found;
}

describe("github.read.v1 provider adapter", () => {
  it("defines one static read-only GitHub adapter contract with fixed credential policy", () => {
    expect(GITHUB_READ_PROVIDER_MANIFEST.adapterId).toBe("github.read.v1");
    expect(GITHUB_READ_PROVIDER_MANIFEST.adapterContractVersion).toBe("1");
    expect(GITHUB_READ_PROVIDER_MANIFEST.implementationDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(GITHUB_READ_PROVIDER_MANIFEST.inventoryMode).toBe("STATIC");
    expect(GITHUB_READ_PROVIDER_MANIFEST.networkPolicy).toEqual({
      kind: "internet",
      origins: ["https://api.github.com"],
      redirect: null
    });
    expect(GITHUB_READ_PROVIDER_MANIFEST.credentialBroker).toEqual({
      kind: "external-helper",
      credentialKind: "bearer",
      argv: ["auth", "token"],
      environment: {}
    });
  });

  it("compiles exactly three GET operations and exactly three remote-read semantic mappings", () => {
    expect(GITHUB_READ_PROVIDER_MANIFEST.operations.map(({ id, method, origin, pathTemplate }) => ({
      id,
      method,
      origin,
      pathTemplate
    }))).toEqual([
      {
        id: "repository.inspect",
        method: "GET",
        origin: "https://api.github.com",
        pathTemplate: "/repos/{owner}/{repo}"
      },
      {
        id: "pr.inspect",
        method: "GET",
        origin: "https://api.github.com",
        pathTemplate: "/repos/{owner}/{repo}/pulls/{number}"
      },
      {
        id: "pr.list",
        method: "GET",
        origin: "https://api.github.com",
        pathTemplate: "/repos/{owner}/{repo}/pulls"
      }
    ]);

    expect(GITHUB_READ_PROVIDER_MANIFEST.mappings.map((candidate) => ({
      semanticCapabilityId: candidate.semanticCapabilityId,
      adapterOperationId: candidate.adapterOperationId,
      effect: candidate.effect,
      workspaceBinding: candidate.workspaceBinding,
      maxProviderRequests: candidate.maxProviderRequests,
      retry: candidate.retry
    }))).toEqual([
      {
        semanticCapabilityId: "github.repository.inspect",
        adapterOperationId: "repository.inspect",
        effect: "REMOTE_READ",
        workspaceBinding: "NONE",
        maxProviderRequests: 1,
        retry: "none"
      },
      {
        semanticCapabilityId: "github.pr.inspect",
        adapterOperationId: "pr.inspect",
        effect: "REMOTE_READ",
        workspaceBinding: "NONE",
        maxProviderRequests: 1,
        retry: "none"
      },
      {
        semanticCapabilityId: "github.pr.list",
        adapterOperationId: "pr.list",
        effect: "REMOTE_READ",
        workspaceBinding: "NONE",
        maxProviderRequests: 1,
        retry: "none"
      }
    ]);
  });

  it("uses only reviewed fixed GitHub metadata headers and query keys", () => {
    const expectedHeaders = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2026-03-10",
      "user-agent": "KodeGPT/0.1 Provider-GitHub-Read"
    };
    for (const candidate of GITHUB_READ_PROVIDER_MANIFEST.operations) {
      expect(candidate.fixedHeaders).toEqual(expectedHeaders);
      expect(Object.keys(candidate.fixedHeaders).some((name) => /^authorization$/i.test(name))).toBe(false);
    }
    expect(operation("repository.inspect").allowedQueryKeys).toEqual([]);
    expect(operation("pr.inspect").allowedQueryKeys).toEqual([]);
    expect(operation("pr.list").allowedQueryKeys).toEqual(["state", "per_page"]);
  });

  it("accepts one bounded owner/name repository and rejects malformed authority-like repository values", () => {
    expect(mapping("github.repository.inspect").inputSchema.safeParse({ repository: REPOSITORY }).success).toBe(true);
    for (const repository of [
      "https://github.com/2ndworld/kodeGPT",
      "2ndworld/kodeGPT/extra",
      "../kodeGPT",
      "2ndworld/",
      "/kodeGPT",
      "owner?x/repo",
      "owner/repo#x",
      " owner/repo",
      "owner/repo ",
      "owner/re\npo"
    ]) {
      expect(mapping("github.repository.inspect").inputSchema.safeParse({ repository }).success, repository).toBe(false);
    }
  });

  it("bounds PR numbers to positive 32-bit-safe integers", () => {
    const schema = mapping("github.pr.inspect").inputSchema;
    expect(schema.safeParse({ repository: REPOSITORY, number: 16 }).success).toBe(true);
    for (const number of [0, -1, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1]) {
      expect(schema.safeParse({ repository: REPOSITORY, number }).success, String(number)).toBe(false);
    }
  });

  it("keeps PR list controls minimal with reviewed defaults and hard bounds", () => {
    const schema = mapping("github.pr.list").inputSchema;
    const defaults = schema.safeParse({ repository: REPOSITORY });
    expect(defaults.success).toBe(true);
    if (!defaults.success) throw new Error("expected list defaults to parse");
    expect(defaults.data).toEqual({ repository: REPOSITORY, state: "open", limit: 30 });

    expect(schema.safeParse({ repository: REPOSITORY, state: "closed", limit: 1 }).success).toBe(true);
    expect(schema.safeParse({ repository: REPOSITORY, state: "all", limit: 50 }).success).toBe(true);
    expect(schema.safeParse({ repository: REPOSITORY, state: "draft" }).success).toBe(false);
    expect(schema.safeParse({ repository: REPOSITORY, limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ repository: REPOSITORY, limit: 51 }).success).toBe(false);
    expect(schema.safeParse({ repository: REPOSITORY, limit: 1.5 }).success).toBe(false);
  });

  it("rejects unknown authority fields before any operation encoder can use them", () => {
    const cases = [
      { semanticCapabilityId: "github.repository.inspect", valid: { repository: REPOSITORY } },
      { semanticCapabilityId: "github.pr.inspect", valid: { repository: REPOSITORY, number: 16 } },
      { semanticCapabilityId: "github.pr.list", valid: { repository: REPOSITORY, state: "open", limit: 10 } }
    ];
    for (const { semanticCapabilityId, valid } of cases) {
      const schema = mapping(semanticCapabilityId).inputSchema;
      for (const field of AUTHORITY_FIELDS) {
        expect(schema.safeParse({ ...valid, [field]: "attacker-controlled" }).success, `${semanticCapabilityId}:${field}`)
          .toBe(false);
      }
    }
  });

  it("encodes only reviewed path parameters and list query fields", () => {
    expect(operation("repository.inspect").encodeRequest({ repository: REPOSITORY })).toEqual({
      pathParameters: { owner: "2ndworld", repo: "kodeGPT" }
    });
    expect(operation("pr.inspect").encodeRequest({ repository: REPOSITORY, number: 16 })).toEqual({
      pathParameters: { owner: "2ndworld", repo: "kodeGPT", number: "16" }
    });
    expect(operation("pr.list").encodeRequest({ repository: REPOSITORY, state: "closed", limit: 17 })).toEqual({
      pathParameters: { owner: "2ndworld", repo: "kodeGPT" },
      query: { state: "closed", per_page: 17 }
    });
  });

  it("registers the three mappings and rejects unknown GitHub semantic operations", () => {
    const registry = new ProviderAdapterRegistry([GITHUB_READ_PROVIDER_MANIFEST]);
    expect(registry.list().map((candidate) => candidate.adapterId)).toEqual(["github.read.v1"]);
    expect(registry.requireMapping("github.repository.inspect").adapterOperationId).toBe("repository.inspect");
    expect(registry.requireMapping("github.pr.inspect").adapterOperationId).toBe("pr.inspect");
    expect(registry.requireMapping("github.pr.list").adapterOperationId).toBe("pr.list");
    expect(() => registry.requireMapping("github.issue.inspect")).toThrowError(
      expect.objectContaining({ code: "PROVIDER_TOOL_UNAVAILABLE" })
    );
  });
});
