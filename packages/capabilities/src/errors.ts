export type CapabilityErrorCode =
  | "CAPABILITY_INPUT_INVALID"
  | "CAPABILITY_LIMIT_EXCEEDED"
  | "CAPABILITY_SOURCE_INCOMPLETE"
  | "CAPABILITY_SOURCE_INVALID"
  | "GIT_INSPECTION_FAILED"
  | "GIT_STATUS_INVALID"
  | "WORKSPACE_NOT_READY"
  | "GIT_UNAVAILABLE"
  | "NOT_A_GIT_REPOSITORY"
  | "REVISION_INVALID"
  | "REVISION_NOT_FOUND"
  | "OBJECT_TYPE_UNSUPPORTED"
  | "PATH_INVALID"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "PROCESS_TIMEOUT"
  | "GIT_READ_FAILED"
  | "GIT_POLICY_DENIED"
  | "GIT_MUTATION_INPUT_INVALID"
  | "GIT_MUTATION_UNAVAILABLE"
  | "GIT_MUTATION_FAILED"
  | "GIT_REMOTE_POLICY_DENIED"
  | "GIT_REMOTE_INPUT_INVALID"
  | "GIT_REMOTE_UNAVAILABLE"
  | "GIT_REMOTE_FAILED"
  | "CI_WORKSPACE_AMBIGUOUS"
  | "CI_AUDIT_UNAVAILABLE"
  | "CI_AUTH_REQUIRED"
  | "CI_AUTH_FAILED"
  | "CI_REPOSITORY_UNAVAILABLE"
  | "CI_REPOSITORY_MISMATCH"
  | "CI_REMOTE_UNSUPPORTED"
  | "CI_NOT_FOUND"
  | "CI_PERMISSION_DENIED"
  | "CI_RATE_LIMITED"
  | "CI_PROVIDER_UNAVAILABLE"
  | "CI_RESPONSE_INVALID"
  | "CI_RESPONSE_LIMIT_EXCEEDED"
  | "CI_LOG_UNAVAILABLE"
  | "CI_LOG_LIMIT_EXCEEDED"
  | "CI_MUTATION_OUTCOME_UNKNOWN"
  | "CI_MUTATION_STATE_CONFLICT"
  | "PROVIDER_INPUT_INVALID"
  | "PROVIDER_STATE_INVALID"
  | "PROVIDER_NOT_ADMITTED"
  | "PROVIDER_DISABLED"
  | "PROVIDER_IDENTITY_CHANGED"
  | "PROVIDER_CREDENTIAL_UNAVAILABLE"
  | "PROVIDER_CREDENTIAL_REJECTED"
  | "PROVIDER_NETWORK_DENIED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_CANCELLED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_RESPONSE_INVALID"
  | "PROVIDER_OUTPUT_LIMIT_EXCEEDED"
  | "PROVIDER_TOOL_UNAVAILABLE"
  | "PROVIDER_INVENTORY_CHANGED"
  | "PROVIDER_REQUEST_FAILED"
  | "PROVIDER_MUTATION_OUTCOME_UNKNOWN"
  | "PROVIDER_AUDIT_UNAVAILABLE"
  | "VERIFICATION_NOT_FOUND"
  | "VERIFICATION_NOT_ALLOWED"
  | "VERIFICATION_DISCOVERY_INVALID"
  | "VERIFICATION_AUDIT_UNAVAILABLE"
  | "PATCH_PRECONDITION_FAILED"
  | "PATCH_COMMIT_INCOMPLETE"
  | "CAPABILITY_NOT_IMPLEMENTED"
  | "CAPABILITY_INTERNAL";

export type CapabilityErrorReason =
  | "AUTHENTICATION_REQUIRED"
  | "RATE_LIMITED"
  | "STALE_EXPECTED_STATE"
  | "MUTATION_OUTCOME_UNKNOWN";

export type CapabilityRecoveryAction = "authenticate" | "retry" | "refresh-state";

const CAPABILITY_ERROR_REASONS = new Set<CapabilityErrorReason>([
  "AUTHENTICATION_REQUIRED",
  "RATE_LIMITED",
  "STALE_EXPECTED_STATE",
  "MUTATION_OUTCOME_UNKNOWN"
]);

const CAPABILITY_RECOVERY_ACTIONS = new Set<CapabilityRecoveryAction>([
  "authenticate",
  "retry",
  "refresh-state"
]);

export interface CapabilityErrorDetails {
  committedPaths?: string[];
  failedPath?: string;
  retryAfter?: number;
  resetAt?: string;
  reason?: CapabilityErrorReason;
  retryable?: boolean;
  suggestedAction?: CapabilityRecoveryAction;
}

export class CapabilityError extends Error {
  constructor(
    readonly code: CapabilityErrorCode,
    message: string,
    readonly details?: CapabilityErrorDetails
  ) {
    super(message);
    this.name = "CapabilityError";
  }
}

export function toPublicCapabilityError(error: unknown): {
  code: CapabilityErrorCode;
  message: string;
  details?: CapabilityErrorDetails;
} {
  if (error instanceof CapabilityError) {
    const details = sanitizeDetails(error.details);
    return {
      code: error.code,
      message: error.message,
      ...(details === undefined ? {} : { details })
    };
  }
  return { code: "CAPABILITY_INTERNAL", message: "Native capability failed" };
}

function sanitizeDetails(details: CapabilityErrorDetails | undefined): CapabilityErrorDetails | undefined {
  if (details === undefined) return undefined;
  const committedPaths = details.committedPaths;
  const failedPath = details.failedPath;
  const retryAfter = details.retryAfter;
  const resetAt = details.resetAt;
  const reason = details.reason;
  const retryable = details.retryable;
  const suggestedAction = details.suggestedAction;
  if (
    (committedPaths !== undefined &&
      (!Array.isArray(committedPaths) || !committedPaths.every(isSafeRelativePath))) ||
    (failedPath !== undefined && !isSafeRelativePath(failedPath)) ||
    (retryAfter !== undefined && (!Number.isSafeInteger(retryAfter) || retryAfter < 0)) ||
    (resetAt !== undefined && !isSafeIsoTimestamp(resetAt)) ||
    (reason !== undefined && !CAPABILITY_ERROR_REASONS.has(reason)) ||
    (retryable !== undefined && typeof retryable !== "boolean") ||
    (suggestedAction !== undefined && !CAPABILITY_RECOVERY_ACTIONS.has(suggestedAction))
  ) {
    return undefined;
  }
  return {
    ...(committedPaths === undefined ? {} : { committedPaths: [...committedPaths] }),
    ...(failedPath === undefined ? {} : { failedPath }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(reason === undefined ? {} : { reason }),
    ...(retryable === undefined ? {} : { retryable }),
    ...(suggestedAction === undefined ? {} : { suggestedAction })
  };
}

function isSafeIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isSafeRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\0") &&
    !value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  );
}
