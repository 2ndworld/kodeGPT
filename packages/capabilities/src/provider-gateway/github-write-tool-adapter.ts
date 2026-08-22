import type { z } from "zod";

import { CapabilityError } from "../errors.js";
import type { ProviderGatewayRuntime } from "./production.js";
import {
  GITHUB_WRITE_PROVIDER_ADAPTER_ID,
  GitHubPrCreateResultSchema,
  GitHubPrFeedbackReplyResultSchema,
  GitHubPrMergeResultSchema,
  type GitHubPrCreateInput,
  type GitHubPrCreateResult,
  type GitHubPrFeedbackReplyInput,
  type GitHubPrFeedbackReplyResult,
  type GitHubPrMergeInput,
  type GitHubPrMergeResult
} from "./github-write.js";

export interface GitHubWriteToolAdapter {
  prCreate(input: GitHubPrCreateInput): Promise<GitHubPrCreateResult>;
  prMerge(input: GitHubPrMergeInput): Promise<GitHubPrMergeResult>;
  prFeedbackReply(input: GitHubPrFeedbackReplyInput): Promise<GitHubPrFeedbackReplyResult>;
}

export function createGitHubWriteToolAdapter(
  runtime: Pick<ProviderGatewayRuntime, "operator" | "gateway">
): GitHubWriteToolAdapter {
  return {
    prCreate: (input) => execute(runtime, "github.pr.create", input, GitHubPrCreateResultSchema),
    prMerge: (input) => execute(runtime, "github.pr.merge", input, GitHubPrMergeResultSchema),
    prFeedbackReply: (input) =>
      execute(runtime, "github.pr.feedback.reply", input, GitHubPrFeedbackReplyResultSchema)
  };
}

async function execute<T>(
  runtime: Pick<ProviderGatewayRuntime, "operator" | "gateway">,
  semanticCapabilityId: string,
  input: unknown,
  outputSchema: z.ZodType<T>
): Promise<T> {
  const providerInstanceId = await selectedProviderInstanceId(runtime);
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
    (record) => record.adapterId === GITHUB_WRITE_PROVIDER_ADAPTER_ID
  );
  if (matching.length === 0) {
    throw new CapabilityError("PROVIDER_NOT_ADMITTED", "GitHub write provider is not admitted");
  }

  const enabled = matching.filter((record) => record.enabled);
  if (enabled.length === 0) {
    throw new CapabilityError("PROVIDER_DISABLED", "GitHub write provider is disabled");
  }
  if (enabled.length !== 1) {
    throw new CapabilityError(
      "PROVIDER_STATE_INVALID",
      "Multiple enabled GitHub write providers are admitted"
    );
  }
  return enabled[0]!.providerInstanceId;
}
