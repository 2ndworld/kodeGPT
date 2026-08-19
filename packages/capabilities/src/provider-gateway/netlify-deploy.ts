import { createHash } from "node:crypto";

import { z } from "zod";

import type { ProviderAdapterManifest, ProviderEncodedRequest } from "./contracts.js";
import { GitHubBranchValueSchema, GitHubRepositorySchema } from "./github.js";

const ADAPTER_ID = "netlify.deploy.v1";
const ADAPTER_CONTRACT_VERSION = "1";
const API_ORIGIN = "https://api.netlify.com";
const USER_AGENT = "KodeGPT/0.1 Provider-Netlify-Deploy";
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_ID_LENGTH = 128;
const MAX_ERROR_LENGTH = 4096;
const MAX_URL_LENGTH = 2048;

const FixedHeaders = Object.freeze({
  accept: "application/json",
  "user-agent": USER_AGENT
});

const SafeIdSchema = z.string().min(1).max(MAX_ID_LENGTH).regex(SAFE_ID);
const BranchSchema = GitHubBranchValueSchema.refine((value) => !CONTROL.test(value), "branch contains control characters");
const TimestampSchema = z.string().min(1).max(128).refine((value) => Number.isFinite(Date.parse(value)), "invalid timestamp");
const HttpsUrlSchema = z.string().min(1).max(MAX_URL_LENGTH).superRefine((value, context) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: "invalid URL" });
    return;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    context.addIssue({ code: "custom", message: "preview URL must be credential-free HTTPS" });
  }
});

const ProviderStateSchema = z.string().min(1).max(64).refine((value) => !CONTROL.test(value), "state contains control characters");
const NormalizedStateSchema = z.enum([
  "new",
  "pending_review",
  "accepted",
  "enqueued",
  "building",
  "uploading",
  "uploaded",
  "ready",
  "error",
  "retrying",
  "processing",
  "prepared",
  "waiting",
  "locked",
  "unknown"
]);

export const NetlifyDeployProviderConfigSchema = z.object({
  siteId: SafeIdSchema,
  repository: GitHubRepositorySchema,
  productionBranch: BranchSchema
}).strict();

export const NetlifyDeployCreateInputSchema = z.object({
  siteId: SafeIdSchema,
  branch: BranchSchema,
  expectedHeadOid: z.string().regex(GIT_OBJECT_ID)
}).strict();

export const NetlifyDeployCreateResultSchema = z.object({
  deploymentId: SafeIdSchema,
  branch: BranchSchema,
  sourceOid: z.string().regex(GIT_OBJECT_ID),
  createdAt: TimestampSchema
}).strict();

export const NetlifyDeployInspectInputSchema = z.object({
  siteId: SafeIdSchema,
  deploymentId: SafeIdSchema
}).strict();

export const NetlifyDeployInspectResultSchema = z.object({
  deploymentId: SafeIdSchema,
  state: NormalizedStateSchema,
  previewUrl: HttpsUrlSchema,
  branch: BranchSchema,
  sourceOid: z.string().regex(GIT_OBJECT_ID),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  errorMessage: z.string().max(MAX_ERROR_LENGTH).refine((value) => !value.includes("\0"), "error contains NUL").optional()
}).strict();

export type NetlifyDeployProviderConfig = z.infer<typeof NetlifyDeployProviderConfigSchema>;
export type NetlifyDeployCreateInput = z.infer<typeof NetlifyDeployCreateInputSchema>;
export type NetlifyDeployCreateResult = z.infer<typeof NetlifyDeployCreateResultSchema>;
export type NetlifyDeployInspectInput = z.infer<typeof NetlifyDeployInspectInputSchema>;
export type NetlifyDeployInspectResult = z.infer<typeof NetlifyDeployInspectResultSchema>;

const RawCreateSchema = z.object({
  deploy_id: SafeIdSchema,
  sha: z.string().regex(GIT_OBJECT_ID),
  created_at: TimestampSchema
});

const RawInspectSchema = z.object({
  id: SafeIdSchema,
  site_id: SafeIdSchema,
  state: ProviderStateSchema,
  deploy_ssl_url: HttpsUrlSchema.nullable().optional(),
  ssl_url: HttpsUrlSchema.nullable().optional(),
  deploy_url: HttpsUrlSchema.nullable().optional(),
  branch: BranchSchema,
  commit_ref: z.string().regex(GIT_OBJECT_ID),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  error_message: z.string().max(MAX_ERROR_LENGTH).refine((value) => !value.includes("\0"), "error contains NUL").nullable().optional()
});

const KNOWN_STATES = new Set<z.infer<typeof NormalizedStateSchema>>([
  "new",
  "pending_review",
  "accepted",
  "enqueued",
  "building",
  "uploading",
  "uploaded",
  "ready",
  "error",
  "retrying",
  "processing",
  "prepared",
  "waiting",
  "locked"
]);

const IMPLEMENTATION_DESCRIPTOR = Object.freeze({
  adapterId: ADAPTER_ID,
  adapterContractVersion: ADAPTER_CONTRACT_VERSION,
  schemaRevision: 1,
  normalizerRevision: 1,
  origin: API_ORIGIN,
  userAgent: USER_AGENT,
  credential: { kind: "external-helper", credentialKind: "bearer", argv: ["token"] },
  operations: [
    ["preview.create", "POST", "/api/v1/sites/{site_id}/builds"],
    ["preview.inspect", "GET", "/api/v1/sites/{site_id}/deploys/{deploy_id}"]
  ],
  semantics: ["netlify.deploy.preview.create", "netlify.deploy.preview.inspect"]
});

const IMPLEMENTATION_DIGEST = createHash("sha256")
  .update(JSON.stringify(IMPLEMENTATION_DESCRIPTOR), "utf8")
  .digest("hex");

function encodeCreate(input: unknown): ProviderEncodedRequest {
  const parsed = NetlifyDeployCreateInputSchema.parse(input);
  return {
    pathParameters: { site_id: parsed.siteId },
    query: { branch: parsed.branch }
  };
}

function encodeInspect(input: unknown): ProviderEncodedRequest {
  const parsed = NetlifyDeployInspectInputSchema.parse(input);
  return { pathParameters: { site_id: parsed.siteId, deploy_id: parsed.deploymentId } };
}

function mapCreate(providerValue: unknown, semanticInput: unknown): unknown {
  const input = NetlifyDeployCreateInputSchema.parse(semanticInput);
  const raw = RawCreateSchema.parse(providerValue);
  if (raw.sha !== input.expectedHeadOid) {
    throw new Error("Netlify deployment source revision mismatch");
  }
  return {
    deploymentId: raw.deploy_id,
    branch: input.branch,
    sourceOid: raw.sha,
    createdAt: raw.created_at
  };
}

function mapInspect(providerValue: unknown, semanticInput: unknown): unknown {
  const input = NetlifyDeployInspectInputSchema.parse(semanticInput);
  const raw = RawInspectSchema.parse(providerValue);
  if (raw.id !== input.deploymentId || raw.site_id !== input.siteId) {
    throw new Error("Netlify deployment identity mismatch");
  }
  const previewUrl = raw.deploy_ssl_url ?? raw.ssl_url ?? raw.deploy_url;
  if (previewUrl === undefined || previewUrl === null) {
    throw new Error("Netlify deployment preview URL is unavailable");
  }
  const normalizedState = KNOWN_STATES.has(raw.state as z.infer<typeof NormalizedStateSchema>)
    ? raw.state
    : "unknown";
  return {
    deploymentId: raw.id,
    state: normalizedState,
    previewUrl,
    branch: raw.branch,
    sourceOid: raw.commit_ref,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    ...(raw.error_message === undefined || raw.error_message === null || raw.error_message.length === 0
      ? {}
      : { errorMessage: raw.error_message })
  };
}

export const NETLIFY_DEPLOY_PROVIDER_ADAPTER_ID = ADAPTER_ID;

export const NETLIFY_DEPLOY_PROVIDER_MANIFEST: ProviderAdapterManifest = {
  adapterId: ADAPTER_ID,
  adapterContractVersion: ADAPTER_CONTRACT_VERSION,
  implementationDigest: IMPLEMENTATION_DIGEST,
  inventoryMode: "STATIC",
  networkPolicy: {
    kind: "internet",
    origins: [API_ORIGIN],
    redirect: null
  },
  credentialBroker: {
    kind: "external-helper",
    credentialKind: "bearer",
    argv: ["token"],
    environment: {}
  },
  operations: [
    {
      id: "preview.create",
      method: "POST",
      origin: API_ORIGIN,
      pathTemplate: "/api/v1/sites/{site_id}/builds",
      allowedQueryKeys: ["branch"],
      fixedHeaders: FixedHeaders,
      inputSchema: NetlifyDeployCreateInputSchema,
      encodeRequest: encodeCreate
    },
    {
      id: "preview.inspect",
      method: "GET",
      origin: API_ORIGIN,
      pathTemplate: "/api/v1/sites/{site_id}/deploys/{deploy_id}",
      allowedQueryKeys: [],
      fixedHeaders: FixedHeaders,
      inputSchema: NetlifyDeployInspectInputSchema,
      encodeRequest: encodeInspect
    }
  ],
  mappings: [
    {
      semanticCapabilityId: "netlify.deploy.preview.create",
      adapterId: ADAPTER_ID,
      adapterOperationId: "preview.create",
      effect: "REMOTE_MUTATION",
      workspaceBinding: "REQUIRED",
      inputSchema: NetlifyDeployCreateInputSchema,
      outputSchema: NetlifyDeployCreateResultSchema,
      mapOutput: mapCreate,
      maxProviderRequests: 1,
      retry: "none",
      auditFields: ["siteId", "branch", "expectedHeadOid"]
    },
    {
      semanticCapabilityId: "netlify.deploy.preview.inspect",
      adapterId: ADAPTER_ID,
      adapterOperationId: "preview.inspect",
      effect: "REMOTE_READ",
      workspaceBinding: "REQUIRED",
      inputSchema: NetlifyDeployInspectInputSchema,
      outputSchema: NetlifyDeployInspectResultSchema,
      mapOutput: mapInspect,
      maxProviderRequests: 1,
      retry: "one-idempotent-read",
      auditFields: ["siteId", "deploymentId"]
    }
  ]
};
