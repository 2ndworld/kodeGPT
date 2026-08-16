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
const GITHUB_ISSUE_NUMBER_MAX = GITHUB_PR_NUMBER_MAX;
const GITHUB_ISSUE_LIST_LIMIT_MAX = GITHUB_PR_LIST_LIMIT_MAX;
const GITHUB_ISSUE_LABELS_MAX = 20;
const GITHUB_ISSUE_ASSIGNEES_MAX = 20;
const GITHUB_ISSUE_LABEL_NAME_MAX = 255;
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

const IssueInspectInputSchema = z.object({
  repository: RepositorySchema,
  number: z.number().int().min(1).max(GITHUB_ISSUE_NUMBER_MAX)
}).strict();

const IssueListInputSchema = z.object({
  repository: RepositorySchema,
  state: z.enum(["open", "closed", "all"]).default("open"),
  limit: z.number().int().min(1).max(GITHUB_ISSUE_LIST_LIMIT_MAX).default(30)
}).strict();

const GitHubUrlSchema = z.string().url().max(2048);
const GitHubTimestampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
const GitHubLoginSchema = z.string().min(1).max(100);
const GitHubBranchSchema = z.string().min(1).max(255);
const GitHubTitleSchema = z.string().max(1024);

const RawRepositorySchema = z.object({
  full_name: RepositorySchema,
  name: z.string().min(1).max(100),
  owner: z.object({ login: GitHubLoginSchema }),
  description: z.string().max(4096).nullable(),
  private: z.boolean(),
  default_branch: GitHubBranchSchema,
  archived: z.boolean(),
  fork: z.boolean(),
  html_url: GitHubUrlSchema,
  created_at: GitHubTimestampSchema,
  updated_at: GitHubTimestampSchema,
  pushed_at: GitHubTimestampSchema.nullable()
});

const RawPrSummarySchema = z.object({
  number: z.number().int().min(1).max(GITHUB_PR_NUMBER_MAX),
  title: GitHubTitleSchema,
  state: z.enum(["open", "closed"]),
  user: z.object({ login: GitHubLoginSchema }).nullable(),
  base: z.object({
    ref: GitHubBranchSchema,
    repo: z.object({ full_name: RepositorySchema })
  }),
  head: z.object({ ref: GitHubBranchSchema }),
  draft: z.boolean(),
  html_url: GitHubUrlSchema,
  created_at: GitHubTimestampSchema,
  updated_at: GitHubTimestampSchema
});

const RawPrInspectSchema = RawPrSummarySchema.extend({
  merged: z.boolean(),
  closed_at: GitHubTimestampSchema.nullable(),
  merged_at: GitHubTimestampSchema.nullable()
});

const RawPrListSchema = z.array(RawPrSummarySchema).max(GITHUB_PR_LIST_LIMIT_MAX);

const RawIssueSchema = z.object({
  number: z.number().int().min(1).max(GITHUB_ISSUE_NUMBER_MAX),
  title: GitHubTitleSchema,
  state: z.enum(["open", "closed"]),
  user: z.object({ login: GitHubLoginSchema }).nullable(),
  html_url: GitHubUrlSchema,
  created_at: GitHubTimestampSchema,
  updated_at: GitHubTimestampSchema,
  closed_at: GitHubTimestampSchema.nullable(),
  comments: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  labels: z.array(z.object({ name: z.string().max(GITHUB_ISSUE_LABEL_NAME_MAX) })).max(GITHUB_ISSUE_LABELS_MAX),
  assignees: z.array(z.object({ login: GitHubLoginSchema })).max(GITHUB_ISSUE_ASSIGNEES_MAX),
  pull_request: z.unknown().optional()
});

const RawIssueListSchema = z.array(RawIssueSchema).max(GITHUB_ISSUE_LIST_LIMIT_MAX);

const RepositoryInspectOutputSchema = z.object({
  repository: RepositorySchema,
  name: z.string().min(1).max(100),
  owner: GitHubLoginSchema,
  description: z.string().max(4096).nullable(),
  private: z.boolean(),
  defaultBranch: GitHubBranchSchema,
  archived: z.boolean(),
  fork: z.boolean(),
  htmlUrl: GitHubUrlSchema,
  createdAt: GitHubTimestampSchema,
  updatedAt: GitHubTimestampSchema,
  pushedAt: GitHubTimestampSchema.nullable()
}).strict();

const PrInspectOutputSchema = z.object({
  repository: RepositorySchema,
  number: z.number().int().min(1).max(GITHUB_PR_NUMBER_MAX),
  title: GitHubTitleSchema,
  state: z.enum(["open", "closed"]),
  authorLogin: GitHubLoginSchema.nullable(),
  baseBranch: GitHubBranchSchema,
  headBranch: GitHubBranchSchema,
  merged: z.boolean(),
  draft: z.boolean(),
  htmlUrl: GitHubUrlSchema,
  createdAt: GitHubTimestampSchema,
  updatedAt: GitHubTimestampSchema,
  closedAt: GitHubTimestampSchema.nullable(),
  mergedAt: GitHubTimestampSchema.nullable()
}).strict();

const PrListItemOutputSchema = z.object({
  number: z.number().int().min(1).max(GITHUB_PR_NUMBER_MAX),
  title: GitHubTitleSchema,
  state: z.enum(["open", "closed"]),
  authorLogin: GitHubLoginSchema.nullable(),
  baseBranch: GitHubBranchSchema,
  headBranch: GitHubBranchSchema,
  draft: z.boolean(),
  htmlUrl: GitHubUrlSchema,
  createdAt: GitHubTimestampSchema,
  updatedAt: GitHubTimestampSchema
}).strict();

const PrListOutputSchema = z.object({
  repository: RepositorySchema,
  items: z.array(PrListItemOutputSchema).max(GITHUB_PR_LIST_LIMIT_MAX)
}).strict();

const IssueItemOutputSchema = z.object({
  number: z.number().int().min(1).max(GITHUB_ISSUE_NUMBER_MAX),
  title: GitHubTitleSchema,
  state: z.enum(["open", "closed"]),
  authorLogin: GitHubLoginSchema.nullable(),
  htmlUrl: GitHubUrlSchema,
  createdAt: GitHubTimestampSchema,
  updatedAt: GitHubTimestampSchema,
  closedAt: GitHubTimestampSchema.nullable(),
  commentsCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  labels: z.array(z.string().max(GITHUB_ISSUE_LABEL_NAME_MAX)).max(GITHUB_ISSUE_LABELS_MAX),
  assigneeLogins: z.array(GitHubLoginSchema).max(GITHUB_ISSUE_ASSIGNEES_MAX)
}).strict();

const IssueInspectOutputSchema = IssueItemOutputSchema.extend({
  repository: RepositorySchema
}).strict();

const IssueListOutputSchema = z.object({
  repository: RepositorySchema,
  items: z.array(IssueItemOutputSchema).max(GITHUB_ISSUE_LIST_LIMIT_MAX)
}).strict();

const IMPLEMENTATION_DESCRIPTOR = Object.freeze({
  adapterId: GITHUB_ADAPTER_ID,
  adapterContractVersion: GITHUB_ADAPTER_CONTRACT_VERSION,
  schemaRevision: 2,
  normalizerRevision: 2,
  origin: GITHUB_API_ORIGIN,
  apiVersion: GITHUB_API_VERSION,
  accept: GITHUB_ACCEPT,
  userAgent: GITHUB_USER_AGENT,
  credential: { kind: "external-helper", credentialKind: "bearer", argv: ["auth", "token"] },
  operations: [
    ["repository.inspect", "GET", "/repos/{owner}/{repo}"],
    ["pr.inspect", "GET", "/repos/{owner}/{repo}/pulls/{number}"],
    ["pr.list", "GET", "/repos/{owner}/{repo}/pulls", ["state", "per_page"]],
    ["issue.inspect", "GET", "/repos/{owner}/{repo}/issues/{number}"],
    ["issue.list", "GET", "/repos/{owner}/{repo}/issues", ["state", "per_page"]]
  ],
  semantics: [
    "github.repository.inspect",
    "github.pr.inspect",
    "github.pr.list",
    "github.issue.inspect",
    "github.issue.list"
  ]
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

function encodeIssueInspect(input: unknown): ProviderEncodedRequest {
  const parsed = IssueInspectInputSchema.parse(input);
  return {
    pathParameters: {
      ...repositoryParts(parsed.repository),
      number: String(parsed.number)
    }
  };
}

function encodeIssueList(input: unknown): ProviderEncodedRequest {
  const parsed = IssueListInputSchema.parse(input);
  return {
    pathParameters: repositoryParts(parsed.repository),
    query: {
      state: parsed.state,
      per_page: parsed.limit
    }
  };
}

function sameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function mapRepositoryInspect(providerValue: unknown, semanticInput: unknown): unknown {
  const input = RepositoryInspectInputSchema.parse(semanticInput);
  const raw = RawRepositorySchema.parse(providerValue);
  if (!sameRepository(raw.full_name, input.repository)) throw new Error("GitHub repository identity mismatch");
  return {
    repository: input.repository,
    name: raw.name,
    owner: raw.owner.login,
    description: raw.description,
    private: raw.private,
    defaultBranch: raw.default_branch,
    archived: raw.archived,
    fork: raw.fork,
    htmlUrl: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    pushedAt: raw.pushed_at
  };
}

function mapPrInspect(providerValue: unknown, semanticInput: unknown): unknown {
  const input = PrInspectInputSchema.parse(semanticInput);
  const raw = RawPrInspectSchema.parse(providerValue);
  if (raw.number !== input.number || !sameRepository(raw.base.repo.full_name, input.repository)) {
    throw new Error("GitHub pull request identity mismatch");
  }
  return {
    repository: input.repository,
    number: raw.number,
    title: raw.title,
    state: raw.state,
    authorLogin: raw.user?.login ?? null,
    baseBranch: raw.base.ref,
    headBranch: raw.head.ref,
    merged: raw.merged,
    draft: raw.draft,
    htmlUrl: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at,
    mergedAt: raw.merged_at
  };
}

function mapPrList(providerValue: unknown, semanticInput: unknown): unknown {
  const input = PrListInputSchema.parse(semanticInput);
  const raw = RawPrListSchema.parse(providerValue);
  if (raw.length > input.limit) throw new Error("GitHub pull request list exceeded requested limit");
  const items = raw.map((item) => {
    if (!sameRepository(item.base.repo.full_name, input.repository)) {
      throw new Error("GitHub pull request list repository mismatch");
    }
    return {
      number: item.number,
      title: item.title,
      state: item.state,
      authorLogin: item.user?.login ?? null,
      baseBranch: item.base.ref,
      headBranch: item.head.ref,
      draft: item.draft,
      htmlUrl: item.html_url,
      createdAt: item.created_at,
      updatedAt: item.updated_at
    };
  });
  return { repository: input.repository, items };
}

function mapIssueItem(raw: z.infer<typeof RawIssueSchema>) {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    authorLogin: raw.user?.login ?? null,
    htmlUrl: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at,
    commentsCount: raw.comments,
    labels: raw.labels.map(({ name }) => name),
    assigneeLogins: raw.assignees.map(({ login }) => login)
  };
}

function mapIssueInspect(providerValue: unknown, semanticInput: unknown): unknown {
  const input = IssueInspectInputSchema.parse(semanticInput);
  const raw = RawIssueSchema.parse(providerValue);
  if (raw.number !== input.number) throw new Error("GitHub issue identity mismatch");
  if (raw.pull_request !== undefined) throw new Error("GitHub issue semantic resolved to pull request");
  return { repository: input.repository, ...mapIssueItem(raw) };
}

function mapIssueList(providerValue: unknown, semanticInput: unknown): unknown {
  const input = IssueListInputSchema.parse(semanticInput);
  const raw = RawIssueListSchema.parse(providerValue);
  if (raw.length > input.limit) throw new Error("GitHub issue list exceeded requested limit");
  return {
    repository: input.repository,
    items: raw.filter((item) => item.pull_request === undefined).map(mapIssueItem)
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
    },
    {
      id: "issue.inspect",
      method: "GET",
      origin: GITHUB_API_ORIGIN,
      pathTemplate: "/repos/{owner}/{repo}/issues/{number}",
      allowedQueryKeys: [],
      fixedHeaders: FIXED_HEADERS,
      inputSchema: IssueInspectInputSchema,
      encodeRequest: encodeIssueInspect
    },
    {
      id: "issue.list",
      method: "GET",
      origin: GITHUB_API_ORIGIN,
      pathTemplate: "/repos/{owner}/{repo}/issues",
      allowedQueryKeys: ["state", "per_page"],
      fixedHeaders: FIXED_HEADERS,
      inputSchema: IssueListInputSchema,
      encodeRequest: encodeIssueList
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
      outputSchema: RepositoryInspectOutputSchema,
      mapOutput: mapRepositoryInspect,
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
      outputSchema: PrInspectOutputSchema,
      mapOutput: mapPrInspect,
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
      outputSchema: PrListOutputSchema,
      mapOutput: mapPrList,
      maxProviderRequests: 1,
      retry: "none",
      auditFields: ["repository", "state", "limit"]
    },
    {
      semanticCapabilityId: "github.issue.inspect",
      adapterId: GITHUB_ADAPTER_ID,
      adapterOperationId: "issue.inspect",
      effect: "REMOTE_READ",
      workspaceBinding: "NONE",
      inputSchema: IssueInspectInputSchema,
      outputSchema: IssueInspectOutputSchema,
      mapOutput: mapIssueInspect,
      maxProviderRequests: 1,
      retry: "none",
      auditFields: ["repository", "number"]
    },
    {
      semanticCapabilityId: "github.issue.list",
      adapterId: GITHUB_ADAPTER_ID,
      adapterOperationId: "issue.list",
      effect: "REMOTE_READ",
      workspaceBinding: "NONE",
      inputSchema: IssueListInputSchema,
      outputSchema: IssueListOutputSchema,
      mapOutput: mapIssueList,
      maxProviderRequests: 1,
      retry: "none",
      auditFields: ["repository", "state", "limit"]
    }
  ]
};
