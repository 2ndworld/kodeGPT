import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CapabilityError } from "../errors.js";
import type {
  ProviderAdapterManifest,
  ProviderAuditMetadata,
  ProviderRegistryRecord
} from "./contracts.js";
import { ProviderGatewayServiceImpl, type ProviderGatewayServiceDependencies } from "./service.js";

const providerId = "prv_0123456789abcdef0123456789abcdef";
const implementationFingerprint = "a".repeat(64);

function manifest(): ProviderAdapterManifest {
  return {
    adapterId: "test.fixture.read.v1",
    adapterContractVersion: "1",
    implementationDigest: "b".repeat(64),
    inventoryMode: "STATIC",
    networkPolicy: { kind: "internet", origins: ["https://fixture.example"], redirect: null },
    credentialBroker: { kind: "none" },
    operations: [{
      id: "record.read",
      method: "GET",
      origin: "https://fixture.example",
      pathTemplate: "/records/{id}",
      allowedQueryKeys: [],
      fixedHeaders: {},
      inputSchema: z.object({ id: z.string() }).strict(),
      encodeRequest: (input) => ({ pathParameters: { id: (input as { id: string }).id } })
    }],
    mappings: [{
      semanticCapabilityId: "test.fixture.record.read",
      adapterId: "test.fixture.read.v1",
      adapterOperationId: "record.read",
      effect: "REMOTE_READ",
      workspaceBinding: "REQUIRED",
      inputSchema: z.object({ id: z.string() }).strict(),
      outputSchema: z.object({ id: z.string(), value: z.string() }).strict(),
      maxProviderRequests: 1,
      retry: "none",
      auditFields: ["id"]
    }]
  };
}

function record(): ProviderRegistryRecord {
  return {
    schemaVersion: 1,
    providerInstanceId: providerId,
    operatorName: "Fixture provider",
    adapterId: "test.fixture.read.v1",
    adapterContractVersion: "1",
    enabled: true,
    implementationFingerprint,
    inventoryMode: "STATIC",
    approvedInventoryFingerprint: null,
    credentialBroker: { kind: "none" },
    nonSecretAdapterConfig: {},
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z"
  };
}

function fixture() {
  const selectedManifest = manifest();
  const selectedRecord = record();
  const state = {
    network: "unrestricted" as "deny" | "unrestricted",
    credentialCalls: 0,
    transportCalls: 0,
    inventoryCalls: 0,
    failDecisionAudit: false,
    events: [] as string[]
  };
  const deps: ProviderGatewayServiceDependencies = {
    registry: {
      async get(id) { return id === providerId ? structuredClone(selectedRecord) : null; }
    },
    adapters: {
      require(id) {
        if (id !== selectedManifest.adapterId) throw new CapabilityError("PROVIDER_INPUT_INVALID", "unknown adapter");
        return selectedManifest;
      },
      requireMapping(id) {
        const mapping = selectedManifest.mappings.find((item) => item.semanticCapabilityId === id);
        if (mapping === undefined) throw new CapabilityError("PROVIDER_TOOL_UNAVAILABLE", "unknown mapping");
        return mapping;
      }
    },
    audit: {
      async record(metadata: ProviderAuditMetadata) {
        state.events.push(`audit-${metadata.phase}`);
        if (metadata.phase === "decision" && state.failDecisionAudit) {
          throw new CapabilityError("PROVIDER_AUDIT_UNAVAILABLE", "audit unavailable");
        }
      }
    },
    credentials: {
      async acquire() {
        state.credentialCalls += 1;
        state.events.push("credential");
        return null;
      }
    },
    inventory: {
      async fetch() {
        state.inventoryCalls += 1;
        state.events.push("inventory");
        return {
          adapterContractVersion: "1",
          providerContractVersion: null,
          tools: [{ id: "record.read", inputSchema: { type: "object" }, outputSchema: { type: "object" } }]
        };
      }
    },
    transport: {
      async request(input) {
        state.transportCalls += 1;
        state.events.push("transport");
        input.budget.claimRequest();
        return {
          statusCode: 200,
          headers: {},
          body: Buffer.from(JSON.stringify({ id: "123", value: "ok" })),
          finalOrigin: "https://fixture.example"
        };
      }
    },
    workspaceAuthority: {
      async resolve(workspaceId) {
        state.events.push("workspace-authority");
        return { workspaceId, network: state.network };
      }
    },
    workspaceRoots: () => [],
    resolveImplementationIdentity: async () => ({ implementationFingerprint, helperIdentity: null }),
    generateOperationId: () => "op_fixture"
  };
  return { state, deps, manifest: selectedManifest, service: new ProviderGatewayServiceImpl(deps), record: selectedRecord };
}

function execInput(workspaceId = "ws_1") {
  return {
    semanticCapabilityId: "test.fixture.record.read",
    providerInstanceId: providerId,
    workspaceId,
    input: { id: "123" }
  };
}

describe("ProviderGatewayServiceImpl", () => {
  it("denies workspace-bound provider reads before credentials", async () => {
    const fx = fixture();
    fx.state.network = "deny";
    await expect(fx.service.execute(execInput())).rejects.toMatchObject({ code: "PROVIDER_NETWORK_DENIED" });
    expect(fx.state.credentialCalls).toBe(0);
    expect(fx.state.transportCalls).toBe(0);
  });

  it("normalizes unavailable workspace authority before credentials", async () => {
    const fx = fixture();
    fx.deps.workspaceAuthority.resolve = async () => {
      throw new CapabilityError("WORKSPACE_NOT_READY", "workspace unavailable");
    };
    await expect(fx.service.execute(execInput())).rejects.toMatchObject({ code: "PROVIDER_NETWORK_DENIED" });
    expect(fx.state.credentialCalls).toBe(0);
    expect(fx.state.transportCalls).toBe(0);
  });

  it("fails before provider effects when the decision audit is unavailable", async () => {
    const fx = fixture();
    fx.state.failDecisionAudit = true;
    await expect(fx.service.execute(execInput())).rejects.toMatchObject({ code: "PROVIDER_AUDIT_UNAVAILABLE" });
    expect(fx.state.credentialCalls).toBe(0);
    expect(fx.state.transportCalls).toBe(0);
  });

  it("executes only the reviewed semantic mapping after durable decision", async () => {
    const fx = fixture();
    const result = await fx.service.execute(execInput());
    expect(result).toEqual({
      semanticCapabilityId: "test.fixture.record.read",
      providerInstanceId: providerId,
      value: { id: "123", value: "ok" },
      truncated: false,
      truncationReasons: []
    });
    expect(fx.state.events).toEqual([
      "workspace-authority",
      "audit-decision",
      "credential",
      "transport",
      "audit-success"
    ]);
  });

  it("blocks dynamic inventory drift before semantic transport", async () => {
    const fx = fixture();
    fx.manifest.inventoryMode = "DYNAMIC";
    fx.record.inventoryMode = "DYNAMIC";
    fx.record.approvedInventoryFingerprint = "d".repeat(64);

    await expect(fx.service.execute(execInput())).rejects.toMatchObject({ code: "PROVIDER_INVENTORY_CHANGED" });
    expect(fx.state.credentialCalls).toBe(1);
    expect(fx.state.inventoryCalls).toBe(1);
    expect(fx.state.transportCalls).toBe(0);
    expect(fx.state.events.at(-1)).toBe("audit-failed");
  });

  it("rejects implementation drift before credentials", async () => {
    const fx = fixture();
    fx.record.implementationFingerprint = "c".repeat(64);
    await expect(fx.service.execute(execInput())).rejects.toMatchObject({ code: "PROVIDER_IDENTITY_CHANGED" });
    expect(fx.state.credentialCalls).toBe(0);
    expect(fx.state.transportCalls).toBe(0);
  });

  it("rejects semantic input over 64 KiB before workspace or provider work", async () => {
    const fx = fixture();
    await expect(fx.service.execute({ ...execInput(), input: { id: "x".repeat(70 * 1024) } }))
      .rejects.toMatchObject({ code: "PROVIDER_INPUT_INVALID" });
    expect(fx.state.events).toEqual([]);
  });
});
