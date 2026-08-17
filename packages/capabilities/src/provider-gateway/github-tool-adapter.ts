import type { z } from "zod";

import { CapabilityError } from "../errors.js";
import type { ProviderGatewayRuntime } from "./production.js";
import {
  GITHUB_READ_PROVIDER_ADAPTER_ID,
  GitHubIssueInspectResultSchema,
  GitHubIssueListResultSchema,
  GitHubPrInspectResultSchema,
  GitHubPrListResultSchema,
  GitHubRepositoryInspectResultSchema,
  type GitHubIssueInspectInput,
  type GitHubIssueInspectResult,
  type GitHubIssueListInput,
  type GitHubIssueListResult,
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
    issueInspect: (input) =>
      execute(runtime, "github.issue.inspect", input, GitHubIssueInspectResultSchema),
    issueList: (input) => execute(runtime, "github.issue.list", input, GitHubIssueListResultSchema)
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
