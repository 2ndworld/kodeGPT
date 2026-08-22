import type { z } from "zod";

import { CapabilityError } from "../errors.js";
import type { ProviderGatewayRuntime } from "./production.js";
import {
  GITHUB_READ_PROVIDER_ADAPTER_ID,
  GitHubIssueInspectResultSchema,
  GitHubIssueListResultSchema,
  GitHubPrFeedbackCommentsResultSchema,
  GitHubPrFeedbackResultSchema,
  GitHubPrFeedbackReviewsResultSchema,
  GitHubPrInspectResultSchema,
  GitHubPrListResultSchema,
  GitHubRepositoryInspectResultSchema,
  type GitHubIssueInspectInput,
  type GitHubIssueInspectResult,
  type GitHubIssueListInput,
  type GitHubIssueListResult,
  type GitHubPrFeedbackCommentsResult,
  type GitHubPrFeedbackInspectInput,
  type GitHubPrFeedbackResult,
  type GitHubPrFeedbackReviewsResult,
  type GitHubPrInspectInput,
  type GitHubPrInspectResult,
  type GitHubPrListInput,
  type GitHubPrListResult,
  type GitHubRepositoryInspectInput,
  type GitHubRepositoryInspectResult
} from "./github.js";

export interface GitHubReadToolAdapter {
  repositoryInspect(input: GitHubRepositoryInspectInput): Promise<GitHubRepositoryInspectResult>;
  prInspect(input: GitHubPrInspectInput): Promise<GitHubPrInspectResult>;
  prList(input: GitHubPrListInput): Promise<GitHubPrListResult>;
  prFeedbackInspect(input: GitHubPrFeedbackInspectInput): Promise<GitHubPrFeedbackResult>;
  issueInspect(input: GitHubIssueInspectInput): Promise<GitHubIssueInspectResult>;
  issueList(input: GitHubIssueListInput): Promise<GitHubIssueListResult>;
}

export function createGitHubReadToolAdapter(
  runtime: Pick<ProviderGatewayRuntime, "operator" | "gateway">
): GitHubReadToolAdapter {
  return {
    repositoryInspect: (input) =>
      execute(runtime, "github.repository.inspect", input, GitHubRepositoryInspectResultSchema),
    prInspect: (input) => execute(runtime, "github.pr.inspect", input, GitHubPrInspectResultSchema),
    prList: (input) => execute(runtime, "github.pr.list", input, GitHubPrListResultSchema),
    prFeedbackInspect: (input) => inspectPrFeedback(runtime, input),
    issueInspect: (input) =>
      execute(runtime, "github.issue.inspect", input, GitHubIssueInspectResultSchema),
    issueList: (input) => execute(runtime, "github.issue.list", input, GitHubIssueListResultSchema)
  };
}

async function inspectPrFeedback(
  runtime: Pick<ProviderGatewayRuntime, "operator" | "gateway">,
  input: GitHubPrFeedbackInspectInput
): Promise<GitHubPrFeedbackResult> {
  const providerInstanceId = await selectedProviderInstanceId(runtime);
  const reviews = await executeWithProvider(
    runtime,
    providerInstanceId,
    "github.pr.feedback.reviews",
    input,
    GitHubPrFeedbackReviewsResultSchema
  ) as GitHubPrFeedbackReviewsResult;
  const comments = await executeWithProvider(
    runtime,
    providerInstanceId,
    "github.pr.feedback.comments",
    input,
    GitHubPrFeedbackCommentsResultSchema
  ) as GitHubPrFeedbackCommentsResult;

  const threads = groupFeedbackThreads(comments.items);
  return GitHubPrFeedbackResultSchema.parse({
    repository: reviews.repository,
    number: reviews.number,
    reviews: reviews.items,
    threads,
    reviewListTruncated: reviews.truncated,
    commentListTruncated: comments.truncated,
    changeRequestedReviewIds: reviews.items
      .filter((review) => review.state === "CHANGES_REQUESTED")
      .map((review) => review.reviewId)
  });
}

function groupFeedbackThreads(comments: GitHubPrFeedbackCommentsResult["items"]) {
  const threads = new Map<number, {
    rootCommentId: number;
    path: string;
    line: number | null;
    originalLine: number | null;
    startLine: number | null;
    originalStartLine: number | null;
    side: "LEFT" | "RIGHT" | null;
    startSide: "LEFT" | "RIGHT" | null;
    comments: GitHubPrFeedbackCommentsResult["items"];
  }>();

  for (const comment of comments) {
    const rootCommentId = comment.inReplyToId ?? comment.commentId;
    let thread = threads.get(rootCommentId);
    if (thread === undefined) {
      thread = {
        rootCommentId,
        path: comment.path,
        line: comment.line,
        originalLine: comment.originalLine,
        startLine: comment.startLine,
        originalStartLine: comment.originalStartLine,
        side: comment.side,
        startSide: comment.startSide,
        comments: []
      };
      threads.set(rootCommentId, thread);
    }
    if (comment.commentId === rootCommentId) {
      thread.path = comment.path;
      thread.line = comment.line;
      thread.originalLine = comment.originalLine;
      thread.startLine = comment.startLine;
      thread.originalStartLine = comment.originalStartLine;
      thread.side = comment.side;
      thread.startSide = comment.startSide;
    }
    thread.comments.push(comment);
  }

  return [...threads.values()].sort((left, right) => left.rootCommentId - right.rootCommentId);
}

async function execute<T>(
  runtime: Pick<ProviderGatewayRuntime, "operator" | "gateway">,
  semanticCapabilityId: string,
  input: unknown,
  outputSchema: z.ZodType<T>
): Promise<T> {
  const providerInstanceId = await selectedProviderInstanceId(runtime);
  return executeWithProvider(runtime, providerInstanceId, semanticCapabilityId, input, outputSchema);
}

async function executeWithProvider<T>(
  runtime: Pick<ProviderGatewayRuntime, "gateway">,
  providerInstanceId: string,
  semanticCapabilityId: string,
  input: unknown,
  outputSchema: z.ZodType<T>
): Promise<T> {
  const result = await runtime.gateway.execute({
    semanticCapabilityId,
    providerInstanceId,
    input
  });
  return outputSchema.parse(result.value);
}

async function selectedProviderInstanceId(
  runtime: Pick<ProviderGatewayRuntime, "operator">
): Promise<string> {
  const matching = (await runtime.operator.list()).filter(
    (record) => record.adapterId === GITHUB_READ_PROVIDER_ADAPTER_ID
  );
  if (matching.length === 0) {
    throw new CapabilityError("PROVIDER_NOT_ADMITTED", "GitHub read provider is not admitted");
  }

  const enabled = matching.filter((record) => record.enabled);
  if (enabled.length === 0) {
    throw new CapabilityError("PROVIDER_DISABLED", "GitHub read provider is disabled");
  }
  if (enabled.length !== 1) {
    throw new CapabilityError(
      "PROVIDER_STATE_INVALID",
      "Multiple enabled GitHub read providers are admitted"
    );
  }
  return enabled[0]!.providerInstanceId;
}
