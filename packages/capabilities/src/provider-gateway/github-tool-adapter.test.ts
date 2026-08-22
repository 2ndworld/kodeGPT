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
  headOid: "a".repeat(40),
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

const feedbackReviewsValue = {
  repository: "2ndworld/kodeGPT",
  number: 20,
  items: [{
    reviewId: 101,
    authorLogin: "reviewer",
    body: "Please address these comments.",
    bodyTruncated: false,
    state: "CHANGES_REQUESTED",
    commitOid: "a".repeat(40),
    htmlUrl: "https://github.com/2ndworld/kodeGPT/pull/20#pullrequestreview-101",
    submittedAt: "2026-08-17T00:30:00Z"
  }],
  truncated: false
};

const feedbackCommentsValue = {
  repository: "2ndworld/kodeGPT",
  number: 20,
  items: [
    {
      commentId: 3001,
      reviewId: 101,
      authorLogin: "reviewer",
      body: "Second thread.",
      bodyTruncated: false,
      diffHunk: "@@ -30 +30 @@",
      diffHunkTruncated: false,
      path: "src/second.ts",
      line: 30,
      originalLine: 30,
      startLine: null,
      originalStartLine: null,
      side: "RIGHT",
      startSide: null,
      commitOid: "a".repeat(40),
      originalCommitOid: "9".repeat(40),
      inReplyToId: null,
      htmlUrl: "https://github.com/2ndworld/kodeGPT/pull/20#discussion_r3001",
      createdAt: "2026-08-17T00:32:00Z",
      updatedAt: "2026-08-17T00:32:00Z"
    },
    {
      commentId: 2001,
      reviewId: 101,
      authorLogin: "reviewer",
      body: "Root comment.",
      bodyTruncated: false,
      diffHunk: "@@ -10 +10 @@",
      diffHunkTruncated: false,
      path: "src/first.ts",
      line: 10,
      originalLine: 10,
      startLine: null,
      originalStartLine: null,
      side: "RIGHT",
      startSide: null,
      commitOid: "a".repeat(40),
      originalCommitOid: "9".repeat(40),
      inReplyToId: null,
      htmlUrl: "https://github.com/2ndworld/kodeGPT/pull/20#discussion_r2001",
      createdAt: "2026-08-17T00:31:00Z",
      updatedAt: "2026-08-17T00:31:00Z"
    },
    {
      commentId: 2002,
      reviewId: 101,
      authorLogin: "2ndworld",
      body: "Addressed.",
      bodyTruncated: false,
      diffHunk: "@@ -10 +10 @@",
      diffHunkTruncated: false,
      path: "src/first.ts",
      line: 10,
      originalLine: 10,
      startLine: null,
      originalStartLine: null,
      side: "RIGHT",
      startSide: null,
      commitOid: "a".repeat(40),
      originalCommitOid: "9".repeat(40),
      inReplyToId: 2001,
      htmlUrl: "https://github.com/2ndworld/kodeGPT/pull/20#discussion_r2002",
      createdAt: "2026-08-17T00:33:00Z",
      updatedAt: "2026-08-17T00:33:00Z"
    }
  ],
  truncated: false
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
  prFeedbackInspect(input: unknown): Promise<unknown>;
  issueInspect(input: unknown): Promise<unknown>;
  issueList(input: unknown): Promise<unknown>;
} {
  const factory = adapterFactory();
  expect(factory).toBeTypeOf("function");
  return factory as ReturnType<typeof requireFactory> extends never ? never : (runtime: unknown) => {
    repositoryInspect(input: unknown): Promise<unknown>;
    prInspect(input: unknown): Promise<unknown>;
    prList(input: unknown): Promise<unknown>;
    prFeedbackInspect(input: unknown): Promise<unknown>;
    issueInspect(input: unknown): Promise<unknown>;
    issueList(input: unknown): Promise<unknown>;
  };
}

describe("GitHubReadToolAdapter", () => {
  it("exports only the concrete typed bridge/contracts instead of provider control internals", () => {
    expect(adapterFactory()).toBeTypeOf("function");
    expect((providerGateway as Record<string, unknown>).providerInvoke).toBeUndefined();
    expect((providerGateway as Record<string, unknown>).GITHUB_READ_PROVIDER_MANIFEST).toBeUndefined();
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

  it("composes review feedback through one selected provider and groups stable root threads", async () => {
    const fx = runtimeFixture([providerRecord()], {
      "github.pr.feedback.reviews": feedbackReviewsValue,
      "github.pr.feedback.comments": feedbackCommentsValue
    });
    const adapter = requireFactory()(fx.runtime);

    await expect(adapter.prFeedbackInspect({
      repository: "2ndworld/kodeGPT",
      number: 20,
      limit: 5
    })).resolves.toEqual({
      repository: "2ndworld/kodeGPT",
      number: 20,
      reviews: feedbackReviewsValue.items,
      threads: [
        {
          rootCommentId: 2001,
          path: "src/first.ts",
          line: 10,
          originalLine: 10,
          startLine: null,
          originalStartLine: null,
          side: "RIGHT",
          startSide: null,
          comments: [feedbackCommentsValue.items[1], feedbackCommentsValue.items[2]]
        },
        {
          rootCommentId: 3001,
          path: "src/second.ts",
          line: 30,
          originalLine: 30,
          startLine: null,
          originalStartLine: null,
          side: "RIGHT",
          startSide: null,
          comments: [feedbackCommentsValue.items[0]]
        }
      ],
      reviewListTruncated: false,
      commentListTruncated: false,
      changeRequestedReviewIds: [101]
    });
    expect(fx.executions.map(({ semanticCapabilityId }) => semanticCapabilityId)).toEqual([
      "github.pr.feedback.reviews",
      "github.pr.feedback.comments"
    ]);
    expect(fx.executions.every(({ providerInstanceId }) => providerInstanceId === PROVIDER_ID)).toBe(true);
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
