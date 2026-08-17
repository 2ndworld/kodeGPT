import { createHash } from "node:crypto";

import { z } from "zod";

import type { ProviderAdapterManifest, ProviderEncodedRequest } from "./contracts.js";
import {
  GitHubBranchValueSchema,
  GitHubLoginValueSchema,
  GitHubRepositorySchema,
  GitHubTimestampValueSchema,
  GitHubTitleValueSchema,
  GitHubUrlValueSchema
} from "./github.js";

const GITHUB_WRITE_ADAPTER_ID = "github.write.v1";
const GITHUB_WRITE_ADAPTER_CONTRACT_VERSION = "1";
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_ACCEPT = "application/vnd.github+json";
const GITHUB_USER_AGENT = "KodeGPT/0.1 Provider-GitHub-Write";
const GITHUB_PR_NUMBER_MAX = 2_147_483_647;
const GITHUB_PR_BODY_MAX_BYTES = 16 * 1024;
const GITHUB_MERGE_MESSAGE_MAX = 4096;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const FIXED_HEADERS = Object.freeze({
  accept: GITHUB_ACCEPT,
  "content-type": "application/json",
  "x-github-api-version": GITHUB_API_VERSION,
  "user-agent": GITHUB_USER_AGENT
});

const GitHubWriteBranchSchema = GitHubBranchValueSchema.refine(
  (value) => !CONTROL.test(value),
  "branch contains control characters"
);

const GitHubPrBodySchema = z.string()
  .refine((value) => !value.includes("\0"), "body contains NUL")
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= GITHUB_PR_BODY_MAX_BYTES,
    "body exceeds 16 KiB"
  );

export const GitHubPrCreateInputSchema = z.object({
  repository: GitHubRepositorySchema,
  title: GitHubTitleValueSchema.min(1),
  headBranch: GitHubWriteBranchSchema,
  baseBranch: GitHubWriteBranchSchema,
  body: GitHubPrBodySchema.optional()
}).strict();

export const GitHubPrMergeInputSchema = z.object({
  repository: GitHubRepositorySchema,
  number: z.number().int().min(1).max(GITHUB_PR_NUMBER_MAX),
  expectedHeadOid: z.string().regex(GIT_OBJECT_ID)
}).strict();

const RawPrCreateSchema = z.object({
  number: z.number().int().min(1).max(GITHUB_PR_NUMBER_MAX),
  title: GitHubTitleValueSchema,
  state: z.enum(["open", "closed"]),
  user: z.object({ login: GitHubLoginValueSchema }).nullable(),
  base: z.object({
    ref: GitHubBranchValueSchema,
    repo: z.object({ full_name: GitHubRepositorySchema })
  }),
  head: z.object({ ref: GitHubBranchValueSchema }),
  draft: z.boolean(),
  html_url: GitHubUrlValueSchema,
  created_at: GitHubTimestampValueSchema,
  updated_at: GitHubTimestampValueSchema
});

const RawPrMergeSchema = z.object({
  sha: z.string().regex(GIT_OBJECT_ID).nullable(),
  merged: z.boolean(),
  message: z.string().max(GITHUB_MERGE_MESSAGE_MAX)
});

export const GitHubPrCreateResultSchema = z.object({
  repository: GitHubRepositorySchema,
  number: z.number().int().min(1).max(GITHUB_PR_NUMBER_MAX),
  title: GitHubTitleValueSchema,
  state: z.enum(["open", "closed"]),
  authorLogin: GitHubLoginValueSchema.nullable(),
  baseBranch: GitHubBranchValueSchema,
  headBranch: GitHubBranchValueSchema,
  draft: z.boolean(),
  htmlUrl: GitHubUrlValueSchema,
  createdAt: GitHubTimestampValueSchema,
  updatedAt: GitHubTimestampValueSchema
}).strict();

export const GitHubPrMergeResultSchema = z.object({
  repository: GitHubRepositorySchema,
  number: z.number().int().min(1).max(GITHUB_PR_NUMBER_MAX),
  merged: z.literal(true),
  mergeCommitOid: z.string().regex(GIT_OBJECT_ID)
}).strict();

export type GitHubPrCreateInput = z.infer<typeof GitHubPrCreateInputSchema>;
export type GitHubPrCreateResult = z.infer<typeof GitHubPrCreateResultSchema>;
export type GitHubPrMergeInput = z.infer<typeof GitHubPrMergeInputSchema>;
export type GitHubPrMergeResult = z.infer<typeof GitHubPrMergeResultSchema>;

const IMPLEMENTATION_DESCRIPTOR = Object.freeze({
  adapterId: GITHUB_WRITE_ADAPTER_ID,
  adapterContractVersion: GITHUB_WRITE_ADAPTER_CONTRACT_VERSION,
  schemaRevision: 1,
  normalizerRevision: 1,
  origin: GITHUB_API_ORIGIN,
  apiVersion: GITHUB_API_VERSION,
  accept: GITHUB_ACCEPT,
  userAgent: GITHUB_USER_AGENT,
  credential: { kind: "external-helper", credentialKind: "bearer", argv: ["auth", "token"] },
  operations: [
    ["pr.create", "POST", "/repos/{owner}/{repo}/pulls"],
    ["pr.merge", "PUT", "/repos/{owner}/{repo}/pulls/{number}/merge"]
  ],
  semantics: ["github.pr.create", "github.pr.merge"]
});

const IMPLEMENTATION_DIGEST = createHash("sha256")
  .update(JSON.stringify(IMPLEMENTATION_DESCRIPTOR), "utf8")
  .digest("hex");

function repositoryParts(repository: string): { owner: string; repo: string } {
  const [owner, repo] = repository.split("/");
  if (owner === undefined || repo === undefined) throw new Error("validated repository invariant failed");
  return { owner, repo };
}

function encodePrCreate(input: unknown): ProviderEncodedRequest {
  const parsed = GitHubPrCreateInputSchema.parse(input);
  return {
    pathParameters: repositoryParts(parsed.repository),
    body: {
      title: parsed.title,
      head: parsed.headBranch,
      base: parsed.baseBranch,
      ...(parsed.body === undefined ? {} : { body: parsed.body.replace(/\r\n?/g, "\n") })
    }
  };
}

function encodePrMerge(input: unknown): ProviderEncodedRequest {
  const parsed = GitHubPrMergeInputSchema.parse(input);
  return {
    pathParameters: {
      ...repositoryParts(parsed.repository),
      number: String(parsed.number)
    },
    body: {
      sha: parsed.expectedHeadOid,
      merge_method: "merge"
    }
  };
}

function sameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function mapPrCreate(providerValue: unknown, semanticInput: unknown): unknown {
  const input = GitHubPrCreateInputSchema.parse(semanticInput);
  const raw = RawPrCreateSchema.parse(providerValue);
  if (
    !sameRepository(raw.base.repo.full_name, input.repository)
    || raw.base.ref !== input.baseBranch
    || raw.head.ref !== input.headBranch
    || raw.title !== input.title
  ) {
    throw new Error("GitHub created pull request identity mismatch");
  }
  return {
    repository: input.repository,
    number: raw.number,
    title: raw.title,
    state: raw.state,
    authorLogin: raw.user?.login ?? null,
    baseBranch: raw.base.ref,
    headBranch: raw.head.ref,
    draft: raw.draft,
    htmlUrl: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at
  };
}

function mapPrMerge(providerValue: unknown, semanticInput: unknown): unknown {
  const input = GitHubPrMergeInputSchema.parse(semanticInput);
  const raw = RawPrMergeSchema.parse(providerValue);
  if (!raw.merged || raw.sha === null) throw new Error("GitHub pull request was not merged");
  return {
    repository: input.repository,
    number: input.number,
    merged: true,
    mergeCommitOid: raw.sha
  };
}

export const GITHUB_WRITE_PROVIDER_ADAPTER_ID = GITHUB_WRITE_ADAPTER_ID;

export const GITHUB_WRITE_PROVIDER_MANIFEST: ProviderAdapterManifest = {
  adapterId: GITHUB_WRITE_ADAPTER_ID,
  adapterContractVersion: GITHUB_WRITE_ADAPTER_CONTRACT_VERSION,
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
      id: "pr.create",
      method: "POST",
      origin: GITHUB_API_ORIGIN,
      pathTemplate: "/repos/{owner}/{repo}/pulls",
      allowedQueryKeys: [],
      fixedHeaders: FIXED_HEADERS,
      inputSchema: GitHubPrCreateInputSchema,
      encodeRequest: encodePrCreate
    },
    {
      id: "pr.merge",
      method: "PUT",
      origin: GITHUB_API_ORIGIN,
      pathTemplate: "/repos/{owner}/{repo}/pulls/{number}/merge",
      allowedQueryKeys: [],
      fixedHeaders: FIXED_HEADERS,
      inputSchema: GitHubPrMergeInputSchema,
      encodeRequest: encodePrMerge
    }
  ],
  mappings: [
    {
      semanticCapabilityId: "github.pr.create",
      adapterId: GITHUB_WRITE_ADAPTER_ID,
      adapterOperationId: "pr.create",
      effect: "REMOTE_MUTATION",
      workspaceBinding: "NONE",
      inputSchema: GitHubPrCreateInputSchema,
      outputSchema: GitHubPrCreateResultSchema,
      mapOutput: mapPrCreate,
      maxProviderRequests: 1,
      retry: "none",
      auditFields: ["repository", "title", "headBranch", "baseBranch"]
    },
    {
      semanticCapabilityId: "github.pr.merge",
      adapterId: GITHUB_WRITE_ADAPTER_ID,
      adapterOperationId: "pr.merge",
      effect: "REMOTE_MUTATION",
      workspaceBinding: "NONE",
      inputSchema: GitHubPrMergeInputSchema,
      outputSchema: GitHubPrMergeResultSchema,
      mapOutput: mapPrMerge,
      maxProviderRequests: 1,
      retry: "none",
      auditFields: ["repository", "number", "expectedHeadOid"]
    }
  ]
};
