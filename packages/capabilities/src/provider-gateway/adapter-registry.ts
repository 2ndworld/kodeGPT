import { isIP } from "node:net";

import { CapabilityError } from "../errors.js";
import {
  PROVIDER_MAX_REQUESTS,
  type ProviderAdapterManifest,
  type ProviderSemanticMappingDefinition
} from "./contracts.js";
import { GITHUB_READ_PROVIDER_MANIFEST } from "./github.js";

export const PRODUCTION_PROVIDER_MANIFESTS: readonly ProviderAdapterManifest[] = Object.freeze([
  GITHUB_READ_PROVIDER_MANIFEST
]);

export class ProviderAdapterRegistry {
  readonly #manifests: readonly ProviderAdapterManifest[];
  readonly #byAdapterId: ReadonlyMap<string, ProviderAdapterManifest>;
  readonly #bySemanticCapabilityId: ReadonlyMap<string, ProviderSemanticMappingDefinition>;

  constructor(manifests: readonly ProviderAdapterManifest[]) {
    const byAdapterId = new Map<string, ProviderAdapterManifest>();
    const bySemanticCapabilityId = new Map<string, ProviderSemanticMappingDefinition>();
    const compiled: ProviderAdapterManifest[] = [];

    for (const manifest of manifests) {
      validateManifestShape(manifest);
      if (byAdapterId.has(manifest.adapterId)) {
        throw invalid(`Duplicate adapter id: ${manifest.adapterId}`);
      }
      const ownedOperations = new Set(manifest.operations.map((operation) => operation.id));
      for (const mapping of manifest.mappings) {
        validateMapping(mapping, manifest.adapterId, ownedOperations);
      }

      const frozen = freezeManifest(manifest);
      byAdapterId.set(frozen.adapterId, frozen);
      compiled.push(frozen);

      for (const mapping of frozen.mappings) {
        if (bySemanticCapabilityId.has(mapping.semanticCapabilityId)) {
          throw invalid(`Duplicate semantic capability id: ${mapping.semanticCapabilityId}`);
        }
        bySemanticCapabilityId.set(mapping.semanticCapabilityId, mapping);
      }
    }

    compiled.sort((left, right) => left.adapterId.localeCompare(right.adapterId));
    this.#manifests = Object.freeze(compiled);
    this.#byAdapterId = byAdapterId;
    this.#bySemanticCapabilityId = bySemanticCapabilityId;
  }

  list(): readonly ProviderAdapterManifest[] {
    return this.#manifests;
  }

  require(adapterId: string): ProviderAdapterManifest {
    const manifest = this.#byAdapterId.get(adapterId);
    if (manifest === undefined) {
      throw new CapabilityError("PROVIDER_INPUT_INVALID", `Unknown compiled provider adapter: ${adapterId}`);
    }
    return manifest;
  }

  requireMapping(semanticCapabilityId: string): ProviderSemanticMappingDefinition {
    const mapping = this.#bySemanticCapabilityId.get(semanticCapabilityId);
    if (mapping === undefined) {
      throw new CapabilityError("PROVIDER_TOOL_UNAVAILABLE", `Unknown provider semantic capability: ${semanticCapabilityId}`);
    }
    return mapping;
  }
}

function validateManifestShape(manifest: ProviderAdapterManifest): void {
  assertExactKeys(manifest, [
    "adapterId",
    "adapterContractVersion",
    "implementationDigest",
    "inventoryMode",
    "networkPolicy",
    "credentialBroker",
    "operations",
    "mappings"
  ], "manifest");
  requireAuthorityId(manifest.adapterId, "adapter id");
  requireAuthorityId(manifest.adapterContractVersion, "adapter contract version", 64);
  if (!/^[0-9a-f]{64}$/.test(manifest.implementationDigest)) {
    throw invalid("Provider implementation digest must be lowercase SHA-256");
  }
  if (manifest.inventoryMode !== "STATIC" && manifest.inventoryMode !== "DYNAMIC") {
    throw invalid("Provider inventory mode must be STATIC or DYNAMIC");
  }
  if (!Array.isArray(manifest.operations) || !Array.isArray(manifest.mappings)) {
    throw invalid("Provider manifest operations and mappings must be compiled arrays");
  }
  validateNetworkPolicy(manifest.networkPolicy);
  validateCredentialPolicy(manifest.credentialBroker);

  const operationIds = new Set<string>();
  for (const operation of manifest.operations) {
    validateOperation(operation, manifest.networkPolicy.origins);
    if (operationIds.has(operation.id)) throw invalid(`Duplicate provider operation id: ${operation.id}`);
    operationIds.add(operation.id);
  }
}

function validateNetworkPolicy(policy: ProviderAdapterManifest["networkPolicy"]): void {
  assertExactKeys(policy, ["kind", "origins", "redirect"], "network policy");
  if (policy.kind !== "internet" || !Array.isArray(policy.origins) || policy.origins.length === 0) {
    throw invalid("Internet provider policy must define at least one HTTPS exact origin");
  }
  const seen = new Set<string>();
  for (const origin of policy.origins) {
    if (typeof origin !== "string") throw invalid("Provider origins must be fixed strings");
    validateExactHttpsOrigin(origin);
    if (seen.has(origin)) throw invalid(`Duplicate provider origin: ${origin}`);
    seen.add(origin);
  }
  if (policy.redirect !== null) {
    assertExactKeys(policy.redirect, ["fromOrigin", "toOrigin"], "redirect policy");
    validateExactHttpsOrigin(policy.redirect.fromOrigin);
    validateExactHttpsOrigin(policy.redirect.toOrigin);
    if (!seen.has(policy.redirect.fromOrigin) || !seen.has(policy.redirect.toOrigin)) {
      throw invalid("Redirect origins must both be present in the compiled provider origin policy");
    }
    if (policy.redirect.fromOrigin === policy.redirect.toOrigin) {
      throw invalid("Redirect policy must cross between two explicitly reviewed origins");
    }
  }
}

function validateExactHttpsOrigin(origin: string): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw invalid("Provider network policy requires an HTTPS exact origin");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== origin ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw invalid("Provider network policy requires an HTTPS exact origin");
  }
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  if (isIP(hostname) !== 0) {
    throw invalid("Provider Internet origins may not use a raw IP address");
  }
}

function validateCredentialPolicy(policy: ProviderAdapterManifest["credentialBroker"]): void {
  if (policy.kind === "none") {
    assertExactKeys(policy, ["kind"], "credential broker policy");
    return;
  }
  assertExactKeys(policy, ["kind", "credentialKind", "argv", "environment"], "credential broker policy");
  if (
    policy.kind !== "external-helper" ||
    (policy.credentialKind !== "bearer" && policy.credentialKind !== "opaque") ||
    !Array.isArray(policy.argv) ||
    policy.argv.length === 0
  ) {
    throw invalid("Provider credential broker policy is invalid");
  }
  for (const argument of policy.argv) {
    if (typeof argument !== "string" || argument.length === 0 || argument.length > 4096 || /[{}\0]/.test(argument)) {
      throw invalid("Provider credential helper argv must be fixed compiled values");
    }
  }
  if (!isPlainRecord(policy.environment)) {
    throw invalid("Provider credential helper environment must be a fixed compiled allowlist");
  }
  for (const [key, value] of Object.entries(policy.environment)) {
    if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || value.length > 4096 || /[{}\0]/.test(value)) {
      throw invalid("Provider credential helper environment must be a fixed compiled allowlist");
    }
  }
}

function validateOperation(operation: ProviderAdapterManifest["operations"][number], origins: readonly string[]): void {
  assertExactKeys(operation, [
    "id",
    "method",
    "origin",
    "pathTemplate",
    "allowedQueryKeys",
    "fixedHeaders",
    "inputSchema",
    "encodeRequest"
  ], "operation");
  requireAuthorityId(operation.id, "provider operation id");
  if (operation.method !== "GET" && operation.method !== "POST" && operation.method !== "PUT") {
    throw invalid("Provider adapters must use a fixed provider operation method");
  }
  if (!origins.includes(operation.origin)) {
    throw invalid("Provider operation origin must be owned by its compiled network policy");
  }
  if (
    typeof operation.pathTemplate !== "string" ||
    !operation.pathTemplate.startsWith("/") ||
    operation.pathTemplate.startsWith("//") ||
    operation.pathTemplate.length > 2048 ||
    /https?:|\{(?:url|uri|host|hostname|origin|method|headers?)\}/i.test(operation.pathTemplate) ||
    operation.pathTemplate.includes("\0")
  ) {
    throw invalid("Provider adapters must define a fixed provider operation path template");
  }
  if (!Array.isArray(operation.allowedQueryKeys)) {
    throw invalid("Provider operation query keys must be a fixed compiled array");
  }
  for (const key of operation.allowedQueryKeys) {
    if (typeof key !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(key)) {
      throw invalid("Provider operation query keys must be fixed compiled names");
    }
  }
  if (!isPlainRecord(operation.fixedHeaders)) {
    throw invalid("Provider operation headers must be fixed compiled values");
  }
  for (const [name, value] of Object.entries(operation.fixedHeaders)) {
    if (typeof value !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(name) || /[{}\r\n\0]/.test(value)) {
      throw invalid("Provider operation headers must be fixed compiled values");
    }
    if (/^(?:authorization|proxy-authorization|cookie|set-cookie)$/i.test(name)) {
      throw invalid("Credential-bearing headers are injected only by provider transport");
    }
  }
  if (typeof operation.inputSchema?.safeParse !== "function" || typeof operation.encodeRequest !== "function") {
    throw invalid("Provider operation must provide a reviewed input schema and request encoder");
  }
}

function validateMapping(
  mapping: ProviderSemanticMappingDefinition,
  manifestAdapterId: string,
  ownedOperations: ReadonlySet<string>
): void {
  assertExactKeys(mapping, [
    "semanticCapabilityId",
    "adapterId",
    "adapterOperationId",
    "effect",
    "workspaceBinding",
    "inputSchema",
    "outputSchema",
    "maxProviderRequests",
    "retry",
    "auditFields"
  ], "mapping", ["mapOutput"]);
  requireAuthorityId(mapping.semanticCapabilityId, "semantic capability id");
  if (mapping.adapterId !== manifestAdapterId) {
    throw invalid("Provider semantic mapping must belong to the same adapter manifest");
  }
  if (!ownedOperations.has(mapping.adapterOperationId)) {
    throw invalid("Provider semantic mapping must reference an owned operation");
  }
  if (mapping.effect !== "REMOTE_READ" && mapping.effect !== "REMOTE_MUTATION") {
    throw invalid("Provider semantic mapping has invalid effect");
  }
  if (!["REQUIRED", "OPTIONAL", "NONE"].includes(mapping.workspaceBinding)) {
    throw invalid("Provider semantic mapping has invalid workspace binding");
  }
  if (!Number.isSafeInteger(mapping.maxProviderRequests) || mapping.maxProviderRequests < 1 || mapping.maxProviderRequests > PROVIDER_MAX_REQUESTS) {
    throw invalid(`Provider semantic mapping request budget must be 1..${PROVIDER_MAX_REQUESTS}`);
  }
  if (mapping.retry !== "none" && mapping.retry !== "one-idempotent-read") {
    throw invalid("Provider semantic mapping has invalid retry policy");
  }
  if (mapping.effect === "REMOTE_MUTATION" && mapping.retry !== "none") {
    throw invalid("Provider mutation mappings may not retry");
  }
  if (mapping.effect === "REMOTE_MUTATION" && mapping.maxProviderRequests !== 1) {
    throw invalid("Provider mutation mappings must use exactly one request");
  }
  if (typeof mapping.inputSchema?.safeParse !== "function" || typeof mapping.outputSchema?.safeParse !== "function") {
    throw invalid("Provider semantic mapping must provide reviewed input and output schemas");
  }
  if (mapping.mapOutput !== undefined && typeof mapping.mapOutput !== "function") {
    throw invalid("Provider semantic mapping output mapper must be a function");
  }
  if (!Array.isArray(mapping.auditFields)) {
    throw invalid("Provider semantic mapping audit fields must be a fixed compiled array");
  }
  const auditFields = new Set<string>();
  for (const field of mapping.auditFields) {
    if (typeof field !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(field) || auditFields.has(field)) {
      throw invalid("Provider semantic mapping audit fields must be unique fixed names");
    }
    auditFields.add(field);
  }
}

function freezeManifest(manifest: ProviderAdapterManifest): ProviderAdapterManifest {
  const networkPolicy = Object.freeze({
    kind: "internet" as const,
    origins: Object.freeze([...manifest.networkPolicy.origins]),
    redirect: manifest.networkPolicy.redirect === null
      ? null
      : Object.freeze({
          fromOrigin: manifest.networkPolicy.redirect.fromOrigin,
          toOrigin: manifest.networkPolicy.redirect.toOrigin
        })
  });
  const credentialBroker = manifest.credentialBroker.kind === "none"
    ? Object.freeze({ kind: "none" as const })
    : Object.freeze({
        kind: "external-helper" as const,
        credentialKind: manifest.credentialBroker.credentialKind,
        argv: Object.freeze([...manifest.credentialBroker.argv]),
        environment: Object.freeze({ ...manifest.credentialBroker.environment })
      });
  const operations = Object.freeze(manifest.operations.map((operation) => Object.freeze({
    id: operation.id,
    method: operation.method,
    origin: operation.origin,
    pathTemplate: operation.pathTemplate,
    allowedQueryKeys: Object.freeze([...operation.allowedQueryKeys]),
    fixedHeaders: Object.freeze({ ...operation.fixedHeaders }),
    inputSchema: operation.inputSchema,
    encodeRequest: operation.encodeRequest
  })));
  const mappings = Object.freeze(manifest.mappings.map((mapping) => Object.freeze({
    semanticCapabilityId: mapping.semanticCapabilityId,
    adapterId: mapping.adapterId,
    adapterOperationId: mapping.adapterOperationId,
    effect: mapping.effect,
    workspaceBinding: mapping.workspaceBinding,
    inputSchema: mapping.inputSchema,
    outputSchema: mapping.outputSchema,
    ...(mapping.mapOutput === undefined ? {} : { mapOutput: mapping.mapOutput }),
    maxProviderRequests: mapping.maxProviderRequests,
    retry: mapping.retry,
    auditFields: Object.freeze([...mapping.auditFields])
  })));
  return Object.freeze({
    adapterId: manifest.adapterId,
    adapterContractVersion: manifest.adapterContractVersion,
    implementationDigest: manifest.implementationDigest,
    inventoryMode: manifest.inventoryMode,
    networkPolicy,
    credentialBroker,
    operations,
    mappings
  });
}

function assertExactKeys(
  value: unknown,
  required: readonly string[],
  label: string,
  optional: readonly string[] = []
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw invalid(`Invalid ${label}`);
  const allowedSet = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw invalid(`Unknown ${label} field: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw invalid(`Missing ${label} field: ${key}`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireAuthorityId(value: string, label: string, maxLength = 128): void {
  const maxTail = maxLength - 1;
  const pattern = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:+-]{0,${maxTail}}$`);
  if (!pattern.test(value)) throw invalid(`Invalid ${label}`);
}

function invalid(message: string): CapabilityError {
  return new CapabilityError("PROVIDER_INPUT_INVALID", message);
}
