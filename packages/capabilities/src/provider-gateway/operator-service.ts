import { randomBytes } from "node:crypto";
import { z } from "zod";

import { CapabilityError } from "../errors.js";
import {
  PROVIDER_ERROR_CODES,
  type ProviderAdapterManifest,
  type ProviderAuditMetadata,
  type ProviderCredentialBrokerDescriptor,
  type ProviderErrorCode,
  type ProviderRegistryRecord,
  type ProviderStructuralInventory
} from "./contracts.js";
import type { ProviderCredential, ProviderCredentialBroker } from "./credential-broker.js";
import {
  resolveProviderImplementationIdentity,
  type ProviderImplementationIdentity
} from "./identity.js";
import { fingerprintProviderInventory, normalizeProviderInventory } from "./inventory.js";
import { assertProviderNonSecretConfig } from "./registry.js";
import {
  ProviderAdapterIdSchema,
  ProviderCredentialBrokerDescriptorSchema,
  ProviderInstanceIdSchema,
  ProviderOperationIdSchema
} from "./schemas.js";

export interface ProviderAddInput {
  adapterId: string;
  operatorName: string;
  credentialBroker: ProviderCredentialBrokerDescriptor;
  nonSecretAdapterConfig: Record<string, unknown>;
}

export interface ProviderRegistryRepository {
  list(): Promise<ProviderRegistryRecord[]>;
  get(providerInstanceId: string): Promise<ProviderRegistryRecord | null>;
  insert(record: ProviderRegistryRecord): Promise<void>;
  replace(record: ProviderRegistryRecord): Promise<void>;
  remove(providerInstanceId: string): Promise<boolean>;
}

export interface ProviderInventorySource {
  fetch(input: {
    provider: ProviderRegistryRecord;
    manifest: ProviderAdapterManifest;
    credential: ProviderCredential | null;
    signal: AbortSignal;
  }): Promise<ProviderStructuralInventory>;
}

export interface ProviderOperatorDependencies {
  store: ProviderRegistryRepository;
  adapters: { require(adapterId: string): ProviderAdapterManifest };
  audit: { record(metadata: ProviderAuditMetadata): Promise<void> };
  resolveImplementationIdentity?: typeof resolveProviderImplementationIdentity;
  credentials: ProviderCredentialBroker;
  inventory: ProviderInventorySource;
  generateProviderInstanceId?: () => string;
  generateOperationId?: () => string;
  nowIso?: () => string;
  workspaceRoots: () => readonly string[];
}

const ProviderAddInputSchema: z.ZodType<ProviderAddInput> = z.object({
  adapterId: ProviderAdapterIdSchema,
  operatorName: z.string().min(1).max(256),
  credentialBroker: ProviderCredentialBrokerDescriptorSchema,
  nonSecretAdapterConfig: z.record(z.string().min(1).max(128), z.unknown())
}).strict();

const PROVIDER_ERROR_CODE_SET = new Set<string>(PROVIDER_ERROR_CODES);

export class ProviderOperatorService {
  readonly #deps: ProviderOperatorDependencies;

  constructor(dependencies: ProviderOperatorDependencies) {
    this.#deps = dependencies;
  }

  async add(input: ProviderAddInput): Promise<ProviderRegistryRecord> {
    const parsed = parseAddInput(input);
    const adapterConfig = validateOperatorConfig(parsed.nonSecretAdapterConfig);
    const manifest = this.#deps.adapters.require(parsed.adapterId);
    validateCredentialBrokerSelection(manifest, parsed.credentialBroker);
    const identity = await this.#resolveImplementationIdentity(manifest, parsed.credentialBroker);
    const providerInstanceId = this.#providerInstanceId();
    if (await this.#deps.store.get(providerInstanceId) !== null) {
      throw stateFailure("Generated provider instance ID already exists");
    }
    const operationId = this.#operationId();
    const now = this.#nowIso();
    const baseRecord: ProviderRegistryRecord = {
      schemaVersion: 1,
      providerInstanceId,
      operatorName: parsed.operatorName,
      adapterId: manifest.adapterId,
      adapterContractVersion: manifest.adapterContractVersion,
      enabled: true,
      implementationFingerprint: identity.implementationFingerprint,
      inventoryMode: manifest.inventoryMode,
      approvedInventoryFingerprint: null,
      credentialBroker: canonicalCredentialBroker(parsed.credentialBroker, identity),
      nonSecretAdapterConfig: adapterConfig,
      createdAt: now,
      updatedAt: now
    };
    await this.#audit({ operationId, operation: "add", phase: "decision", providerInstanceId, adapterId: manifest.adapterId });
    let inserted = false;
    try {
      const approvedInventoryFingerprint = manifest.inventoryMode === "DYNAMIC"
        ? await this.#fetchInventoryFingerprint(baseRecord, manifest)
        : null;
      const record = { ...baseRecord, approvedInventoryFingerprint } satisfies ProviderRegistryRecord;
      await this.#deps.store.insert(record);
      inserted = true;
      await this.#audit({ operationId, operation: "add", phase: "success", providerInstanceId, adapterId: manifest.adapterId });
      return structuredClone(record);
    } catch (error) {
      let failure = asProviderFailure(error);
      try {
        const admitted = inserted || await this.#deps.store.get(providerInstanceId) !== null;
        if (admitted && !await this.#deps.store.remove(providerInstanceId)) {
          failure = stateFailure("Failed provider admission could not be rolled back");
        }
      } catch {
        failure = stateFailure("Failed provider admission could not be rolled back");
      }
      await this.#auditFailure({ operationId, operation: "add", providerInstanceId, adapterId: manifest.adapterId, failure });
      throw failure;
    }
  }

  async disable(providerInstanceId: string): Promise<ProviderRegistryRecord> {
    const current = await this.inspect(providerInstanceId);
    const manifest = this.#deps.adapters.require(current.adapterId);
    const operationId = this.#operationId();
    await this.#audit({ operationId, operation: "disable", phase: "decision", providerInstanceId: current.providerInstanceId, adapterId: manifest.adapterId });
    const updated = { ...current, enabled: false, updatedAt: this.#nowIso() } satisfies ProviderRegistryRecord;
    try {
      await this.#deps.store.replace(updated);
      await this.#audit({ operationId, operation: "disable", phase: "success", providerInstanceId: current.providerInstanceId, adapterId: manifest.adapterId });
      return structuredClone(updated);
    } catch (error) {
      let failure = asProviderFailure(error);
      failure = await this.#rollbackReplacement(current, failure);
      await this.#auditFailure({ operationId, operation: "disable", providerInstanceId: current.providerInstanceId, adapterId: manifest.adapterId, failure });
      throw failure;
    }
  }

  async remove(providerInstanceId: string): Promise<boolean> {
    const current = await this.inspect(providerInstanceId);
    const manifest = this.#deps.adapters.require(current.adapterId);
    const operationId = this.#operationId();
    await this.#audit({ operationId, operation: "remove", phase: "decision", providerInstanceId: current.providerInstanceId, adapterId: manifest.adapterId });
    let removed = false;
    try {
      removed = await this.#deps.store.remove(current.providerInstanceId);
      if (!removed) throw stateFailure("Provider registry changed during removal");
      await this.#audit({ operationId, operation: "remove", phase: "success", providerInstanceId: current.providerInstanceId, adapterId: manifest.adapterId });
      return true;
    } catch (error) {
      let failure = asProviderFailure(error);
      try {
        if (await this.#deps.store.get(current.providerInstanceId) === null) {
          await this.#deps.store.insert(current);
        }
      } catch {
        failure = stateFailure("Failed provider removal could not be rolled back");
      }
      await this.#auditFailure({ operationId, operation: "remove", providerInstanceId: current.providerInstanceId, adapterId: manifest.adapterId, failure });
      throw failure;
    }
  }

  async reapprove(providerInstanceId: string): Promise<ProviderRegistryRecord> {
    const current = await this.inspect(providerInstanceId);
    const manifest = this.#deps.adapters.require(current.adapterId);
    validateCredentialBrokerSelection(manifest, current.credentialBroker);
    const identity = await this.#resolveImplementationIdentity(manifest, current.credentialBroker);
    const operationId = this.#operationId();
    await this.#audit({ operationId, operation: "reapprove", phase: "decision", providerInstanceId: current.providerInstanceId, adapterId: manifest.adapterId });
    try {
      const provisional = {
        ...current,
        adapterContractVersion: manifest.adapterContractVersion,
        implementationFingerprint: identity.implementationFingerprint,
        inventoryMode: manifest.inventoryMode,
        approvedInventoryFingerprint: null,
        credentialBroker: canonicalCredentialBroker(current.credentialBroker, identity),
        updatedAt: this.#nowIso()
      } satisfies ProviderRegistryRecord;
      const approvedInventoryFingerprint = manifest.inventoryMode === "DYNAMIC"
        ? await this.#fetchInventoryFingerprint(provisional, manifest)
        : null;
      const updated = { ...provisional, approvedInventoryFingerprint } satisfies ProviderRegistryRecord;
      await this.#deps.store.replace(updated);
      await this.#audit({ operationId, operation: "reapprove", phase: "success", providerInstanceId: current.providerInstanceId, adapterId: manifest.adapterId });
      return structuredClone(updated);
    } catch (error) {
      let failure = asProviderFailure(error);
      failure = await this.#rollbackReplacement(current, failure);
      await this.#auditFailure({ operationId, operation: "reapprove", providerInstanceId: current.providerInstanceId, adapterId: manifest.adapterId, failure });
      throw failure;
    }
  }

  async enable(providerInstanceId: string): Promise<ProviderRegistryRecord> {
    const current = await this.inspect(providerInstanceId);
    const manifest = this.#deps.adapters.require(current.adapterId);
    validateCredentialBrokerSelection(manifest, current.credentialBroker);
    const identity = await this.#resolveImplementationIdentity(manifest, current.credentialBroker);
    if (identity.implementationFingerprint !== current.implementationFingerprint ||
        manifest.adapterContractVersion !== current.adapterContractVersion ||
        manifest.inventoryMode !== current.inventoryMode) {
      throw new CapabilityError("PROVIDER_IDENTITY_CHANGED", "Provider implementation identity changed and requires reapproval");
    }

    const operationId = this.#operationId();
    await this.#audit({ operationId, operation: "enable", phase: "decision", providerInstanceId: current.providerInstanceId, adapterId: manifest.adapterId });
    try {
      if (manifest.inventoryMode === "DYNAMIC") {
        const currentFingerprint = await this.#fetchInventoryFingerprint(current, manifest);
        if (current.approvedInventoryFingerprint === null || currentFingerprint !== current.approvedInventoryFingerprint) {
          throw new CapabilityError("PROVIDER_INVENTORY_CHANGED", "Provider inventory changed and requires reapproval");
        }
      }
      const updated = { ...current, enabled: true, updatedAt: this.#nowIso() } satisfies ProviderRegistryRecord;
      await this.#deps.store.replace(updated);
      await this.#audit({ operationId, operation: "enable", phase: "success", providerInstanceId: current.providerInstanceId, adapterId: manifest.adapterId });
      return structuredClone(updated);
    } catch (error) {
      let failure = asProviderFailure(error);
      failure = await this.#rollbackReplacement(current, failure);
      await this.#auditFailure({ operationId, operation: "enable", providerInstanceId: current.providerInstanceId, adapterId: manifest.adapterId, failure });
      throw failure;
    }
  }

  async list(): Promise<ProviderRegistryRecord[]> {
    return (await this.#deps.store.list()).map((record) => structuredClone(record));
  }

  async inspect(providerInstanceId: string): Promise<ProviderRegistryRecord> {
    const parsed = ProviderInstanceIdSchema.safeParse(providerInstanceId);
    if (!parsed.success) throw new CapabilityError("PROVIDER_INPUT_INVALID", "Provider instance ID is invalid");
    const record = await this.#deps.store.get(parsed.data);
    if (record === null) throw new CapabilityError("PROVIDER_NOT_ADMITTED", "Provider is not admitted");
    return structuredClone(record);
  }

  async #resolveImplementationIdentity(manifest: ProviderAdapterManifest, credentialBroker: ProviderCredentialBrokerDescriptor): Promise<ProviderImplementationIdentity> {
    const resolver = this.#deps.resolveImplementationIdentity ?? resolveProviderImplementationIdentity;
    return await resolver({ manifest, credentialBroker, workspaceRoots: this.#deps.workspaceRoots() });
  }

  async #audit(metadata: ProviderAuditMetadata): Promise<void> {
    await this.#deps.audit.record(metadata);
  }

  async #fetchInventoryFingerprint(provider: ProviderRegistryRecord, manifest: ProviderAdapterManifest): Promise<string> {
    const controller = new AbortController();
    const credential = await this.#deps.credentials.acquire({ provider, manifest, signal: controller.signal });
    const inventory = await this.#deps.inventory.fetch({ provider, manifest, credential, signal: controller.signal });
    const normalized = normalizeProviderInventory(inventory);
    if (normalized.adapterContractVersion !== manifest.adapterContractVersion) {
      throw new CapabilityError("PROVIDER_RESPONSE_INVALID", "Provider inventory adapter contract version does not match compiled manifest");
    }
    return fingerprintProviderInventory(normalized);
  }

  async #rollbackReplacement(previous: ProviderRegistryRecord, failure: CapabilityError): Promise<CapabilityError> {
    try {
      await this.#deps.store.replace(previous);
      return failure;
    } catch {
      return stateFailure("Failed provider mutation could not be rolled back");
    }
  }

  async #auditFailure(input: { operationId: string; operation: ProviderAuditMetadata["operation"]; providerInstanceId: string; adapterId: string; failure: CapabilityError }): Promise<void> {
    try {
      await this.#audit({
        operationId: input.operationId,
        operation: input.operation,
        phase: "failed",
        providerInstanceId: input.providerInstanceId,
        adapterId: input.adapterId,
        errorCode: providerErrorCode(input.failure),
        ...(input.failure.code === "PROVIDER_INVENTORY_CHANGED" ? { inventoryChanged: true } : {})
      });
    } catch (auditError) {
      const failure = asProviderFailure(auditError);
      if (failure.code === "PROVIDER_AUDIT_UNAVAILABLE") throw failure;
      throw new CapabilityError("PROVIDER_AUDIT_UNAVAILABLE", "Provider failed-outcome audit is unavailable");
    }
  }

  #providerInstanceId(): string {
    const value = this.#deps.generateProviderInstanceId?.() ?? `prv_${randomBytes(16).toString("hex")}`;
    if (!ProviderInstanceIdSchema.safeParse(value).success) throw new CapabilityError("PROVIDER_INPUT_INVALID", "Generated provider instance ID is invalid");
    return value;
  }

  #operationId(): string {
    const value = this.#deps.generateOperationId?.() ?? `op_${randomBytes(18).toString("base64url")}`;
    if (!ProviderOperationIdSchema.safeParse(value).success) throw new CapabilityError("PROVIDER_INPUT_INVALID", "Generated provider operation ID is invalid");
    return value;
  }

  #nowIso(): string {
    const value = this.#deps.nowIso?.() ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(value))) throw new CapabilityError("PROVIDER_INPUT_INVALID", "Generated provider timestamp is invalid");
    return value;
  }
}

function parseAddInput(input: ProviderAddInput): ProviderAddInput {
  const parsed = ProviderAddInputSchema.safeParse(input);
  if (!parsed.success) throw new CapabilityError("PROVIDER_INPUT_INVALID", "Provider add input is invalid");
  return parsed.data;
}

function validateOperatorConfig(value: Record<string, unknown>): Record<string, unknown> {
  try {
    assertProviderNonSecretConfig(value);
  } catch {
    throw new CapabilityError("PROVIDER_INPUT_INVALID", "Provider non-secret config is invalid");
  }
  return structuredClone(value);
}

function validateCredentialBrokerSelection(manifest: ProviderAdapterManifest, descriptor: ProviderCredentialBrokerDescriptor): void {
  if (manifest.credentialBroker.kind !== descriptor.kind) {
    throw new CapabilityError("PROVIDER_INPUT_INVALID", "Provider credential broker selection does not match compiled adapter policy");
  }
}

function canonicalCredentialBroker(descriptor: ProviderCredentialBrokerDescriptor, identity: ProviderImplementationIdentity): ProviderCredentialBrokerDescriptor {
  if (descriptor.kind === "none") return { kind: "none" };
  if (identity.helperIdentity === null) {
    throw new CapabilityError("PROVIDER_INPUT_INVALID", "Provider credential helper identity was not resolved");
  }
  return {
    kind: "external-helper",
    helperPath: identity.helperIdentity.canonicalPath,
    helperSha256: identity.helperIdentity.sha256
  };
}

function asProviderFailure(error: unknown): CapabilityError {
  if (error instanceof CapabilityError && PROVIDER_ERROR_CODE_SET.has(error.code)) return error;
  return new CapabilityError("PROVIDER_REQUEST_FAILED", "Provider operation failed");
}

function providerErrorCode(error: CapabilityError): ProviderErrorCode {
  return PROVIDER_ERROR_CODE_SET.has(error.code) ? error.code as ProviderErrorCode : "PROVIDER_REQUEST_FAILED";
}

function stateFailure(message: string): CapabilityError {
  return new CapabilityError("PROVIDER_STATE_INVALID", message);
}
