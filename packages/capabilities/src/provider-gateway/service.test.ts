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

function mutationManifest(): ProviderAdapterManifest {
  return {
    adapterId: "test.fixture.write.v1",
    adapterContractVersion: "1",
    implementationDigest: "c".repeat(64),
    inventoryMode: "STATIC",
    networkPolicy: { kind: "internet", origins: ["https://fixture.example"], redirect: null },
    credentialBroker: { kind: "none" },
    operations: [{
      id: "record.mutate",
      method: "PUT" as never,
      origin: "https://fixture.example",
      pathTemplate: "/records/{id}",
      allowedQueryKeys: [],
      fixedHeaders: {},
      inputSchema: z.object({ id: z.string() }).strict(),
      encodeRequest: (input) => ({ pathParameters: { id: (input as { id: string }).id } })
    }],
    mappings: [{
      semanticCapabilityId: "test.fixture.record.mutate",
      adapterId: "test.fixture.write.v1",
      adapterOperationId: "record.mutate",
      effect: "REMOTE_MUTATION" as never,
      workspaceBinding: "NONE",
      inputSchema: z.object({ id: z.string() }).strict(),
      outputSchema: z.object({ ok: z.literal(true) }).strict(),
      maxProviderRequests: 1,
      retry: "none",
      auditFields: ["id"]
    }]
  };
}

function record(adapterId = "test.fixture.read.v1"): ProviderRegistryRecord {
  return {
    schemaVersion: 1,
    providerInstanceId: providerId,
    operatorName: "Fixture provider",
    adapterId,
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

function fixture(input: { mutation?: boolean } = {}) {
  const selectedManifest = input.mutation ? mutationManifest() : manifest();
  const selectedRecord = record(selectedManifest.adapterId);
  const state = {
    network: "unrestricted" as "deny" | "unrestricted",
    credentialCalls: 0,
    transportCalls: 0,
    inventoryCalls: 0,
    failDecisionAudit: false,
    failSuccessAudit: false,
    failFailedAudit: false,
    transportError: null as CapabilityError | null,
    responseBody: input.mutation
      ? Buffer.from(JSON.stringify({ ok: true }))
      : Buffer.from(JSON.stringify({ id: "123", value: "ok" })),
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
        if (metadata.phase === "success" && state.failSuccessAudit) {
          throw new CapabilityError("PROVIDER_AUDIT_UNAVAILABLE", "success audit unavailable");
        }
        if (metadata.phase === "failed" && state.failFailedAudit) {
          throw new CapabilityError("PROVIDER_AUDIT_UNAVAILABLE", "failed audit unavailable");
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
        if (state.transportError !== null) throw state.transportError;
        return {
          statusCode: 200,
          headers: {},
          body: state.responseBody,
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

function mutationExecInput() {
  return {
    semanticCapabilityId: "test.fixture.record.mutate",
    providerInstanceId: providerId,
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

  it("executes a reviewed mutation exactly once after durable decision", async () => {
    const fx = fixture({ mutation: true });
    await expect(fx.service.execute(mutationExecInput())).resolves.toMatchObject({
      semanticCapabilityId: "test.fixture.record.mutate",
      value: { ok: true }
    });
    expect(fx.state.transportCalls).toBe(1);
    expect(fx.state.events).toEqual(["audit-decision", "credential", "transport", "audit-success"]);
  });

  it("keeps mutation effects blocked when decision audit is unavailable", async () => {
    const fx = fixture({ mutation: true });
    fx.state.failDecisionAudit = true;
    await expect(fx.service.execute(mutationExecInput())).rejects.toMatchObject({
      code: "PROVIDER_AUDIT_UNAVAILABLE"
    });
    expect(fx.state.credentialCalls).toBe(0);
    expect(fx.state.transportCalls).toBe(0);
  });

  it.each(["PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE", "PROVIDER_CANCELLED"] as const)(
    "reports %s during mutation transport as outcome unknown without retry",
    async (code) => {
      const fx = fixture({ mutation: true });
      fx.state.transportError = new CapabilityError(code, "transport failed");
      await expect(fx.service.execute(mutationExecInput())).rejects.toMatchObject({
        code: "PROVIDER_MUTATION_OUTCOME_UNKNOWN"
      });
      expect(fx.state.transportCalls).toBe(1);
      expect(fx.state.events.filter((event) => event === "transport")).toHaveLength(1);
      expect(fx.state.events.at(-1)).toBe("audit-failed");
    }
  );

  it("keeps a deterministic provider rejection as an ordinary mutation failure", async () => {
    const fx = fixture({ mutation: true });
    fx.state.transportError = new CapabilityError("PROVIDER_REQUEST_FAILED", "provider rejected request");
    await expect(fx.service.execute(mutationExecInput())).rejects.toMatchObject({
      code: "PROVIDER_REQUEST_FAILED"
    });
    expect(fx.state.transportCalls).toBe(1);
  });

  it("reports invalid output after a successful mutation response as outcome unknown", async () => {
    const fx = fixture({ mutation: true });
    fx.state.responseBody = Buffer.from(JSON.stringify({ ok: false }));
    await expect(fx.service.execute(mutationExecInput())).rejects.toMatchObject({
      code: "PROVIDER_MUTATION_OUTCOME_UNKNOWN"
    });
    expect(fx.state.transportCalls).toBe(1);
  });

  it("preserves outcome-unknown when success or failure outcome audit becomes unavailable", async () => {
    const fx = fixture({ mutation: true });
    fx.state.failSuccessAudit = true;
    fx.state.failFailedAudit = true;
    await expect(fx.service.execute(mutationExecInput())).rejects.toMatchObject({
      code: "PROVIDER_MUTATION_OUTCOME_UNKNOWN"
    });
    expect(fx.state.transportCalls).toBe(1);
  });
});
