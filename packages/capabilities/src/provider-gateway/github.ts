import { createHash } from "node:crypto";

import { z } from "zod";

import type { ProviderAdapterManifest, ProviderEncodedRequest } from "./contracts.js";

const GITHUB_ADAPTER_ID = "github.read.v1";
const GITHUB_ADAPTER_CONTRACT_VERSION = "1";
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_ACCEPT = "application/vnd.github+json";
const GITHUB_USER_AGENT = "KodeGPT/0.1 Provider-GitHub-Read";
const GITHUB_PR_NUMBER_MAX = 2_147_483_647;
const GITHUB_PR_LIST_LIMIT_MAX = 50;
const REPOSITORY_COMPONENT = /^[A-Za-z0-9._-]{1,100}$/;

const FIXED_HEADERS = Object.freeze({
  accept: GITHUB_ACCEPT,
  "x-github-api-version": GITHUB_API_VERSION,
  "user-agent": GITHUB_USER_AGENT
});

const RepositorySchema = z.string().max(201).refine((value) => {
  const parts = value.split("/");
  if (parts.length !== 2) return false;
  const [owner, repo] = parts;
  return owner !== undefined && repo !== undefined &&
    owner !== "." && owner !== ".." && repo !== "." && repo !== ".." &&
    REPOSITORY_COMPONENT.test(owner) && REPOSITORY_COMPONENT.test(repo);
});

const RepositoryInspectInputSchema = z.object({
  repository: RepositorySchema
}).strict();

const PrInspectInputSchema = z.object({
  repository: RepositorySchema,
  number: z.number().int().min(1).max(GITHUB_PR_NUMBER_MAX)
}).strict();

const PrListInputSchema = z.object({
  repository: RepositorySchema,
  state: z.enum(["open", "closed", "all"]).default("open"),
  limit: z.number().int().min(1).max(GITHUB_PR_LIST_LIMIT_MAX).default(30)
}).strict();

const IMPLEMENTATION_DESCRIPTOR = Object.freeze({
  adapterId: GITHUB_ADAPTER_ID,
  adapterContractVersion: GITHUB_ADAPTER_CONTRACT_VERSION,
  schemaRevision: 1,
  normalizerRevision: 1,
  origin: GITHUB_API_ORIGIN,
  apiVersion: GITHUB_API_VERSION,
  accept: GITHUB_ACCEPT,
  userAgent: GITHUB_USER_AGENT,
  credential: { kind: "external-helper", credentialKind: "bearer", argv: ["auth", "token"] },
  operations: [
    ["repository.inspect", "GET", "/repos/{owner}/{repo}"],
    ["pr.inspect", "GET", "/repos/{owner}/{repo}/pulls/{number}"],
    ["pr.list", "GET", "/repos/{owner}/{repo}/pulls", ["state", "per_page"]]
  ],
  semantics: ["github.repository.inspect", "github.pr.inspect", "github.pr.list"]
});

const IMPLEMENTATION_DIGEST = createHash("sha256")
  .update(JSON.stringify(IMPLEMENTATION_DESCRIPTOR), "utf8")
  .digest("hex");

function repositoryParts(repository: string): { owner: string; repo: string } {
  const [owner, repo] = repository.split("/");
  if (owner === undefined || repo === undefined) throw new Error("validated repository invariant failed");
  return { owner, repo };
}

function encodeRepositoryInspect(input: unknown): ProviderEncodedRequest {
  const parsed = RepositoryInspectInputSchema.parse(input);
  return { pathParameters: repositoryParts(parsed.repository) };
}

function encodePrInspect(input: unknown): ProviderEncodedRequest {
  const parsed = PrInspectInputSchema.parse(input);
  const repository = repositoryParts(parsed.repository);
  return {
    pathParameters: {
      ...repository,
      number: String(parsed.number)
    }
  };
}

function encodePrList(input: unknown): ProviderEncodedRequest {
  const parsed = PrListInputSchema.parse(input);
  return {
    pathParameters: repositoryParts(parsed.repository),
    query: {
      state: parsed.state,
      per_page: parsed.limit
    }
  };
}

export const GITHUB_READ_PROVIDER_MANIFEST: ProviderAdapterManifest = {
  adapterId: GITHUB_ADAPTER_ID,
  adapterContractVersion: GITHUB_ADAPTER_CONTRACT_VERSION,
  implementationDigest: IMPLEMENTATION_DIGEST,
  inventoryMode: "STATIC",
  networkPolicy: {
    kind: "internet",
    origins: [GITHUB_API_ORIGIN],
    redirect: null
  },
  credentialBroker: {
    kind: "external-helper",
    credentialKind: "bearer",
    argv: ["auth", "token"],
    environment: {}
  },
  operations: [
    {
      id: "repository.inspect",
      method: "GET",
      origin: GITHUB_API_ORIGIN,
      pathTemplate: "/repos/{owner}/{repo}",
      allowedQueryKeys: [],
      fixedHeaders: FIXED_HEADERS,
      inputSchema: RepositoryInspectInputSchema,
      encodeRequest: encodeRepositoryInspect
    },
    {
      id: "pr.inspect",
      method: "GET",
      origin: GITHUB_API_ORIGIN,
      pathTemplate: "/repos/{owner}/{repo}/pulls/{number}",
      allowedQueryKeys: [],
      fixedHeaders: FIXED_HEADERS,
      inputSchema: PrInspectInputSchema,
      encodeRequest: encodePrInspect
    },
    {
      id: "pr.list",
      method: "GET",
      origin: GITHUB_API_ORIGIN,
      pathTemplate: "/repos/{owner}/{repo}/pulls",
      allowedQueryKeys: ["state", "per_page"],
      fixedHeaders: FIXED_HEADERS,
      inputSchema: PrListInputSchema,
      encodeRequest: encodePrList
    }
  ],
  mappings: [
    {
      semanticCapabilityId: "github.repository.inspect",
      adapterId: GITHUB_ADAPTER_ID,
      adapterOperationId: "repository.inspect",
      effect: "REMOTE_READ",
      workspaceBinding: "NONE",
      inputSchema: RepositoryInspectInputSchema,
      outputSchema: z.never(),
      maxProviderRequests: 1,
      retry: "none",
      auditFields: ["repository"]
    },
    {
      semanticCapabilityId: "github.pr.inspect",
      adapterId: GITHUB_ADAPTER_ID,
      adapterOperationId: "pr.inspect",
      effect: "REMOTE_READ",
      workspaceBinding: "NONE",
      inputSchema: PrInspectInputSchema,
      outputSchema: z.never(),
      maxProviderRequests: 1,
      retry: "none",
      auditFields: ["repository", "number"]
    },
    {
      semanticCapabilityId: "github.pr.list",
      adapterId: GITHUB_ADAPTER_ID,
      adapterOperationId: "pr.list",
      effect: "REMOTE_READ",
      workspaceBinding: "NONE",
      inputSchema: PrListInputSchema,
      outputSchema: z.never(),
      maxProviderRequests: 1,
      retry: "none",
      auditFields: ["repository", "state", "limit"]
    }
  ]
};
