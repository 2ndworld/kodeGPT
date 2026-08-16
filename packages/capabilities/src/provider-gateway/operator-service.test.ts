import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { CapabilityError } from "../errors.js";
import type {
  ProviderAdapterManifest,
  ProviderAuditMetadata,
  ProviderCredential,
  ProviderRegistryRecord,
  ProviderStructuralInventory
} from "./index.js";
import {
  ProviderOperatorService,
  type ProviderOperatorDependencies,
  type ProviderRegistryRepository
} from "./operator-service.js";

const providerId = "prv_0123456789abcdef0123456789abcdef";
const implementationFingerprint = "a".repeat(64);

function manifest(inventoryMode: "STATIC" | "DYNAMIC" = "DYNAMIC"): ProviderAdapterManifest {
  return {
    adapterId: "test.fixture.read.v1",
    adapterContractVersion: "1",
    implementationDigest: "b".repeat(64),
    inventoryMode,
    networkPolicy: { kind: "internet", origins: ["https://fixture.example"], redirect: null },
    credentialBroker: { kind: "none" },
    operations: [],
    mappings: [{
      semanticCapabilityId: "test.fixture.record.read",
      adapterId: "test.fixture.read.v1",
      adapterOperationId: "record.read",
      effect: "REMOTE_READ",
      workspaceBinding: "NONE",
      inputSchema: z.object({ id: z.string() }).strict(),
      outputSchema: z.object({ id: z.string() }).strict(),
      maxProviderRequests: 1,
      retry: "none",
      auditFields: ["id"]
    }]
  };
}

function inventory(toolId = "record.read"): ProviderStructuralInventory {
  return {
    adapterContractVersion: "1",
    providerContractVersion: "fixture-v1",
    tools: [{ id: toolId, inputSchema: { type: "object" }, outputSchema: { type: "object" } }]
  };
}

class MemoryStore implements ProviderRegistryRepository {
  readonly records = new Map<string, ProviderRegistryRecord>();
  constructor(readonly events: string[]) {}
  async list() { return [...this.records.values()].map((value) => structuredClone(value)); }
  async get(id: string) { return this.records.has(id) ? structuredClone(this.records.get(id)!) : null; }
  async insert(record: ProviderRegistryRecord) { this.events.push("registry-write"); this.records.set(record.providerInstanceId, structuredClone(record)); }
  async replace(record: ProviderRegistryRecord) { this.events.push("registry-write"); this.records.set(record.providerInstanceId, structuredClone(record)); }
  async remove(id: string) { this.events.push("registry-remove"); return this.records.delete(id); }
}

function fixture(input: { inventoryError?: Error; inventoryMode?: "STATIC" | "DYNAMIC" } = {}) {
  const events: string[] = [];
  const store = new MemoryStore(events);
  const selectedManifest = manifest(input.inventoryMode ?? "DYNAMIC");
  const deps: ProviderOperatorDependencies = {
    store,
    adapters: {
      require(adapterId) {
        events.push("resolve-manifest");
        if (adapterId !== selectedManifest.adapterId) throw new CapabilityError("PROVIDER_INPUT_INVALID", "unknown adapter");
        return selectedManifest;
      }
    },
    audit: {
      async record(metadata: ProviderAuditMetadata) {
        events.push(`audit-${metadata.phase}`);
      }
    },
    resolveImplementationIdentity: async () => {
      events.push("verify-helper-identity-and-compute-implementation-identity");
      return { implementationFingerprint, helperIdentity: null };
    },
    credentials: {
      async acquire(): Promise<ProviderCredential | null> {
        events.push("credential-acquire");
        return null;
      }
    },
    inventory: {
      async fetch() {
        events.push("inventory-fetch");
        if (input.inventoryError !== undefined) throw input.inventoryError;
        return inventory();
      }
    },
    generateProviderInstanceId: () => providerId,
    generateOperationId: () => "op_fixture",
    nowIso: () => "2026-08-16T00:00:00.000Z",
    workspaceRoots: () => []
  };
  return { events, store, service: new ProviderOperatorService(deps), deps };
}

const addInput = {
  adapterId: "test.fixture.read.v1",
  operatorName: "Fixture provider",
  credentialBroker: { kind: "none" as const },
  nonSecretAdapterConfig: {}
};

describe("ProviderOperatorService", () => {
  it("records a durable decision before credential or inventory side effects", async () => {
    const { service, events } = fixture();
    const record = await service.add(addInput);
    expect(record.providerInstanceId).toBe(providerId);
    expect(record.enabled).toBe(true);
    expect(record.approvedInventoryFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(events).toEqual([
      "resolve-manifest",
      "verify-helper-identity-and-compute-implementation-identity",
      "audit-decision",
      "credential-acquire",
      "inventory-fetch",
      "registry-write",
      "audit-success"
    ]);
  });

  it("leaves no admitted record when dynamic inventory fails after decision", async () => {
    const original = new CapabilityError("PROVIDER_RESPONSE_INVALID", "invalid inventory");
    const { service, store, events } = fixture({ inventoryError: original });
    await expect(service.add(addInput)).rejects.toBe(original);
    expect(await store.list()).toEqual([]);
    expect(events).toEqual([
      "resolve-manifest",
      "verify-helper-identity-and-compute-implementation-identity",
      "audit-decision",
      "credential-acquire",
      "inventory-fetch",
      "audit-failed"
    ]);
  });

  it("rolls back admission when registry insert becomes authoritative before throwing", async () => {
    const fx = fixture();
    fx.store.insert = async (record) => {
      fx.events.push("registry-write");
      fx.store.records.set(record.providerInstanceId, structuredClone(record));
      throw new CapabilityError("PROVIDER_STATE_INVALID", "durability failed");
    };

    await expect(fx.service.add(addInput)).rejects.toMatchObject({ code: "PROVIDER_STATE_INVALID" });
    expect(await fx.store.list()).toEqual([]);
    expect(fx.events.at(-1)).toBe("audit-failed");
  });

  it("does not remove an existing provider when a generated ID collides", async () => {
    const fx = fixture();
    const original = await fx.service.add(addInput);
    fx.events.length = 0;
    fx.store.insert = async (record) => {
      if (fx.store.records.has(record.providerInstanceId)) {
        throw new CapabilityError("PROVIDER_STATE_INVALID", "duplicate provider");
      }
      fx.events.push("registry-write");
      fx.store.records.set(record.providerInstanceId, structuredClone(record));
    };

    await expect(fx.service.add(addInput)).rejects.toMatchObject({ code: "PROVIDER_STATE_INVALID" });
    expect(await fx.store.get(providerId)).toEqual(original);
    expect(fx.events).toEqual(["resolve-manifest", "verify-helper-identity-and-compute-implementation-identity"]);
  });

  it("rejects caller authority fields before audit or side effects", async () => {
    const { service, events } = fixture();
    await expect(service.add({ ...addInput, endpoint: "https://attacker.invalid" } as never))
      .rejects.toMatchObject({ code: "PROVIDER_INPUT_INVALID" });
    expect(events).toEqual([]);
  });

  it("disable and remove audit before mutation without credential or inventory calls", async () => {
    const { service, events } = fixture({ inventoryMode: "STATIC" });
    await service.add(addInput);
    events.length = 0;
    await service.disable(providerId);
    expect(events).toEqual(["resolve-manifest", "audit-decision", "registry-write", "audit-success"]);
    events.length = 0;
    await expect(service.remove(providerId)).resolves.toBe(true);
    expect(events).toEqual(["resolve-manifest", "audit-decision", "registry-remove", "audit-success"]);
  });

  it("restores the previous record when replace becomes authoritative before throwing", async () => {
    const fx = fixture({ inventoryMode: "STATIC" });
    const original = await fx.service.add(addInput);
    fx.events.length = 0;
    fx.store.replace = async (record) => {
      fx.events.push("registry-write");
      fx.store.records.set(record.providerInstanceId, structuredClone(record));
      throw new CapabilityError("PROVIDER_STATE_INVALID", "durability failed");
    };

    await expect(fx.service.disable(providerId)).rejects.toMatchObject({ code: "PROVIDER_STATE_INVALID" });
    expect(await fx.store.get(providerId)).toEqual(original);
    expect(fx.events.at(-1)).toBe("audit-failed");
  });

  it("restores a removed record when removal becomes authoritative before throwing", async () => {
    const fx = fixture({ inventoryMode: "STATIC" });
    const original = await fx.service.add(addInput);
    fx.events.length = 0;
    fx.store.remove = async (id) => {
      fx.events.push("registry-remove");
      fx.store.records.delete(id);
      throw new CapabilityError("PROVIDER_STATE_INVALID", "durability failed");
    };

    await expect(fx.service.remove(providerId)).rejects.toMatchObject({ code: "PROVIDER_STATE_INVALID" });
    expect(await fx.store.get(providerId)).toEqual(original);
    expect(fx.events.at(-1)).toBe("audit-failed");
  });

  it("reapprove refreshes implementation and dynamic inventory only after decision", async () => {
    const { service, events, deps } = fixture();
    await service.add(addInput);
    events.length = 0;
    deps.resolveImplementationIdentity = async () => {
      events.push("verify-helper-identity-and-compute-implementation-identity");
      return { implementationFingerprint: "d".repeat(64), helperIdentity: null };
    };
    const updated = await service.reapprove(providerId);
    expect(updated.implementationFingerprint).toBe("d".repeat(64));
    expect(events).toEqual([
      "resolve-manifest",
      "verify-helper-identity-and-compute-implementation-identity",
      "audit-decision",
      "credential-acquire",
      "inventory-fetch",
      "registry-write",
      "audit-success"
    ]);
  });

  it("enable detects implementation and inventory drift before enabling", async () => {
    const fx = fixture();
    await fx.service.add(addInput);
    await fx.service.disable(providerId);
    fx.events.length = 0;
    fx.deps.resolveImplementationIdentity = async () => ({ implementationFingerprint: "f".repeat(64), helperIdentity: null });
    await expect(fx.service.enable(providerId)).rejects.toMatchObject({ code: "PROVIDER_IDENTITY_CHANGED" });
    expect((await fx.store.get(providerId))?.enabled).toBe(false);

    fx.deps.resolveImplementationIdentity = async () => ({ implementationFingerprint, helperIdentity: null });
    fx.deps.inventory.fetch = vi.fn(async () => inventory("changed.read"));
    await expect(fx.service.enable(providerId)).rejects.toMatchObject({ code: "PROVIDER_INVENTORY_CHANGED" });
    expect((await fx.store.get(providerId))?.enabled).toBe(false);
  });
});
