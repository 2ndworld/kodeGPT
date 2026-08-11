export type CapabilityErrorCode =
  | "CAPABILITY_INPUT_INVALID"
  | "CAPABILITY_LIMIT_EXCEEDED"
  | "CAPABILITY_SOURCE_INCOMPLETE"
  | "CAPABILITY_SOURCE_INVALID"
  | "GIT_INSPECTION_FAILED"
  | "GIT_STATUS_INVALID"
  | "VERIFICATION_NOT_FOUND"
  | "VERIFICATION_NOT_ALLOWED"
  | "VERIFICATION_DISCOVERY_INVALID"
  | "VERIFICATION_AUDIT_UNAVAILABLE"
  | "CAPABILITY_NOT_IMPLEMENTED"
  | "CAPABILITY_INTERNAL";

export class CapabilityError extends Error {
  constructor(
    readonly code: CapabilityErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CapabilityError";
  }
}

export function toPublicCapabilityError(error: unknown): {
  code: CapabilityErrorCode;
  message: string;
} {
  if (error instanceof CapabilityError) {
    return { code: error.code, message: error.message };
  }
  return { code: "CAPABILITY_INTERNAL", message: "Native capability failed" };
}
