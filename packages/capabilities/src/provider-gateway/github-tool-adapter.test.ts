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

const repositoryValue = {
  repository: "2ndworld/kodeGPT",
  name: "kodeGPT",
  owner: "2ndworld",
  description: "KodeGPT",
  private: false,
  defaultBranch: "main",
  archived: false,
  fork: false,
  htmlUrl: "https://github.com/2ndworld/kodeGPT",
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-17T00:00:00Z",
  pushedAt: "2026-08-17T00:00:00Z"
};

const prValue = {
  repository: "2ndworld/kodeGPT",
  number: 20,
  title: "Skill Capability Resolution v2",
  state: "closed",
  authorLogin: "2ndworld",
  baseBranch: "main",
  headBranch: "feat/skill-capability-resolution-v2",
  merged: true,
  draft: false,
  htmlUrl: "https://github.com/2ndworld/kodeGPT/pull/20",
  createdAt: "2026-08-17T00:00:00Z",
  updatedAt: "2026-08-17T01:00:00Z",
  closedAt: "2026-08-17T01:00:00Z",
  mergedAt: "2026-08-17T01:00:00Z"
};

const prListValue = {
  repository: "2ndworld/kodeGPT",
  items: [{
    number: 20,
    title: "Skill Capability Resolution v2",
    state: "closed",
    authorLogin: "2ndworld",
    baseBranch: "main",
    headBranch: "feat/skill-capability-resolution-v2",
    draft: false,
    htmlUrl: "https://github.com/2ndworld/kodeGPT/pull/20",
    createdAt: "2026-08-17T00:00:00Z",
    updatedAt: "2026-08-17T01:00:00Z"
  }]
};

const issueValue = {
  repository: "2ndworld/kodeGPT",
  number: 1,
  title: "Example issue",
  state: "open",
  authorLogin: "2ndworld",
  htmlUrl: "https://github.com/2ndworld/kodeGPT/issues/1",
  createdAt: "2026-08-17T00:00:00Z",
  updatedAt: "2026-08-17T01:00:00Z",
  closedAt: null,
  commentsCount: 1,
  labels: ["bug"],
  assigneeLogins: ["2ndworld"]
};

const issueListValue = {
  repository: "2ndworld/kodeGPT",
  items: [Object.fromEntries(Object.entries(issueValue).filter(([key]) => key !== "repository"))]
};

function providerRecord(overrides: Partial<ProviderRegistryRecord> = {}): ProviderRegistryRecord {
  return {
    schemaVersion: 1,
    providerInstanceId: PROVIDER_ID,
    operatorName: "GitHub read",
    adapterId: "github.read.v1",
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

function adapterFactory(): unknown {
  return (providerGateway as Record<string, unknown>).createGitHubReadToolAdapter;
}

function runtimeFixture(records: ProviderRegistryRecord[], values: Record<string, unknown>) {
  const executions: ProviderSemanticExecutionInput[] = [];
  return {
    executions,
    runtime: {
      operator: {
        list: async () => records
      },
      gateway: {
        execute: async (input: ProviderSemanticExecutionInput): Promise<ProviderSemanticExecutionResult> => {
          executions.push(structuredClone(input));
          return {
            semanticCapabilityId: input.semanticCapabilityId,
            providerInstanceId: input.providerInstanceId,
            value: values[input.semanticCapabilityId],
            truncated: false,
            truncationReasons: []
          };
        }
      }
    }
  };
}

function requireFactory(): (runtime: unknown) => {
  repositoryInspect(input: unknown): Promise<unknown>;
  prInspect(input: unknown): Promise<unknown>;
  prList(input: unknown): Promise<unknown>;
  issueInspect(input: unknown): Promise<unknown>;
  issueList(input: unknown): Promise<unknown>;
} {
  const factory = adapterFactory();
  expect(factory).toBeTypeOf("function");
  return factory as ReturnType<typeof requireFactory> extends never ? never : (runtime: unknown) => {
    repositoryInspect(input: unknown): Promise<unknown>;
    prInspect(input: unknown): Promise<unknown>;
    prList(input: unknown): Promise<unknown>;
    issueInspect(input: unknown): Promise<unknown>;
    issueList(input: unknown): Promise<unknown>;
  };
}

describe("GitHubReadToolAdapter", () => {
  it("is exported as the concrete typed bridge instead of a generic provider invoker", () => {
    expect(adapterFactory()).toBeTypeOf("function");
    expect((providerGateway as Record<string, unknown>).providerInvoke).toBeUndefined();
  });

  it("routes all five fixed semantics through the one enabled github.read.v1 provider and returns only normalized values", async () => {
    const fx = runtimeFixture([providerRecord()], {
      "github.repository.inspect": repositoryValue,
      "github.pr.inspect": prValue,
      "github.pr.list": prListValue,
      "github.issue.inspect": issueValue,
      "github.issue.list": issueListValue
    });
    const adapter = requireFactory()(fx.runtime);

    await expect(adapter.repositoryInspect({ repository: "2ndworld/kodeGPT" })).resolves.toEqual(repositoryValue);
    await expect(adapter.prInspect({ repository: "2ndworld/kodeGPT", number: 20 })).resolves.toEqual(prValue);
    await expect(adapter.prList({ repository: "2ndworld/kodeGPT", state: "closed", limit: 5 })).resolves.toEqual(prListValue);
    await expect(adapter.issueInspect({ repository: "2ndworld/kodeGPT", number: 1 })).resolves.toEqual(issueValue);
    await expect(adapter.issueList({ repository: "2ndworld/kodeGPT", state: "open", limit: 5 })).resolves.toEqual(issueListValue);

    expect(fx.executions.map(({ semanticCapabilityId }) => semanticCapabilityId)).toEqual([
      "github.repository.inspect",
      "github.pr.inspect",
      "github.pr.list",
      "github.issue.inspect",
      "github.issue.list"
    ]);
    expect(fx.executions.every(({ providerInstanceId }) => providerInstanceId === PROVIDER_ID)).toBe(true);
    expect(fx.executions[0]).toMatchObject({
      semanticCapabilityId: "github.repository.inspect",
      providerInstanceId: PROVIDER_ID,
      input: { repository: "2ndworld/kodeGPT" }
    });
  });

  it("fails closed when github.read.v1 is not admitted", async () => {
    const fx = runtimeFixture([], { "github.repository.inspect": repositoryValue });
    const adapter = requireFactory()(fx.runtime);

    await expect(adapter.repositoryInspect({ repository: "2ndworld/kodeGPT" })).rejects.toEqual(
      new CapabilityError("PROVIDER_NOT_ADMITTED", "GitHub read provider is not admitted")
    );
    expect(fx.executions).toEqual([]);
  });

  it("fails closed when the admitted github.read.v1 provider is disabled", async () => {
    const fx = runtimeFixture([providerRecord({ enabled: false })], { "github.repository.inspect": repositoryValue });
    const adapter = requireFactory()(fx.runtime);

    await expect(adapter.repositoryInspect({ repository: "2ndworld/kodeGPT" })).rejects.toEqual(
      new CapabilityError("PROVIDER_DISABLED", "GitHub read provider is disabled")
    );
    expect(fx.executions).toEqual([]);
  });

  it("fails closed instead of choosing among multiple enabled github.read.v1 providers", async () => {
    const fx = runtimeFixture([
      providerRecord(),
      providerRecord({ providerInstanceId: "prv_abcdef0123456789abcdef0123456789" })
    ], { "github.repository.inspect": repositoryValue });
    const adapter = requireFactory()(fx.runtime);

    await expect(adapter.repositoryInspect({ repository: "2ndworld/kodeGPT" })).rejects.toEqual(
      new CapabilityError("PROVIDER_STATE_INVALID", "Multiple enabled GitHub read providers are admitted")
    );
    expect(fx.executions).toEqual([]);
  });
});
