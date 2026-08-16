import { randomBytes } from "node:crypto";

import { CapabilityError } from "../errors.js";
import {
  PROVIDER_ERROR_CODES,
  PROVIDER_MAX_SEMANTIC_INPUT_BYTES,
  type ProviderAdapterManifest,
  type ProviderAuditMetadata,
  type ProviderErrorCode,
  type ProviderGatewayService,
  type ProviderRegistryRecord,
  type ProviderSemanticExecutionInput,
  type ProviderSemanticExecutionResult,
  type ProviderSemanticMappingDefinition
} from "./contracts.js";
import type { ProviderCredentialBroker } from "./credential-broker.js";
import {
  resolveProviderImplementationIdentity,
  type ProviderImplementationIdentity
} from "./identity.js";
import { fingerprintProviderInventory, normalizeProviderInventory } from "./inventory.js";
import { ProviderOperationBudget } from "./lifecycle.js";
import type { ProviderNetworkTransport } from "./network-transport.js";
import type { ProviderInventorySource } from "./operator-service.js";
import { fitProviderSemanticResult, parseProviderSemanticOutput } from "./output.js";
import { ProviderOperationIdSchema, ProviderSemanticExecutionInputSchema } from "./schemas.js";

export interface ProviderWorkspaceAuthorityResolver {
  resolve(workspaceId: string): Promise<{
    workspaceId: string;
    network: "deny" | "unrestricted";
  }>;
}

export interface ProviderGatewayServiceDependencies {
  registry: {
    get(providerInstanceId: string): Promise<ProviderRegistryRecord | null>;
  };
  adapters: {
    require(adapterId: string): ProviderAdapterManifest;
    requireMapping(semanticCapabilityId: string): ProviderSemanticMappingDefinition;
  };
  audit: {
    record(metadata: ProviderAuditMetadata): Promise<void>;
  };
  credentials: ProviderCredentialBroker;
  transport: ProviderNetworkTransport;
  workspaceAuthority: ProviderWorkspaceAuthorityResolver;
  inventory?: ProviderInventorySource;
  workspaceRoots: () => readonly string[];
  resolveImplementationIdentity?: typeof resolveProviderImplementationIdentity;
  generateOperationId?: () => string;
}

const PROVIDER_ERROR_CODE_SET = new Set<string>(PROVIDER_ERROR_CODES);

export class ProviderGatewayServiceImpl implements ProviderGatewayService {
  readonly #deps: ProviderGatewayServiceDependencies;

  constructor(dependencies: ProviderGatewayServiceDependencies) {
    this.#deps = dependencies;
  }

  async execute(
    input: ProviderSemanticExecutionInput,
    callerSignal?: AbortSignal
  ): Promise<ProviderSemanticExecutionResult> {
    const parsed = parseSemanticInput(input);
    const mapping = this.#deps.adapters.requireMapping(parsed.semanticCapabilityId);
    if (mapping.effect !== "REMOTE_READ") {
      throw new CapabilityError("PROVIDER_TOOL_UNAVAILABLE", "Provider semantic mapping is not a remote read");
    }
    const mappingInput = mapping.inputSchema.safeParse(parsed.input);
    if (!mappingInput.success) {
      throw new CapabilityError("PROVIDER_INPUT_INVALID", "Provider semantic input does not match the reviewed mapping schema");
    }

    const provider = await this.#requireProvider(parsed.providerInstanceId);
    if (!provider.enabled) {
      throw new CapabilityError("PROVIDER_DISABLED", "Provider is disabled");
    }
    if (provider.adapterId !== mapping.adapterId) {
      throw new CapabilityError("PROVIDER_TOOL_UNAVAILABLE", "Semantic mapping is not available for the selected provider");
    }

    const manifest = this.#deps.adapters.require(provider.adapterId);
    if (
      provider.adapterContractVersion !== manifest.adapterContractVersion ||
      provider.inventoryMode !== manifest.inventoryMode
    ) {
      throw new CapabilityError("PROVIDER_IDENTITY_CHANGED", "Provider adapter identity changed and requires reapproval");
    }
    const identity = await this.#resolveIdentity(manifest, provider);
    if (identity.implementationFingerprint !== provider.implementationFingerprint) {
      throw new CapabilityError("PROVIDER_IDENTITY_CHANGED", "Provider implementation identity changed and requires reapproval");
    }
    if (manifest.inventoryMode === "DYNAMIC" && provider.approvedInventoryFingerprint === null) {
      throw new CapabilityError("PROVIDER_INVENTORY_CHANGED", "Provider dynamic inventory is not approved");
    }

    await this.#enforceWorkspace(mapping, parsed.workspaceId);

    const operationId = this.#operationId();
    const budget = new ProviderOperationBudget({
      signal: callerSignal,
      maxRequests: mapping.maxProviderRequests
    });
    let decisionRecorded = false;
    try {
      await this.#deps.audit.record({
        operationId,
        operation: "execute",
        phase: "decision",
        providerInstanceId: provider.providerInstanceId,
        adapterId: provider.adapterId,
        semanticCapabilityId: mapping.semanticCapabilityId
      });
      decisionRecorded = true;

      const credential = await this.#deps.credentials.acquire({
        provider,
        manifest,
        signal: budget.signal
      });
      if (manifest.inventoryMode === "DYNAMIC") {
        await this.#verifyDynamicInventory(provider, manifest, credential, budget.signal);
      }

      const response = await this.#request(mapping, manifest, mappingInput.data, credential, budget);
      const semanticValue = parseProviderSemanticOutput(response.body, mapping.outputSchema);
      const fitted = fitProviderSemanticResult(semanticValue);
      const result: ProviderSemanticExecutionResult = {
        semanticCapabilityId: mapping.semanticCapabilityId,
        providerInstanceId: provider.providerInstanceId,
        value: fitted.value,
        truncated: fitted.truncated,
        truncationReasons: fitted.truncationReasons
      };

      await this.#deps.audit.record({
        operationId,
        operation: "execute",
        phase: "success",
        providerInstanceId: provider.providerInstanceId,
        adapterId: provider.adapterId,
        semanticCapabilityId: mapping.semanticCapabilityId,
        truncated: result.truncated
      });
      return result;
    } catch (error) {
      const failure = asProviderFailure(error);
      if (decisionRecorded) {
        await this.#recordFailure({
          operationId,
          provider,
          mapping,
          failure
        });
      }
      throw failure;
    } finally {
      budget.close();
    }
  }

  async #requireProvider(providerInstanceId: string): Promise<ProviderRegistryRecord> {
    const provider = await this.#deps.registry.get(providerInstanceId);
    if (provider === null) {
      throw new CapabilityError("PROVIDER_NOT_ADMITTED", "Provider is not admitted");
    }
    return provider;
  }

  async #resolveIdentity(
    manifest: ProviderAdapterManifest,
    provider: ProviderRegistryRecord
  ): Promise<ProviderImplementationIdentity> {
    const resolver = this.#deps.resolveImplementationIdentity ?? resolveProviderImplementationIdentity;
    return await resolver({
      manifest,
      credentialBroker: provider.credentialBroker,
      workspaceRoots: this.#deps.workspaceRoots()
    });
  }

  async #enforceWorkspace(
    mapping: ProviderSemanticMappingDefinition,
    workspaceId: string | undefined
  ): Promise<void> {
    if (mapping.workspaceBinding === "NONE") return;
    if (workspaceId === undefined) {
      if (mapping.workspaceBinding === "REQUIRED") {
        throw new CapabilityError("PROVIDER_INPUT_INVALID", "Provider semantic mapping requires a workspace");
      }
      return;
    }
    let authority: Awaited<ReturnType<ProviderWorkspaceAuthorityResolver["resolve"]>>;
    try {
      authority = await this.#deps.workspaceAuthority.resolve(workspaceId);
    } catch {
      throw new CapabilityError("PROVIDER_NETWORK_DENIED", "Workspace is not ready for provider network access");
    }
    if (authority.workspaceId !== workspaceId || authority.network !== "unrestricted") {
      throw new CapabilityError("PROVIDER_NETWORK_DENIED", "Workspace profile denies provider network access");
    }
  }

  async #verifyDynamicInventory(
    provider: ProviderRegistryRecord,
    manifest: ProviderAdapterManifest,
    credential: Awaited<ReturnType<ProviderCredentialBroker["acquire"]>>,
    signal: AbortSignal
  ): Promise<void> {
    if (provider.approvedInventoryFingerprint === null) {
      throw new CapabilityError("PROVIDER_INVENTORY_CHANGED", "Provider dynamic inventory is not approved");
    }
    if (this.#deps.inventory === undefined) {
      throw new CapabilityError("PROVIDER_TOOL_UNAVAILABLE", "Provider dynamic inventory source is unavailable");
    }
    const inventory = await this.#deps.inventory.fetch({ provider, manifest, credential, signal });
    const normalized = normalizeProviderInventory(inventory);
    if (normalized.adapterContractVersion !== manifest.adapterContractVersion) {
      throw new CapabilityError("PROVIDER_INVENTORY_CHANGED", "Provider inventory adapter contract changed");
    }
    const fingerprint = fingerprintProviderInventory(normalized);
    if (fingerprint !== provider.approvedInventoryFingerprint) {
      throw new CapabilityError("PROVIDER_INVENTORY_CHANGED", "Provider inventory changed and requires reapproval");
    }
  }

  async #request(
    mapping: ProviderSemanticMappingDefinition,
    manifest: ProviderAdapterManifest,
    operationInput: unknown,
    credential: Awaited<ReturnType<ProviderCredentialBroker["acquire"]>>,
    budget: ProviderOperationBudget
  ) {
    let attempt = 0;
    while (true) {
      try {
        return await budget.withAttemptTimeout((signal) => this.#deps.transport.request({
          manifest,
          operationId: mapping.adapterOperationId,
          operationInput,
          credential,
          signal,
          budget
        }));
      } catch (error) {
        if (!budget.canRetry(mapping, attempt) || !isRetryable(error)) throw error;
        attempt += 1;
      }
    }
  }

  async #recordFailure(input: {
    operationId: string;
    provider: ProviderRegistryRecord;
    mapping: ProviderSemanticMappingDefinition;
    failure: CapabilityError;
  }): Promise<void> {
    try {
      await this.#deps.audit.record({
        operationId: input.operationId,
        operation: "execute",
        phase: "failed",
        providerInstanceId: input.provider.providerInstanceId,
        adapterId: input.provider.adapterId,
        semanticCapabilityId: input.mapping.semanticCapabilityId,
        errorCode: providerErrorCode(input.failure),
        ...(input.failure.code === "PROVIDER_INVENTORY_CHANGED" ? { inventoryChanged: true } : {})
      });
    } catch {
      throw new CapabilityError("PROVIDER_AUDIT_UNAVAILABLE", "Provider failed-outcome audit is unavailable");
    }
  }

  #operationId(): string {
    const value = this.#deps.generateOperationId?.() ?? `op_${randomBytes(18).toString("base64url")}`;
    if (!ProviderOperationIdSchema.safeParse(value).success) {
      throw new CapabilityError("PROVIDER_INPUT_INVALID", "Generated provider operation ID is invalid");
    }
    return value;
  }
}

function parseSemanticInput(input: ProviderSemanticExecutionInput): ProviderSemanticExecutionInput {
  const parsed = ProviderSemanticExecutionInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CapabilityError("PROVIDER_INPUT_INVALID", "Provider semantic execution input is invalid");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(parsed.data);
  } catch {
    throw new CapabilityError("PROVIDER_INPUT_INVALID", "Provider semantic execution input must be JSON data");
  }
  if (Buffer.byteLength(serialized, "utf8") > PROVIDER_MAX_SEMANTIC_INPUT_BYTES) {
    throw new CapabilityError("PROVIDER_INPUT_INVALID", "Provider semantic execution input exceeds the 64 KiB ceiling");
  }
  return parsed.data;
}

function asProviderFailure(error: unknown): CapabilityError {
  if (error instanceof CapabilityError && PROVIDER_ERROR_CODE_SET.has(error.code)) return error;
  return new CapabilityError("PROVIDER_REQUEST_FAILED", "Provider semantic execution failed");
}

function providerErrorCode(error: CapabilityError): ProviderErrorCode {
  return PROVIDER_ERROR_CODE_SET.has(error.code) ? error.code as ProviderErrorCode : "PROVIDER_REQUEST_FAILED";
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof CapabilityError)) return false;
  return error.code === "PROVIDER_UNAVAILABLE" || error.code === "PROVIDER_TIMEOUT";
}
