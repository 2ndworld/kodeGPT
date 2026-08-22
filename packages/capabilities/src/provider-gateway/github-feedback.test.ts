import { describe, expect, it } from "vitest";

import {
  GITHUB_READ_PROVIDER_MANIFEST,
  GitHubPrFeedbackInspectInputSchema,
  GitHubPrFeedbackResultSchema,
  GitHubPrInspectResultSchema
} from "./github.js";
import {
  GITHUB_WRITE_PROVIDER_MANIFEST,
  GitHubPrFeedbackReplyInputSchema,
  GitHubPrFeedbackReplyResultSchema
} from "./github-write.js";
import { parseProviderSemanticOutput } from "./output.js";

const REPOSITORY = "2ndworld/kodeGPT";
const HEAD_OID = "a".repeat(40);
const COMMENT_OID = "b".repeat(40);

function readOperation(id: string) {
  const found = GITHUB_READ_PROVIDER_MANIFEST.operations.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing read operation ${id}`);
  return found;
}

function readMapping(id: string) {
  const found = GITHUB_READ_PROVIDER_MANIFEST.mappings.find((item) => item.semanticCapabilityId === id);
  if (found === undefined) throw new Error(`missing read mapping ${id}`);
  return found;
}

function writeOperation(id: string) {
  const found = GITHUB_WRITE_PROVIDER_MANIFEST.operations.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing write operation ${id}`);
  return found;
}

function writeMapping(id: string) {
  const found = GITHUB_WRITE_PROVIDER_MANIFEST.mappings.find((item) => item.semanticCapabilityId === id);
  if (found === undefined) throw new Error(`missing write mapping ${id}`);
  return found;
}

describe("GitHub review feedback provider contracts", () => {
  it("adds only two fixed REST reads for reviews and review comments", () => {
    const reviews = readOperation("pr.feedback.reviews");
    const comments = readOperation("pr.feedback.comments");
    expect({ method: reviews.method, path: reviews.pathTemplate, query: reviews.allowedQueryKeys }).toEqual({
      method: "GET",
      path: "/repos/{owner}/{repo}/pulls/{number}/reviews",
      query: ["per_page"]
    });
    expect({ method: comments.method, path: comments.pathTemplate, query: comments.allowedQueryKeys }).toEqual({
      method: "GET",
      path: "/repos/{owner}/{repo}/pulls/{number}/comments",
      query: ["per_page"]
    });
    expect(readMapping("github.pr.feedback.reviews")).toMatchObject({
      adapterOperationId: "pr.feedback.reviews",
      effect: "REMOTE_READ",
      maxProviderRequests: 1,
      retry: "none"
    });
    expect(readMapping("github.pr.feedback.comments")).toMatchObject({
      adapterOperationId: "pr.feedback.comments",
      effect: "REMOTE_READ",
      maxProviderRequests: 1,
      retry: "none"
    });
  });

  it("bounds one public inspect request and asks REST for limit+1 evidence", () => {
    const input = GitHubPrFeedbackInspectInputSchema.parse({ repository: REPOSITORY, number: 73, limit: 2 });
    expect(readOperation("pr.feedback.reviews").encodeRequest(input)).toEqual({
      pathParameters: { owner: "2ndworld", repo: "kodeGPT", number: "73" },
      query: { per_page: 3 }
    });
    expect(readOperation("pr.feedback.comments").encodeRequest(input)).toEqual({
      pathParameters: { owner: "2ndworld", repo: "kodeGPT", number: "73" },
      query: { per_page: 3 }
    });
    expect(() => GitHubPrFeedbackInspectInputSchema.parse({ repository: REPOSITORY, number: 73, limit: 51 })).toThrow();
    expect(() => GitHubPrFeedbackInspectInputSchema.parse({ repository: REPOSITORY, number: 73, endpoint: "/graphql" })).toThrow();
  });

  it("normalizes and truncates review evidence without leaking provider extras", () => {
    const input = GitHubPrFeedbackInspectInputSchema.parse({ repository: REPOSITORY, number: 73, limit: 1 });
    const mapping = readMapping("github.pr.feedback.reviews");
    const value = parseProviderSemanticOutput(
      Buffer.from(JSON.stringify([
        {
          id: 1001,
          user: { login: "reviewer" },
          body: "x".repeat(3000),
          state: "CHANGES_REQUESTED",
          html_url: "https://github.com/2ndworld/kodeGPT/pull/73#pullrequestreview-1001",
          commit_id: COMMENT_OID,
          submitted_at: "2026-08-22T10:00:00Z",
          authorization: "[REDACTED_SECRET]"
        },
        {
          id: 1002,
          user: { login: "reviewer" },
          body: "later",
          state: "APPROVED",
          html_url: "https://github.com/2ndworld/kodeGPT/pull/73#pullrequestreview-1002",
          commit_id: HEAD_OID,
          submitted_at: "2026-08-22T11:00:00Z"
        }
      ])),
      mapping.outputSchema,
      { semanticInput: input, mapOutput: mapping.mapOutput }
    ) as { items: Array<Record<string, unknown>>; truncated: boolean };

    expect(value.truncated).toBe(true);
    expect(value.items).toHaveLength(1);
    expect(value.items[0]).toMatchObject({
      reviewId: 1001,
      authorLogin: "reviewer",
      state: "CHANGES_REQUESTED",
      commitOid: COMMENT_OID,
      bodyTruncated: true
    });
    expect(Buffer.byteLength(String(value.items[0]?.body), "utf8")).toBeLessThanOrEqual(2048);
    expect(value.items[0]).not.toHaveProperty("authorization");
  });

  it("normalizes review comments with stable file, line, reply and commit identifiers", () => {
    const input = GitHubPrFeedbackInspectInputSchema.parse({ repository: REPOSITORY, number: 73, limit: 5 });
    const mapping = readMapping("github.pr.feedback.comments");
    const value = parseProviderSemanticOutput(
      Buffer.from(JSON.stringify([
        {
          id: 2001,
          pull_request_review_id: 1001,
          user: { login: "reviewer" },
          body: "Please handle this edge case",
          diff_hunk: "@@ -1 +1 @@\n-old\n+new",
          path: "packages/capabilities/src/provider-gateway/github.ts",
          line: 42,
          original_line: 41,
          start_line: 40,
          original_start_line: 39,
          side: "RIGHT",
          start_side: "RIGHT",
          commit_id: HEAD_OID,
          original_commit_id: COMMENT_OID,
          in_reply_to_id: null,
          html_url: "https://github.com/2ndworld/kodeGPT/pull/73#discussion_r2001",
          created_at: "2026-08-22T10:01:00Z",
          updated_at: "2026-08-22T10:02:00Z",
          token: "[REDACTED_SECRET]"
        }
      ])),
      mapping.outputSchema,
      { semanticInput: input, mapOutput: mapping.mapOutput }
    ) as { items: Array<Record<string, unknown>>; truncated: boolean };

    expect(value.truncated).toBe(false);
    expect(value.items).toEqual([{
      commentId: 2001,
      reviewId: 1001,
      authorLogin: "reviewer",
      body: "Please handle this edge case",
      bodyTruncated: false,
      diffHunk: "@@ -1 +1 @@\n-old\n+new",
      diffHunkTruncated: false,
      path: "packages/capabilities/src/provider-gateway/github.ts",
      line: 42,
      originalLine: 41,
      startLine: 40,
      originalStartLine: 39,
      side: "RIGHT",
      startSide: "RIGHT",
      commitOid: HEAD_OID,
      originalCommitOid: COMMENT_OID,
      inReplyToId: null,
      htmlUrl: "https://github.com/2ndworld/kodeGPT/pull/73#discussion_r2001",
      createdAt: "2026-08-22T10:01:00Z",
      updatedAt: "2026-08-22T10:02:00Z"
    }]);
  });

  it("exposes the exact PR head OID for guarded feedback mutations", () => {
    const mapping = readMapping("github.pr.inspect");
    const input = { repository: REPOSITORY, number: 73 };
    const value = parseProviderSemanticOutput(
      Buffer.from(JSON.stringify({
        number: 73,
        title: "P1-D",
        state: "open",
        user: { login: "2ndworld" },
        base: { ref: "main", repo: { full_name: REPOSITORY } },
        head: { ref: "feat/p1d", sha: HEAD_OID },
        merged: false,
        draft: false,
        html_url: "https://github.com/2ndworld/kodeGPT/pull/73",
        created_at: "2026-08-22T09:00:00Z",
        updated_at: "2026-08-22T10:00:00Z",
        closed_at: null,
        merged_at: null
      })),
      GitHubPrInspectResultSchema,
      { semanticInput: input, mapOutput: mapping.mapOutput }
    );
    expect(value).toMatchObject({ repository: REPOSITORY, number: 73, headOid: HEAD_OID });
  });

  it("adds one strict single-attempt REST reply mutation and never accepts generic provider authority", () => {
    const input = GitHubPrFeedbackReplyInputSchema.parse({
      repository: REPOSITORY,
      number: 73,
      commentId: 2001,
      expectedHeadOid: HEAD_OID,
      body: "Fixed in the current head."
    });
    expect(() => GitHubPrFeedbackReplyInputSchema.parse({ ...input, endpoint: "/graphql" })).toThrow();
    expect(() => GitHubPrFeedbackReplyInputSchema.parse({ ...input, body: "x".repeat(8 * 1024 + 1) })).toThrow();

    const operation = writeOperation("pr.feedback.reply");
    expect({ method: operation.method, path: operation.pathTemplate, query: operation.allowedQueryKeys }).toEqual({
      method: "POST",
      path: "/repos/{owner}/{repo}/pulls/{number}/comments/{commentId}/replies",
      query: []
    });
    expect(operation.encodeRequest(input)).toEqual({
      pathParameters: { owner: "2ndworld", repo: "kodeGPT", number: "73", commentId: "2001" },
      body: { body: "Fixed in the current head." }
    });
    expect(writeMapping("github.pr.feedback.reply")).toMatchObject({
      effect: "REMOTE_MUTATION",
      maxProviderRequests: 1,
      retry: "none"
    });

    const mapping = writeMapping("github.pr.feedback.reply");
    const result = parseProviderSemanticOutput(
      Buffer.from(JSON.stringify({
        id: 2002,
        pull_request_review_id: 1001,
        user: { login: "2ndworld" },
        body: "Fixed in the current head.",
        in_reply_to_id: 2001,
        html_url: "https://github.com/2ndworld/kodeGPT/pull/73#discussion_r2002",
        created_at: "2026-08-22T11:00:00Z",
        authorization: "[REDACTED_SECRET]"
      })),
      GitHubPrFeedbackReplyResultSchema,
      { semanticInput: input, mapOutput: mapping.mapOutput }
    );
    expect(result).toEqual({
      repository: REPOSITORY,
      number: 73,
      commentId: 2002,
      rootCommentId: 2001,
      authorLogin: "2ndworld",
      body: "Fixed in the current head.",
      htmlUrl: "https://github.com/2ndworld/kodeGPT/pull/73#discussion_r2002",
      createdAt: "2026-08-22T11:00:00Z"
    });
  });

  it("locks the final public feedback result to bounded reviews and grouped threads", () => {
    expect(GitHubPrFeedbackResultSchema.safeParse({
      repository: REPOSITORY,
      number: 73,
      reviews: [],
      threads: [],
      reviewListTruncated: false,
      commentListTruncated: false,
      changeRequestedReviewIds: []
    }).success).toBe(true);
  });
});
