import type { GitLocalAuthorityAdapter, GitLocalMutationAdapter } from "./adapters.js";
import type { GitBranchInput, GitCommitInput, GitLocalMutationResult, GitStageInput } from "./contracts.js";
import { CapabilityError, type CapabilityErrorCode } from "./errors.js";
import { GitBranchInputSchema, GitCommitInputSchema, GitLocalMutationResultSchema, GitStageInputSchema } from "./schemas.js";

const RUNTIME_MUTATION_ERRORS = new Set<CapabilityErrorCode>([
  "WORKSPACE_NOT_READY",
  "GIT_POLICY_DENIED",
  "GIT_MUTATION_INPUT_INVALID",
  "GIT_MUTATION_UNAVAILABLE",
  "GIT_MUTATION_FAILED"
]);

export async function gitStage(
  authority: GitLocalAuthorityAdapter,
  mutation: GitLocalMutationAdapter,
  input: GitStageInput
): Promise<GitLocalMutationResult> {
  const parsed = parseInput(GitStageInputSchema, input);
  requireTrusted(authority, parsed.workspaceId);
  return execute("stage", () => mutation.stage(parsed.workspaceId, parsed.paths));
}

export async function gitCommit(
  authority: GitLocalAuthorityAdapter,
  mutation: GitLocalMutationAdapter,
  input: GitCommitInput
): Promise<GitLocalMutationResult> {
  const parsed = parseInput(GitCommitInputSchema, input);
  requireTrusted(authority, parsed.workspaceId);
  return execute("commit", () => mutation.commit(parsed.workspaceId, parsed.message));
}

export async function gitBranchCreate(
  authority: GitLocalAuthorityAdapter,
  mutation: GitLocalMutationAdapter,
  input: GitBranchInput
): Promise<GitLocalMutationResult> {
  const parsed = parseInput(GitBranchInputSchema, input);
  requireTrusted(authority, parsed.workspaceId);
  return execute("branch_create", () => mutation.branchCreate(parsed.workspaceId, parsed.name));
}

export async function gitBranchSwitch(
  authority: GitLocalAuthorityAdapter,
  mutation: GitLocalMutationAdapter,
  input: GitBranchInput
): Promise<GitLocalMutationResult> {
  const parsed = parseInput(GitBranchInputSchema, input);
  requireTrusted(authority, parsed.workspaceId);
  return execute("branch_switch", () => mutation.branchSwitch(parsed.workspaceId, parsed.name));
}

export async function gitBranchDelete(
  authority: GitLocalAuthorityAdapter,
  mutation: GitLocalMutationAdapter,
  input: GitBranchInput
): Promise<GitLocalMutationResult> {
  const parsed = parseInput(GitBranchInputSchema, input);
  requireTrusted(authority, parsed.workspaceId);
  return execute("branch_delete", () => mutation.branchDelete(parsed.workspaceId, parsed.name));
}

function parseInput<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Local Git mutation input is invalid");
  }
  return parsed.data;
}

function requireTrusted(authority: GitLocalAuthorityAdapter, workspaceId: string): void {
  let policy: { name: string; allowWrite: boolean };
  try {
    policy = authority.effectivePolicy(workspaceId);
  } catch (error) {
    throw normalizeAdapterError(error);
  }
  if (policy.name !== "trusted" || !policy.allowWrite) {
    throw new CapabilityError("GIT_POLICY_DENIED", "Trusted workspace authority is required for local Git mutation");
  }
}

async function execute(
  expectedOperation: GitLocalMutationResult["operation"],
  operation: () => Promise<GitLocalMutationResult>
): Promise<GitLocalMutationResult> {
  let result: GitLocalMutationResult;
  try {
    result = await operation();
  } catch (error) {
    throw normalizeAdapterError(error);
  }
  const parsed = GitLocalMutationResultSchema.safeParse(result);
  if (!parsed.success || parsed.data.operation !== expectedOperation) {
    throw new CapabilityError("CAPABILITY_SOURCE_INVALID", "Local Git mutation returned an invalid result");
  }
  return parsed.data;
}

function normalizeAdapterError(error: unknown): CapabilityError {
  if (error instanceof CapabilityError) return error;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && RUNTIME_MUTATION_ERRORS.has(code as CapabilityErrorCode)) {
      return new CapabilityError(code as CapabilityErrorCode, safeRuntimeMessage(code));
    }
  }
  return new CapabilityError("GIT_MUTATION_FAILED", "Local Git mutation failed");
}

function safeRuntimeMessage(code: string): string {
  switch (code) {
    case "WORKSPACE_NOT_READY":
      return "Workspace is not ready";
    case "GIT_POLICY_DENIED":
      return "Trusted workspace authority is required for local Git mutation";
    case "GIT_MUTATION_INPUT_INVALID":
      return "Local Git mutation input is invalid";
    case "GIT_MUTATION_UNAVAILABLE":
      return "Local Git mutation is unavailable";
    default:
      return "Local Git mutation failed";
  }
}
