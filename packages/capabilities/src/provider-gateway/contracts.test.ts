import { describe, expect, it } from "vitest";

import { NATIVE_CAPABILITY_IDS } from "../contracts.js";
import { CapabilityError, toPublicCapabilityError } from "../errors.js";
import {
  PROVIDER_CREDENTIAL_TIMEOUT_MS,
  PROVIDER_ERROR_CODES,
  PROVIDER_MAX_CANONICAL_INVENTORY_BYTES,
  PROVIDER_MAX_HELPER_STDERR_BYTES,
  PROVIDER_MAX_HELPER_STDOUT_BYTES,
  PROVIDER_MAX_METADATA_RESPONSE_BYTES,
  PROVIDER_MAX_REQUEST_BODY_BYTES,
  PROVIDER_MAX_REQUESTS,
  PROVIDER_MAX_RESULT_ELEMENTS,
  PROVIDER_MAX_SEMANTIC_INPUT_BYTES,
  PROVIDER_MAX_SEMANTIC_RESULT_BYTES,
  PROVIDER_MAX_STRUCTURAL_DEPTH,
  PROVIDER_MAX_TOOL_INPUT_SCHEMA_BYTES,
  PROVIDER_MAX_TOOL_OUTPUT_SCHEMA_BYTES,
  PROVIDER_MAX_TOOLS,
  PROVIDER_NETWORK_ATTEMPT_TIMEOUT_MS,
  PROVIDER_OPERATION_TIMEOUT_MS
} from "./contracts.js";
import {
  ProviderAuditMetadataSchema,
  ProviderCredentialBrokerDescriptorSchema,
  ProviderInstanceIdSchema,
  ProviderRegistryRecordSchema,
  ProviderSemanticExecutionInputSchema,
  ProviderSemanticExecutionResultSchema,
  ProviderStructuralInventorySchema
} from "./schemas.js";

const providerInstanceId = "prv_0123456789abcdef0123456789abcdef";
const fingerprint = "a".repeat(64);

function validRecord() {
  return {
    schemaVersion: 1 as const,
    providerInstanceId,
    operatorName: "Fixture provider",
    adapterId: "test.fixture.read.v1",
    adapterContractVersion: "1",
    enabled: true,
    implementationFingerprint: fingerprint,
    inventoryMode: "DYNAMIC" as const,
    approvedInventoryFingerprint: fingerprint,
    credentialBroker: { kind: "none" as const },
    nonSecretAdapterConfig: {},
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z"
  };
}

describe("Provider Gateway private contracts", () => {
  it("locks the provider error and authority vocabulary", () => {
    expect(PROVIDER_ERROR_CODES).toEqual([
      "PROVIDER_INPUT_INVALID",
      "PROVIDER_STATE_INVALID",
      "PROVIDER_NOT_ADMITTED",
      "PROVIDER_DISABLED",
      "PROVIDER_IDENTITY_CHANGED",
      "PROVIDER_CREDENTIAL_UNAVAILABLE",
      "PROVIDER_CREDENTIAL_REJECTED",
      "PROVIDER_NETWORK_DENIED",
      "PROVIDER_UNAVAILABLE",
      "PROVIDER_TIMEOUT",
      "PROVIDER_CANCELLED",
      "PROVIDER_RATE_LIMITED",
      "PROVIDER_RESPONSE_INVALID",
      "PROVIDER_OUTPUT_LIMIT_EXCEEDED",
      "PROVIDER_TOOL_UNAVAILABLE",
      "PROVIDER_INVENTORY_CHANGED",
      "PROVIDER_REQUEST_FAILED",
      "PROVIDER_AUDIT_UNAVAILABLE"
    ]);
    expect({
      PROVIDER_MAX_TOOLS,
      PROVIDER_MAX_TOOL_INPUT_SCHEMA_BYTES,
      PROVIDER_MAX_TOOL_OUTPUT_SCHEMA_BYTES,
      PROVIDER_MAX_CANONICAL_INVENTORY_BYTES,
      PROVIDER_MAX_SEMANTIC_INPUT_BYTES,
      PROVIDER_MAX_REQUEST_BODY_BYTES,
      PROVIDER_MAX_METADATA_RESPONSE_BYTES,
      PROVIDER_MAX_SEMANTIC_RESULT_BYTES,
      PROVIDER_MAX_RESULT_ELEMENTS,
      PROVIDER_MAX_STRUCTURAL_DEPTH,
      PROVIDER_MAX_HELPER_STDOUT_BYTES,
      PROVIDER_MAX_HELPER_STDERR_BYTES,
      PROVIDER_CREDENTIAL_TIMEOUT_MS,
      PROVIDER_NETWORK_ATTEMPT_TIMEOUT_MS,
      PROVIDER_OPERATION_TIMEOUT_MS,
      PROVIDER_MAX_REQUESTS
    }).toEqual({
      PROVIDER_MAX_TOOLS: 128,
      PROVIDER_MAX_TOOL_INPUT_SCHEMA_BYTES: 32 * 1024,
      PROVIDER_MAX_TOOL_OUTPUT_SCHEMA_BYTES: 32 * 1024,
      PROVIDER_MAX_CANONICAL_INVENTORY_BYTES: 512 * 1024,
      PROVIDER_MAX_SEMANTIC_INPUT_BYTES: 64 * 1024,
      PROVIDER_MAX_REQUEST_BODY_BYTES: 256 * 1024,
      PROVIDER_MAX_METADATA_RESPONSE_BYTES: 2 * 1024 * 1024,
      PROVIDER_MAX_SEMANTIC_RESULT_BYTES: 512 * 1024,
      PROVIDER_MAX_RESULT_ELEMENTS: 1_000,
      PROVIDER_MAX_STRUCTURAL_DEPTH: 16,
      PROVIDER_MAX_HELPER_STDOUT_BYTES: 64 * 1024,
      PROVIDER_MAX_HELPER_STDERR_BYTES: 64 * 1024,
      PROVIDER_CREDENTIAL_TIMEOUT_MS: 5_000,
      PROVIDER_NETWORK_ATTEMPT_TIMEOUT_MS: 10_000,
      PROVIDER_OPERATION_TIMEOUT_MS: 30_000,
      PROVIDER_MAX_REQUESTS: 8
    });
  });

  it("keeps provider semantic ids outside native MCP capability ids", () => {
    expect(NATIVE_CAPABILITY_IDS.some((id) => id.startsWith("provider."))).toBe(false);
  });

  it("accepts only opaque provider instance ids and strict registry records", () => {
    expect(ProviderInstanceIdSchema.parse(providerInstanceId)).toBe(providerInstanceId);
    expect(() => ProviderInstanceIdSchema.parse("prv_ABC")).toThrow();
    expect(ProviderRegistryRecordSchema.parse(validRecord())).toEqual(validRecord());
    expect(() => ProviderRegistryRecordSchema.parse({ ...validRecord(), endpoint: "https://example.com" })).toThrow();
  });

  it("keeps credential broker descriptors non-secret and strict", () => {
    expect(ProviderCredentialBrokerDescriptorSchema.parse({ kind: "none" })).toEqual({ kind: "none" });
    expect(ProviderCredentialBrokerDescriptorSchema.parse({
      kind: "external-helper",
      helperPath: "/usr/bin/provider-auth",
      helperSha256: fingerprint
    })).toEqual({
      kind: "external-helper",
      helperPath: "/usr/bin/provider-auth",
      helperSha256: fingerprint
    });
    expect(() => ProviderCredentialBrokerDescriptorSchema.parse({ kind: "none", token: "secret" })).toThrow();
  });

  it("defines strict structural inventory and semantic execution envelopes", () => {
    const inventory = {
      adapterContractVersion: "1",
      providerContractVersion: null,
      tools: [{ id: "record.read", inputSchema: { type: "object" }, outputSchema: { type: "object" } }]
    };
    expect(ProviderStructuralInventorySchema.parse(inventory)).toEqual(inventory);
    expect(() => ProviderStructuralInventorySchema.parse({ ...inventory, description: "untrusted prose" })).toThrow();

    const execution = {
      semanticCapabilityId: "test.fixture.record.read",
      providerInstanceId,
      input: { recordId: "42" }
    };
    expect(ProviderSemanticExecutionInputSchema.parse(execution)).toEqual(execution);
    expect(() => ProviderSemanticExecutionInputSchema.parse({ ...execution, url: "https://example.com" })).toThrow();

    const result = {
      semanticCapabilityId: "test.fixture.record.read",
      providerInstanceId,
      value: { id: "42" },
      truncated: false,
      truncationReasons: []
    };
    expect(ProviderSemanticExecutionResultSchema.parse(result)).toEqual(result);
    expect(() => ProviderSemanticExecutionResultSchema.parse({ ...result, rawResponse: "no" })).toThrow();
  });

  it("allows only bounded audit metadata fields", () => {
    const metadata = {
      operationId: "op_0123456789abcdef0123456789abcdef",
      operation: "execute",
      phase: "decision",
      providerInstanceId,
      adapterId: "test.fixture.read.v1",
      semanticCapabilityId: "test.fixture.record.read",
      durationMs: 12
    };
    expect(ProviderAuditMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(() => ProviderAuditMetadataSchema.parse({ ...metadata, credential: "secret" })).toThrow();
  });

  it("adds provider errors without changing public error sanitization behavior", () => {
    expect(toPublicCapabilityError(new CapabilityError("PROVIDER_TIMEOUT", "Provider timed out"))).toEqual({
      code: "PROVIDER_TIMEOUT",
      message: "Provider timed out"
    });
  });
});
