import { describe, expect, it } from "vitest";

import { ProviderAdapterRegistry } from "./adapter-registry.js";
import {
  NETLIFY_DEPLOY_PROVIDER_ADAPTER_ID,
  NETLIFY_DEPLOY_PROVIDER_MANIFEST,
  NetlifyDeployCreateInputSchema,
  NetlifyDeployCreateResultSchema,
  NetlifyDeployInspectInputSchema,
  NetlifyDeployInspectResultSchema,
  NetlifyDeployProviderConfigSchema
} from "./netlify-deploy.js";
import { parseProviderSemanticOutput } from "./output.js";

const OID = "a".repeat(40);
const SITE_ID = "site_123";
const DEPLOYMENT_ID = "deploy_123";

function operation(id: "preview.create" | "preview.inspect") {
  const found = NETLIFY_DEPLOY_PROVIDER_MANIFEST.operations.find((item) => item.id === id);
  if (!found) throw new Error(`missing operation ${id}`);
  return found;
}

function mapping(id: "netlify.deploy.preview.create" | "netlify.deploy.preview.inspect") {
  const found = NETLIFY_DEPLOY_PROVIDER_MANIFEST.mappings.find((item) => item.semanticCapabilityId === id);
  if (!found) throw new Error(`missing mapping ${id}`);
  return found;
}

describe("netlify.deploy.v1", () => {
  it("defines exactly one static Netlify origin and create+inspect mappings", () => {
    expect(NETLIFY_DEPLOY_PROVIDER_ADAPTER_ID).toBe("netlify.deploy.v1");
    expect(NETLIFY_DEPLOY_PROVIDER_MANIFEST.adapterId).toBe("netlify.deploy.v1");
    expect(NETLIFY_DEPLOY_PROVIDER_MANIFEST.inventoryMode).toBe("STATIC");
    expect(NETLIFY_DEPLOY_PROVIDER_MANIFEST.networkPolicy).toEqual({
      kind: "internet",
      origins: ["https://api.netlify.com"],
      redirect: null
    });
    expect(NETLIFY_DEPLOY_PROVIDER_MANIFEST.credentialBroker).toEqual({
      kind: "external-helper",
      credentialKind: "bearer",
      argv: ["token"],
      environment: {}
    });
    expect(NETLIFY_DEPLOY_PROVIDER_MANIFEST.operations.map(({ id }) => id)).toEqual([
      "preview.create",
      "preview.inspect"
    ]);
    expect(NETLIFY_DEPLOY_PROVIDER_MANIFEST.mappings.map(({ semanticCapabilityId }) => semanticCapabilityId)).toEqual([
      "netlify.deploy.preview.create",
      "netlify.deploy.preview.inspect"
    ]);
    expect(() => new ProviderAdapterRegistry([NETLIFY_DEPLOY_PROVIDER_MANIFEST])).not.toThrow();
  });

  it("keeps provider admission config strict and non-secret", () => {
    const input = { siteId: SITE_ID, repository: "2ndworld/kodeGPT", productionBranch: "main" };
    expect(NetlifyDeployProviderConfigSchema.parse(input)).toEqual(input);
    expect(() => NetlifyDeployProviderConfigSchema.parse({ ...input, token: "secret" })).toThrow();
    expect(() => NetlifyDeployProviderConfigSchema.parse({ ...input, siteId: "https://evil.invalid/site" })).toThrow();
    expect(() => NetlifyDeployProviderConfigSchema.parse({ ...input, productionBranch: "bad\nbranch" })).toThrow();
  });

  it("encodes create as one fixed branch-build POST and retains expectedHeadOid only for proof", () => {
    const input = NetlifyDeployCreateInputSchema.parse({
      siteId: SITE_ID,
      branch: "feat/typed-preview",
      expectedHeadOid: OID
    });
    const create = operation("preview.create");
    expect(create).toMatchObject({
      method: "POST",
      origin: "https://api.netlify.com",
      pathTemplate: "/api/v1/sites/{site_id}/builds",
      allowedQueryKeys: ["branch"]
    });
    expect(create.encodeRequest(input)).toEqual({
      pathParameters: { site_id: SITE_ID },
      query: { branch: "feat/typed-preview" }
    });
    expect(mapping("netlify.deploy.preview.create")).toMatchObject({
      effect: "REMOTE_MUTATION",
      workspaceBinding: "REQUIRED",
      maxProviderRequests: 1,
      retry: "none"
    });
  });

  it("proves create output against the exact expected local OID", () => {
    const input = NetlifyDeployCreateInputSchema.parse({ siteId: SITE_ID, branch: "feat/typed-preview", expectedHeadOid: OID });
    const mapOutput = mapping("netlify.deploy.preview.create").mapOutput;
    expect(parseProviderSemanticOutput(
      Buffer.from(JSON.stringify({ deploy_id: DEPLOYMENT_ID, sha: OID, created_at: "2026-08-19T00:00:00Z" })),
      NetlifyDeployCreateResultSchema,
      { semanticInput: input, mapOutput }
    )).toEqual({
      deploymentId: DEPLOYMENT_ID,
      branch: "feat/typed-preview",
      sourceOid: OID,
      createdAt: "2026-08-19T00:00:00Z"
    });

    expect(() => parseProviderSemanticOutput(
      Buffer.from(JSON.stringify({ deploy_id: DEPLOYMENT_ID, sha: "b".repeat(40), created_at: "2026-08-19T00:00:00Z" })),
      NetlifyDeployCreateResultSchema,
      { semanticInput: input, mapOutput }
    )).toThrow("Provider response mapping failed");
  });

  it("encodes inspect as one fixed site-scoped GET and normalizes only reviewed evidence", () => {
    const input = NetlifyDeployInspectInputSchema.parse({ siteId: SITE_ID, deploymentId: DEPLOYMENT_ID });
    const inspect = operation("preview.inspect");
    expect(inspect).toMatchObject({
      method: "GET",
      origin: "https://api.netlify.com",
      pathTemplate: "/api/v1/sites/{site_id}/deploys/{deploy_id}",
      allowedQueryKeys: []
    });
    expect(inspect.encodeRequest(input)).toEqual({ pathParameters: { site_id: SITE_ID, deploy_id: DEPLOYMENT_ID } });
    expect(mapping("netlify.deploy.preview.inspect")).toMatchObject({
      effect: "REMOTE_READ",
      workspaceBinding: "REQUIRED",
      maxProviderRequests: 1,
      retry: "one-idempotent-read"
    });

    const value = parseProviderSemanticOutput(
      Buffer.from(JSON.stringify({
        id: DEPLOYMENT_ID,
        site_id: SITE_ID,
        state: "ready",
        deploy_ssl_url: "https://deploy-123--example.netlify.app",
        branch: "feat/typed-preview",
        commit_ref: OID,
        created_at: "2026-08-19T00:00:00Z",
        updated_at: "2026-08-19T00:01:00Z",
        error_message: null,
        admin_url: "https://app.netlify.com/should-not-leak"
      })),
      NetlifyDeployInspectResultSchema,
      { semanticInput: input, mapOutput: mapping("netlify.deploy.preview.inspect").mapOutput }
    );
    expect(value).toEqual({
      deploymentId: DEPLOYMENT_ID,
      state: "ready",
      previewUrl: "https://deploy-123--example.netlify.app",
      branch: "feat/typed-preview",
      sourceOid: OID,
      createdAt: "2026-08-19T00:00:00Z",
      updatedAt: "2026-08-19T00:01:00Z"
    });
  });

  it("rejects inspect identity mismatches instead of trusting a raw provider object", () => {
    const input = NetlifyDeployInspectInputSchema.parse({ siteId: SITE_ID, deploymentId: DEPLOYMENT_ID });
    expect(() => parseProviderSemanticOutput(
      Buffer.from(JSON.stringify({
        id: "deploy_other",
        site_id: SITE_ID,
        state: "ready",
        deploy_ssl_url: "https://example.netlify.app",
        branch: "feat/typed-preview",
        commit_ref: OID,
        created_at: "2026-08-19T00:00:00Z",
        updated_at: "2026-08-19T00:01:00Z"
      })),
      NetlifyDeployInspectResultSchema,
      { semanticInput: input, mapOutput: mapping("netlify.deploy.preview.inspect").mapOutput }
    )).toThrow("Provider response mapping failed");
  });
});
