import { describe, expect, it } from "vitest";

import { CapabilityError } from "../errors.js";
import * as providerGateway from "./index.js";
import type {
  ProviderRegistryRecord,
  ProviderSemanticExecutionInput,
  ProviderSemanticExecutionResult
} from "./contracts.js";

const PROVIDER_ID = "prv_0123456789abcdef0123456789abcdef";
const NOW = "2026-08-19T00:00:00.000Z";
const OID = "a".repeat(40);
const WORKSPACE_ID = "ws_ready";
const DEPLOYMENT_ID = "deploy_123";

function providerRecord(overrides: Partial<ProviderRegistryRecord> = {}): ProviderRegistryRecord {
  return {
    schemaVersion: 1,
    providerInstanceId: PROVIDER_ID,
    operatorName: "Netlify deploy",
    adapterId: "netlify.deploy.v1",
    adapterContractVersion: "1",
    enabled: true,
    implementationFingerprint: "a".repeat(64),
    inventoryMode: "STATIC",
    approvedInventoryFingerprint: null,
    credentialBroker: {
      kind: "external-helper",
      helperPath: "/usr/local/bin/kodegpt-netlify-token",
      helperSha256: "b".repeat(64)
    },
    nonSecretAdapterConfig: {
      siteId: "site_123",
      repository: "2ndworld/kodeGPT",
      productionBranch: "main"
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function fixture(input?: {
  records?: ProviderRegistryRecord[];
  branch?: string | null;
  headOid?: string;
  remotes?: Array<{ name: string; fetchUrl: string }>;
  clean?: boolean;
  truncated?: boolean;
}) {
  const executions: ProviderSemanticExecutionInput[] = [];
  const records = input?.records ?? [providerRecord()];
  const repository = {
    inspect: async () => ({
      headOid: input?.headOid ?? OID,
      branch: input?.branch === undefined ? "feat/typed-preview" : input.branch,
      remotes: input?.remotes ?? [{ name: "origin", fetchUrl: "git@github.com:2ndworld/kodeGPT.git" }]
    })
  };
  const gitChanges = async () => ({ clean: input?.clean ?? true, truncated: input?.truncated ?? false });
  const runtime = {
    operator: { list: async () => records },
    gateway: {
      execute: async (request: ProviderSemanticExecutionInput): Promise<ProviderSemanticExecutionResult> => {
        executions.push(structuredClone(request));
        const value = request.semanticCapabilityId === "netlify.deploy.preview.create"
          ? {
              deploymentId: DEPLOYMENT_ID,
              branch: "feat/typed-preview",
              sourceOid: OID,
              createdAt: "2026-08-19T00:00:00Z"
            }
          : {
              deploymentId: DEPLOYMENT_ID,
              state: "ready",
              previewUrl: "https://deploy-123--example.netlify.app",
              branch: "feat/typed-preview",
              sourceOid: OID,
              createdAt: "2026-08-19T00:00:00Z",
              updatedAt: "2026-08-19T00:01:00Z"
            };
        return {
          semanticCapabilityId: request.semanticCapabilityId,
          providerInstanceId: request.providerInstanceId,
          value,
          truncated: false,
          truncationReasons: []
        };
      }
    }
  };
  return { runtime, repository, gitChanges, executions };
}

function factory(): unknown {
  return (providerGateway as Record<string, unknown>).createDeployPreviewToolAdapter;
}

function requireFactory(): (
  runtime: unknown,
  dependencies: unknown
) => {
  create(input: unknown): Promise<unknown>;
  inspect(input: unknown): Promise<unknown>;
} {
  expect(factory()).toBeTypeOf("function");
  return factory() as ReturnType<typeof requireFactory>;
}

function adapterFor(fx: ReturnType<typeof fixture>) {
  return requireFactory()(fx.runtime, { repository: fx.repository, gitChanges: fx.gitChanges });
}

describe("DeployPreviewToolAdapter", () => {
  it("exports only the concrete typed deployment bridge without generic provider invocation", () => {
    expect(factory()).toBeTypeOf("function");
    expect((providerGateway as Record<string, unknown>).providerInvoke).toBeUndefined();
    expect((providerGateway as Record<string, unknown>).NETLIFY_DEPLOY_PROVIDER_MANIFEST).toBeUndefined();
  });

  it("derives create identity from the clean workspace and admitted provider config", async () => {
    const fx = fixture();
    await expect(adapterFor(fx).create({ workspaceId: WORKSPACE_ID })).resolves.toEqual({
      deploymentId: DEPLOYMENT_ID,
      branch: "feat/typed-preview",
      sourceOid: OID,
      createdAt: "2026-08-19T00:00:00Z"
    });
    expect(fx.executions).toEqual([{
      semanticCapabilityId: "netlify.deploy.preview.create",
      providerInstanceId: PROVIDER_ID,
      workspaceId: WORKSPACE_ID,
      input: {
        siteId: "site_123",
        branch: "feat/typed-preview",
        expectedHeadOid: OID
      }
    }]);
  });

  it.each([
    ["detached HEAD", { branch: null }, "CAPABILITY_SOURCE_INVALID"],
    ["dirty checkpoint", { clean: false }, "CAPABILITY_SOURCE_INVALID"],
    ["truncated checkpoint", { truncated: true }, "CAPABILITY_SOURCE_INCOMPLETE"],
    ["production branch", { branch: "main" }, "CAPABILITY_SOURCE_INVALID"],
    ["repository mismatch", { remotes: [{ name: "origin", fetchUrl: "git@github.com:other/repo.git" }] }, "CAPABILITY_SOURCE_INVALID"]
  ])("fails create closed before provider mutation for %s", async (_label, overrides, expectedCode) => {
    const fx = fixture(overrides as Parameters<typeof fixture>[0]);
    await expect(adapterFor(fx).create({ workspaceId: WORKSPACE_ID })).rejects.toMatchObject({ code: expectedCode });
    expect(fx.executions).toEqual([]);
  });

  it("fails create closed for missing, disabled, ambiguous, or malformed provider admission", async () => {
    const cases: Array<[ProviderRegistryRecord[], string]> = [
      [[], "PROVIDER_NOT_ADMITTED"],
      [[providerRecord({ enabled: false })], "PROVIDER_DISABLED"],
      [[providerRecord(), providerRecord({ providerInstanceId: "prv_abcdef0123456789abcdef0123456789" })], "PROVIDER_STATE_INVALID"],
      [[providerRecord({ nonSecretAdapterConfig: { siteId: "https://evil.invalid", repository: "2ndworld/kodeGPT", productionBranch: "main" } })], "PROVIDER_STATE_INVALID"]
    ];
    for (const [records, code] of cases) {
      const fx = fixture({ records });
      await expect(adapterFor(fx).create({ workspaceId: WORKSPACE_ID })).rejects.toMatchObject({ code });
      expect(fx.executions).toEqual([]);
    }
  });

  it("inspect allows dirty or detached current state but preserves repository/provider binding", async () => {
    const fx = fixture({ clean: false, truncated: true, branch: null, headOid: "b".repeat(40) });
    await expect(adapterFor(fx).inspect({ workspaceId: WORKSPACE_ID, deploymentId: DEPLOYMENT_ID })).resolves.toEqual({
      deploymentId: DEPLOYMENT_ID,
      state: "ready",
      previewUrl: "https://deploy-123--example.netlify.app",
      branch: "feat/typed-preview",
      sourceOid: OID,
      createdAt: "2026-08-19T00:00:00Z",
      updatedAt: "2026-08-19T00:01:00Z"
    });
    expect(fx.executions).toEqual([{
      semanticCapabilityId: "netlify.deploy.preview.inspect",
      providerInstanceId: PROVIDER_ID,
      workspaceId: WORKSPACE_ID,
      input: { siteId: "site_123", deploymentId: DEPLOYMENT_ID }
    }]);
  });

  it("inspect fails before provider read when current repository no longer matches admission", async () => {
    const fx = fixture({ remotes: [{ name: "origin", fetchUrl: "git@github.com:other/repo.git" }] });
    await expect(adapterFor(fx).inspect({ workspaceId: WORKSPACE_ID, deploymentId: DEPLOYMENT_ID })).rejects.toEqual(
      new CapabilityError("CAPABILITY_SOURCE_INVALID", "Trusted workspace repository does not match admitted Netlify provider repository")
    );
    expect(fx.executions).toEqual([]);
  });
});
