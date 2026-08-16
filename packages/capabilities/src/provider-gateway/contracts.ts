import type { z } from "zod";

export const PROVIDER_ERROR_CODES = Object.freeze([
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
] as const);

export const PROVIDER_MAX_TOOLS = 128;
export const PROVIDER_MAX_TOOL_INPUT_SCHEMA_BYTES = 32 * 1024;
export const PROVIDER_MAX_TOOL_OUTPUT_SCHEMA_BYTES = 32 * 1024;
export const PROVIDER_MAX_CANONICAL_INVENTORY_BYTES = 512 * 1024;
export const PROVIDER_MAX_SEMANTIC_INPUT_BYTES = 64 * 1024;
export const PROVIDER_MAX_REQUEST_BODY_BYTES = 256 * 1024;
export const PROVIDER_MAX_METADATA_RESPONSE_BYTES = 2 * 1024 * 1024;
export const PROVIDER_MAX_SEMANTIC_RESULT_BYTES = 512 * 1024;
export const PROVIDER_MAX_RESULT_ELEMENTS = 1_000;
export const PROVIDER_MAX_STRUCTURAL_DEPTH = 16;
export const PROVIDER_MAX_HELPER_STDOUT_BYTES = 64 * 1024;
export const PROVIDER_MAX_HELPER_STDERR_BYTES = 64 * 1024;
export const PROVIDER_CREDENTIAL_TIMEOUT_MS = 5_000;
export const PROVIDER_NETWORK_ATTEMPT_TIMEOUT_MS = 10_000;
export const PROVIDER_OPERATION_TIMEOUT_MS = 30_000;
export const PROVIDER_MAX_REQUESTS = 8;

export const PROVIDER_EFFECT_CLASSES = Object.freeze(["REMOTE_READ"] as const);
export const PROVIDER_WORKSPACE_BINDINGS = Object.freeze(["REQUIRED", "OPTIONAL", "NONE"] as const);
export const PROVIDER_INVENTORY_MODES = Object.freeze(["STATIC", "DYNAMIC"] as const);
export const PROVIDER_AUDIT_PHASES = Object.freeze(["decision", "success", "failed"] as const);
export const PROVIDER_AUDIT_OPERATIONS = Object.freeze([
  "add",
  "remove",
  "enable",
  "disable",
  "reapprove",
  "execute",
  "inventory"
] as const);

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];
export type ProviderEffectClass = (typeof PROVIDER_EFFECT_CLASSES)[number];
export type ProviderWorkspaceBinding = (typeof PROVIDER_WORKSPACE_BINDINGS)[number];
export type ProviderInventoryMode = (typeof PROVIDER_INVENTORY_MODES)[number];
export type ProviderAuditPhase = (typeof PROVIDER_AUDIT_PHASES)[number];
export type ProviderAuditOperation = (typeof PROVIDER_AUDIT_OPERATIONS)[number];

export type ProviderCredentialBrokerDescriptor =
  | { kind: "none" }
  | { kind: "external-helper"; helperPath: string; helperSha256: string };

export interface ProviderRegistryRecord {
  schemaVersion: 1;
  providerInstanceId: string;
  operatorName: string;
  adapterId: string;
  adapterContractVersion: string;
  enabled: boolean;
  implementationFingerprint: string;
  inventoryMode: ProviderInventoryMode;
  approvedInventoryFingerprint: string | null;
  credentialBroker: ProviderCredentialBrokerDescriptor;
  nonSecretAdapterConfig: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderStructuralTool {
  id: string;
  inputSchema: unknown;
  outputSchema: unknown;
}

export interface ProviderStructuralInventory {
  adapterContractVersion: string;
  providerContractVersion: string | null;
  tools: readonly ProviderStructuralTool[];
}

export interface ProviderSemanticExecutionInput {
  semanticCapabilityId: string;
  providerInstanceId: string;
  workspaceId?: string;
  input: unknown;
}

export interface ProviderSemanticExecutionResult<T = unknown> {
  semanticCapabilityId: string;
  providerInstanceId: string;
  value: T;
  truncated: boolean;
  truncationReasons: readonly string[];
}

export interface ProviderAuditMetadata {
  operationId: string;
  operation: ProviderAuditOperation;
  phase: ProviderAuditPhase;
  providerInstanceId: string;
  adapterId: string;
  semanticCapabilityId?: string;
  errorCode?: ProviderErrorCode;
  inventoryChanged?: boolean;
  truncated?: boolean;
  durationMs?: number;
}

export interface ProviderEncodedRequest {
  pathParameters?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  body?: unknown;
}

export interface ProviderRedirectPolicy {
  fromOrigin: string;
  toOrigin: string;
}

export interface ProviderNetworkPolicy {
  kind: "internet";
  origins: readonly string[];
  redirect: ProviderRedirectPolicy | null;
}

export type ProviderCredentialBrokerPolicy =
  | { kind: "none" }
  | {
      kind: "external-helper";
      credentialKind: "bearer" | "opaque";
      argv: readonly string[];
      environment: Readonly<Record<string, string>>;
    };

export interface ProviderOperationDefinition {
  id: string;
  method: "GET" | "POST";
  origin: string;
  pathTemplate: string;
  allowedQueryKeys: readonly string[];
  fixedHeaders: Readonly<Record<string, string>>;
  inputSchema: z.ZodType<unknown>;
  encodeRequest(input: unknown): ProviderEncodedRequest;
}

export interface ProviderSemanticMappingDefinition {
  semanticCapabilityId: string;
  adapterId: string;
  adapterOperationId: string;
  effect: ProviderEffectClass;
  workspaceBinding: ProviderWorkspaceBinding;
  inputSchema: z.ZodType<unknown>;
  outputSchema: z.ZodType<unknown>;
  mapOutput?: (providerValue: unknown, semanticInput: unknown) => unknown;
  maxProviderRequests: number;
  retry: "none" | "one-idempotent-read";
  auditFields: readonly string[];
}

export interface ProviderAdapterManifest {
  adapterId: string;
  adapterContractVersion: string;
  implementationDigest: string;
  inventoryMode: ProviderInventoryMode;
  networkPolicy: ProviderNetworkPolicy;
  credentialBroker: ProviderCredentialBrokerPolicy;
  operations: readonly ProviderOperationDefinition[];
  mappings: readonly ProviderSemanticMappingDefinition[];
}

export interface ProviderRequestBudget {
  claimRequest(): void;
}

export interface ProviderRawResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  readonly body: Buffer;
  readonly finalOrigin: string;
}

export interface ProviderGatewayService {
  execute(input: ProviderSemanticExecutionInput): Promise<ProviderSemanticExecutionResult>;
}
