import type { GitRemoteAuthorityAdapter, GitRemoteMutationAdapter } from "./adapters.js";
import type { GitRemoteInput, GitRemoteMutationResult } from "./contracts.js";
import { CapabilityError, type CapabilityErrorCode } from "./errors.js";
import { GitRemoteInputSchema, GitRemoteMutationResultSchema } from "./schemas.js";

const RUNTIME_REMOTE_ERRORS = new Set<CapabilityErrorCode>([
  "WORKSPACE_NOT_READY",
  "GIT_REMOTE_POLICY_DENIED",
  "GIT_REMOTE_INPUT_INVALID",
  "GIT_REMOTE_UNAVAILABLE",
  "GIT_REMOTE_FAILED"
]);

export async function gitFetch(
  authority: GitRemoteAuthorityAdapter,
  mutation: GitRemoteMutationAdapter,
  input: GitRemoteInput
): Promise<GitRemoteMutationResult> {
  return executeRemote("fetch", authority, mutation, input);
}

export async function gitPull(
  authority: GitRemoteAuthorityAdapter,
  mutation: GitRemoteMutationAdapter,
  input: GitRemoteInput
): Promise<GitRemoteMutationResult> {
  return executeRemote("pull", authority, mutation, input);
}

export async function gitPush(
  authority: GitRemoteAuthorityAdapter,
  mutation: GitRemoteMutationAdapter,
  input: GitRemoteInput
): Promise<GitRemoteMutationResult> {
  return executeRemote("push", authority, mutation, input);
}

async function executeRemote(
  operation: GitRemoteMutationResult["operation"],
  authority: GitRemoteAuthorityAdapter,
  mutation: GitRemoteMutationAdapter,
  input: GitRemoteInput
): Promise<GitRemoteMutationResult> {
  const parsed = GitRemoteInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Remote Git mutation input is invalid");
  }
  requireTrustedRemote(authority, parsed.data.workspaceId);
  const remote = parsed.data.remote ?? "origin";

  let result: GitRemoteMutationResult;
  try {
    result = await mutation[operation](parsed.data.workspaceId, remote, parsed.data.ref);
  } catch (error) {
    throw normalizeAdapterError(error);
  }
  const validated = GitRemoteMutationResultSchema.safeParse(result);
  if (!validated.success || validated.data.operation !== operation) {
    throw new CapabilityError("CAPABILITY_SOURCE_INVALID", "Remote Git mutation returned an invalid result");
  }
  return validated.data;
}

function requireTrustedRemote(authority: GitRemoteAuthorityAdapter, workspaceId: string): void {
  let policy: { name: string; allowWrite: boolean; network: string };
  try {
    policy = authority.effectivePolicy(workspaceId);
  } catch (error) {
    throw normalizeAdapterError(error);
  }
  if (policy.name !== "trusted" || !policy.allowWrite || policy.network !== "unrestricted") {
    throw new CapabilityError(
      "GIT_REMOTE_POLICY_DENIED",
      "Trusted workspace authority with unrestricted network is required for remote Git mutation"
    );
  }
}

function normalizeAdapterError(error: unknown): CapabilityError {
  if (error instanceof CapabilityError) return error;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && RUNTIME_REMOTE_ERRORS.has(code as CapabilityErrorCode)) {
      return new CapabilityError(code as CapabilityErrorCode, safeRuntimeMessage(code));
    }
  }
  return new CapabilityError("GIT_REMOTE_FAILED", "Remote Git mutation failed");
}

function safeRuntimeMessage(code: string): string {
  switch (code) {
    case "WORKSPACE_NOT_READY":
      return "Workspace is not ready";
    case "GIT_REMOTE_POLICY_DENIED":
      return "Trusted workspace authority with unrestricted network is required for remote Git mutation";
    case "GIT_REMOTE_INPUT_INVALID":
      return "Remote Git mutation input is invalid";
    case "GIT_REMOTE_UNAVAILABLE":
      return "Remote Git mutation is unavailable";
    default:
      return "Remote Git mutation failed";
  }
}
