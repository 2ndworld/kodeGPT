import { CapabilityError } from "../errors.js";
import type { ProviderAuditMetadata } from "./contracts.js";
import { ProviderAuditMetadataSchema } from "./schemas.js";

export interface ProviderAuditRuntime {
  request(method: string, params: unknown): Promise<unknown>;
}

export class ProviderAuditClient {
  readonly #runtime: ProviderAuditRuntime;

  constructor(runtime: ProviderAuditRuntime) {
    this.#runtime = runtime;
  }

  async record(metadata: ProviderAuditMetadata): Promise<void> {
    const parsed = ProviderAuditMetadataSchema.safeParse(metadata);
    if (!parsed.success) {
      throw new CapabilityError("PROVIDER_INPUT_INVALID", "Provider audit metadata is invalid");
    }

    let result: unknown;
    try {
      result = await this.#runtime.request("provider.audit", parsed.data);
    } catch (error) {
      if (isAuditUnavailable(error)) {
        throw new CapabilityError(
          "PROVIDER_AUDIT_UNAVAILABLE",
          "Provider durable audit is unavailable"
        );
      }
      throw error;
    }

    if (!isRecord(result) || result.ok !== true || Object.keys(result).length !== 1) {
      throw new CapabilityError(
        "PROVIDER_AUDIT_UNAVAILABLE",
        "provider.audit returned an invalid acknowledgement"
      );
    }
  }
}

function isAuditUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === "AUDIT_UNAVAILABLE") return true;
  const candidate = error as Error & { code?: unknown };
  return candidate.code === "AUDIT_UNAVAILABLE";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
