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
  | "VERIFICATION_NOT_FOUND"
  | "VERIFICATION_NOT_ALLOWED"
  | "VERIFICATION_DISCOVERY_INVALID"
  | "VERIFICATION_AUDIT_UNAVAILABLE"
  | "PATCH_PRECONDITION_FAILED"
  | "PATCH_COMMIT_INCOMPLETE"
  | "CAPABILITY_NOT_IMPLEMENTED"
  | "CAPABILITY_INTERNAL";

export interface CapabilityErrorDetails {
  committedPaths?: string[];
  failedPath?: string;
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
  if (
    (committedPaths !== undefined &&
      (!Array.isArray(committedPaths) || !committedPaths.every(isSafeRelativePath))) ||
    (failedPath !== undefined && !isSafeRelativePath(failedPath))
  ) {
    return undefined;
  }
  return {
    ...(committedPaths === undefined ? {} : { committedPaths: [...committedPaths] }),
    ...(failedPath === undefined ? {} : { failedPath })
  };
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
