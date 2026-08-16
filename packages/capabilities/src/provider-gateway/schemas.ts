import { z } from "zod";

import {
  PROVIDER_AUDIT_OPERATIONS,
  PROVIDER_AUDIT_PHASES,
  PROVIDER_ERROR_CODES,
  PROVIDER_INVENTORY_MODES,
  PROVIDER_MAX_TOOLS,
  type ProviderAuditMetadata,
  type ProviderCredentialBrokerDescriptor,
  type ProviderRegistryRecord,
  type ProviderSemanticExecutionInput,
  type ProviderSemanticExecutionResult,
  type ProviderStructuralInventory
} from "./contracts.js";

const boundedAuthorityIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const boundedVersionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });

export const ProviderInstanceIdSchema = z.string().regex(/^prv_[0-9a-f]{32}$/);
export const ProviderOperationIdSchema = z.string().regex(/^op_[0-9a-f]{32}$/);
export const ProviderAdapterIdSchema = boundedAuthorityIdSchema;
export const ProviderSemanticCapabilityIdSchema = boundedAuthorityIdSchema;
export const ProviderFingerprintSchema = sha256Schema;

export const ProviderCredentialBrokerDescriptorSchema: z.ZodType<ProviderCredentialBrokerDescriptor> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("none") }).strict(),
    z
      .object({
        kind: z.literal("external-helper"),
        helperPath: z.string().min(1).max(4096),
        helperSha256: sha256Schema
      })
      .strict()
  ]
);

export const ProviderRegistryRecordSchema: z.ZodType<ProviderRegistryRecord> = z
  .object({
    schemaVersion: z.literal(1),
    providerInstanceId: ProviderInstanceIdSchema,
    operatorName: z.string().min(1).max(256),
    adapterId: ProviderAdapterIdSchema,
    adapterContractVersion: boundedVersionSchema,
    enabled: z.boolean(),
    implementationFingerprint: ProviderFingerprintSchema,
    inventoryMode: z.enum(PROVIDER_INVENTORY_MODES),
    approvedInventoryFingerprint: ProviderFingerprintSchema.nullable(),
    credentialBroker: ProviderCredentialBrokerDescriptorSchema,
    nonSecretAdapterConfig: z.record(z.string().min(1).max(128), z.unknown()),
    createdAt: timestampSchema,
    updatedAt: timestampSchema
  })
  .strict();

const ProviderStructuralToolSchema = z
  .object({
    id: boundedAuthorityIdSchema,
    inputSchema: z.unknown(),
    outputSchema: z.unknown()
  })
  .strict();

export const ProviderStructuralInventorySchema: z.ZodType<ProviderStructuralInventory> = z
  .object({
    adapterContractVersion: boundedVersionSchema,
    providerContractVersion: boundedVersionSchema.nullable(),
    tools: z.array(ProviderStructuralToolSchema).max(PROVIDER_MAX_TOOLS)
  })
  .strict();

export const ProviderSemanticExecutionInputSchema: z.ZodType<ProviderSemanticExecutionInput> = z
  .object({
    semanticCapabilityId: ProviderSemanticCapabilityIdSchema,
    providerInstanceId: ProviderInstanceIdSchema,
    workspaceId: z.string().min(1).max(256).optional(),
    input: z.unknown()
  })
  .strict();

export const ProviderSemanticExecutionResultSchema: z.ZodType<ProviderSemanticExecutionResult> = z
  .object({
    semanticCapabilityId: ProviderSemanticCapabilityIdSchema,
    providerInstanceId: ProviderInstanceIdSchema,
    value: z.unknown(),
    truncated: z.boolean(),
    truncationReasons: z.array(z.string().min(1).max(128)).max(32)
  })
  .strict()
  .refine((value) => value.truncated === (value.truncationReasons.length > 0));

export const ProviderAuditMetadataSchema: z.ZodType<ProviderAuditMetadata> = z
  .object({
    operationId: ProviderOperationIdSchema,
    operation: z.enum(PROVIDER_AUDIT_OPERATIONS),
    phase: z.enum(PROVIDER_AUDIT_PHASES),
    providerInstanceId: ProviderInstanceIdSchema,
    adapterId: ProviderAdapterIdSchema,
    semanticCapabilityId: ProviderSemanticCapabilityIdSchema.optional(),
    errorCode: z.enum(PROVIDER_ERROR_CODES).optional(),
    inventoryChanged: z.boolean().optional(),
    truncated: z.boolean().optional(),
    durationMs: z.number().int().nonnegative().max(86_400_000).safe().optional()
  })
  .strict();
