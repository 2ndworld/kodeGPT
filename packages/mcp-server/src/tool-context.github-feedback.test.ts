import { describe, expect, it } from "vitest";

import { createKodegptToolContext } from "./tool-context.js";

const REPOSITORY = "2ndworld/kodeGPT";
const EXPECTED_HEAD = "a".repeat(40);
const STALE_HEAD = "b".repeat(40);

function baseOptions(input: {
  headOid: string;
  onInspect: () => void;
  onReply: () => void;
}) {
  return {
    workspaceManager: {} as never,
    executionManager: {} as never,
    artifactStore: {} as never,
    githubRead: {
      repositoryInspect: async () => ({}),
      prInspect: async ({ repository, number }: { repository: string; number: number }) => {
        input.onInspect();
        return {
          repository,
          number,
          title: "P1-D",
          state: "open" as const,
          authorLogin: "2ndworld",
          baseBranch: "main",
          headBranch: "feat/p1d-github-review-feedback-loop",
          headOid: input.headOid,
          merged: false,
          draft: false,
          htmlUrl: `https://github.com/${repository}/pull/${number}`,
          createdAt: "2026-08-22T09:00:00Z",
          updatedAt: "2026-08-22T10:00:00Z",
          closedAt: null,
          mergedAt: null
        };
      },
      prList: async () => ({ repository: REPOSITORY, items: [] }),
      prFeedbackInspect: async () => ({
        repository: REPOSITORY,
        number: 74,
        reviews: [],
        threads: [],
        reviewListTruncated: false,
        commentListTruncated: false,
        changeRequestedReviewIds: []
      }),
      issueInspect: async () => ({}),
      issueList: async () => ({ repository: REPOSITORY, items: [] })
    } as never,
    githubWrite: {
      prCreate: async () => ({}),
      prMerge: async () => ({}),
      prFeedbackReply: async ({ repository, number, commentId, body }: {
        repository: string;
        number: number;
        commentId: number;
        body: string;
      }) => {
        input.onReply();
        return {
          repository,
          number,
          commentId: commentId + 1,
          rootCommentId: commentId,
          authorLogin: "2ndworld",
          body,
          htmlUrl: `https://github.com/${repository}/pull/${number}#discussion_r${commentId + 1}`,
          createdAt: "2026-08-22T11:00:00Z"
        };
      }
    } as never,
    inspectProfile: () => ({}),
    capabilities: () => ({}),
    health: () => ({})
  };
}

describe("GitHub review feedback tool-context guard", () => {
  it("checks the exact current PR head before forwarding one review reply mutation", async () => {
    let inspectCalls = 0;
    let replyCalls = 0;
    const context = createKodegptToolContext(baseOptions({
      headOid: EXPECTED_HEAD,
      onInspect: () => { inspectCalls += 1; },
      onReply: () => { replyCalls += 1; }
    }));

    await expect(context.github.prFeedbackReply({
      repository: REPOSITORY,
      number: 74,
      commentId: 2001,
      expectedHeadOid: EXPECTED_HEAD,
      body: "Fixed in the current head."
    })).resolves.toMatchObject({
      repository: REPOSITORY,
      number: 74,
      rootCommentId: 2001
    });

    expect(inspectCalls).toBe(1);
    expect(replyCalls).toBe(1);
  });

  it("fails stale expected-head state before any remote reply mutation", async () => {
    let inspectCalls = 0;
    let replyCalls = 0;
    const context = createKodegptToolContext(baseOptions({
      headOid: STALE_HEAD,
      onInspect: () => { inspectCalls += 1; },
      onReply: () => { replyCalls += 1; }
    }));

    await expect(context.github.prFeedbackReply({
      repository: REPOSITORY,
      number: 74,
      commentId: 2001,
      expectedHeadOid: EXPECTED_HEAD,
      body: "Fixed in the current head."
    })).rejects.toMatchObject({
      code: "PROVIDER_STATE_INVALID",
      details: {
        reason: "STALE_EXPECTED_STATE",
        retryable: false,
        suggestedAction: "refresh-state"
      }
    });

    expect(inspectCalls).toBe(1);
    expect(replyCalls).toBe(0);
  });
});
