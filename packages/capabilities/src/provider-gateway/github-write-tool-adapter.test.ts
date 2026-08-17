import { describe, expect, it } from "vitest";

import { CapabilityError } from "../errors.js";
import * as providerGateway from "./index.js";
import type {
  ProviderRegistryRecord,
  ProviderSemanticExecutionInput,
  ProviderSemanticExecutionResult
} from "./contracts.js";

const PROVIDER_ID = "prv_0123456789abcdef0123456789abcdef";
const NOW = "2026-08-17T00:00:00.000Z";
const OID = "a".repeat(40);

const createValue = {
  repository: "2ndworld/kodeGPT",
  number: 23,
  title: "feat: bounded write",
  state: "open",
  authorLogin: "2ndworld",
  baseBranch: "main",
  headBranch: "feat/bounded-write",
  draft: false,
  htmlUrl: "https://github.com/2ndworld/kodeGPT/pull/23",
  createdAt: "2026-08-17T06:30:00Z",
  updatedAt: "2026-08-17T06:30:00Z"
};

const mergeValue = {
  repository: "2ndworld/kodeGPT",
  number: 23,
  merged: true,
  mergeCommitOid: "b".repeat(40)
};

function providerRecord(overrides: Partial<ProviderRegistryRecord> = {}): ProviderRegistryRecord {
  return {
    schemaVersion: 1,
    providerInstanceId: PROVIDER_ID,
    operatorName: "GitHub write",
    adapterId: "github.write.v1",
    adapterContractVersion: "1",
    enabled: true,
    implementationFingerprint: "a".repeat(64),
    inventoryMode: "STATIC",
    approvedInventoryFingerprint: null,
    credentialBroker: {
      kind: "external-helper",
      helperPath: "/usr/bin/gh",
      helperSha256: "b".repeat(64)
    },
    nonSecretAdapterConfig: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function runtimeFixture(records: ProviderRegistryRecord[]) {
  const executions: ProviderSemanticExecutionInput[] = [];
  return {
    executions,
    runtime: {
      operator: { list: async () => records },
      gateway: {
        execute: async (input: ProviderSemanticExecutionInput): Promise<ProviderSemanticExecutionResult> => {
          executions.push(structuredClone(input));
          return {
            semanticCapabilityId: input.semanticCapabilityId,
            providerInstanceId: input.providerInstanceId,
            value: input.semanticCapabilityId === "github.pr.create" ? createValue : mergeValue,
            truncated: false,
            truncationReasons: []
          };
        }
      }
    }
  };
}

function factory(): unknown {
  return (providerGateway as Record<string, unknown>).createGitHubWriteToolAdapter;
}

function requireFactory(): (runtime: unknown) => {
  prCreate(input: unknown): Promise<unknown>;
  prMerge(input: unknown): Promise<unknown>;
} {
  const value = factory();
  expect(value).toBeTypeOf("function");
  return value as (runtime: unknown) => {
    prCreate(input: unknown): Promise<unknown>;
    prMerge(input: unknown): Promise<unknown>;
  };
}

describe("GitHubWriteToolAdapter", () => {
  it("exports only the concrete write bridge without generic provider invocation", () => {
    expect(factory()).toBeTypeOf("function");
    expect((providerGateway as Record<string, unknown>).providerInvoke).toBeUndefined();
    expect((providerGateway as Record<string, unknown>).GITHUB_WRITE_PROVIDER_MANIFEST).toBeUndefined();
  });

  it("routes exactly create and guarded merge through one enabled github.write.v1 provider", async () => {
    const fx = runtimeFixture([providerRecord()]);
    const adapter = requireFactory()(fx.runtime);

    await expect(adapter.prCreate({
      repository: "2ndworld/kodeGPT",
      title: "feat: bounded write",
      headBranch: "feat/bounded-write",
      baseBranch: "main"
    })).resolves.toEqual(createValue);
    await expect(adapter.prMerge({
      repository: "2ndworld/kodeGPT",
      number: 23,
      expectedHeadOid: OID
    })).resolves.toEqual(mergeValue);

    expect(fx.executions).toEqual([
      {
        semanticCapabilityId: "github.pr.create",
        providerInstanceId: PROVIDER_ID,
        input: {
          repository: "2ndworld/kodeGPT",
          title: "feat: bounded write",
          headBranch: "feat/bounded-write",
          baseBranch: "main"
        }
      },
      {
        semanticCapabilityId: "github.pr.merge",
        providerInstanceId: PROVIDER_ID,
        input: { repository: "2ndworld/kodeGPT", number: 23, expectedHeadOid: OID }
      }
    ]);
  });

  it("fails closed when github.write.v1 is not admitted", async () => {
    const adapter = requireFactory()(runtimeFixture([]).runtime);
    await expect(adapter.prCreate({
      repository: "2ndworld/kodeGPT",
      title: "x",
      headBranch: "feat/x",
      baseBranch: "main"
    })).rejects.toEqual(new CapabilityError("PROVIDER_NOT_ADMITTED", "GitHub write provider is not admitted"));
  });

  it("fails closed when github.write.v1 is disabled", async () => {
    const adapter = requireFactory()(runtimeFixture([providerRecord({ enabled: false })]).runtime);
    await expect(adapter.prMerge({ repository: "2ndworld/kodeGPT", number: 23, expectedHeadOid: OID }))
      .rejects.toEqual(new CapabilityError("PROVIDER_DISABLED", "GitHub write provider is disabled"));
  });

  it("fails closed instead of choosing among multiple enabled write providers", async () => {
    const adapter = requireFactory()(runtimeFixture([
      providerRecord(),
      providerRecord({ providerInstanceId: "prv_abcdef0123456789abcdef0123456789" })
    ]).runtime);
    await expect(adapter.prMerge({ repository: "2ndworld/kodeGPT", number: 23, expectedHeadOid: OID }))
      .rejects.toEqual(new CapabilityError(
        "PROVIDER_STATE_INVALID",
        "Multiple enabled GitHub write providers are admitted"
      ));
  });
});
