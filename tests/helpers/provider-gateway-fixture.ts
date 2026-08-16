import {
  CapabilityError,
  ProviderAdapterRegistry,
  ProviderGatewayServiceImpl,
  ProviderOperatorService,
  type ProviderAdapterManifest,
  type ProviderAddInput,
  type ProviderAuditMetadata,
  type ProviderCredentialBroker,
  type ProviderInventorySource,
  type ProviderRegistryRecord,
  type ProviderRegistryRepository,
  type ProviderStructuralInventory,
  type ProviderWorkspaceBinding
} from "../../packages/capabilities/src/index.js";

const HELPER_PATH = "/opt/kodegpt/test-provider-helper";
const HELPER_SHA = "2".repeat(64);
const ADAPTER_ID = "test.fixture.read.v1";
const SEMANTIC_ID = "test.fixture.record.read";

class MemoryProviderStore implements ProviderRegistryRepository {
  readonly records = new Map<string, ProviderRegistryRecord>();
  readonly events: string[];

  constructor(events: string[]) {
    this.events = events;
  }

  async list(): Promise<ProviderRegistryRecord[]> {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  async get(providerInstanceId: string): Promise<ProviderRegistryRecord | null> {
    const record = this.records.get(providerInstanceId);
    return record === undefined ? null : structuredClone(record);
  }

  async insert(record: ProviderRegistryRecord): Promise<void> {
    if (this.records.has(record.providerInstanceId)) {
      throw new CapabilityError("PROVIDER_STATE_INVALID", "duplicate provider fixture record");
    }
    this.events.push("registry-insert");
    this.records.set(record.providerInstanceId, structuredClone(record));
  }

  async replace(record: ProviderRegistryRecord): Promise<void> {
    if (!this.records.has(record.providerInstanceId)) {
      throw new CapabilityError("PROVIDER_NOT_ADMITTED", "missing provider fixture record");
    }
    this.events.push("registry-replace");
    this.records.set(record.providerInstanceId, structuredClone(record));
  }

  async remove(providerInstanceId: string): Promise<boolean> {
    this.events.push("registry-remove");
    return this.records.delete(providerInstanceId);
  }
}

type FixtureSchema = ProviderAdapterManifest["mappings"][number]["inputSchema"];

function fixtureInputSchema(): FixtureSchema {
  return {
    safeParse(value: unknown) {
      if (isRecord(value) && typeof value.id === "string" && value.id.length >= 1 && value.id.length <= 128) {
        return { success: true, data: { id: value.id } };
      }
      return { success: false, error: {} };
    }
  } as unknown as FixtureSchema;
}

function fixtureOutputSchema(): FixtureSchema {
  return {
    safeParse(value: unknown) {
      if (
        isRecord(value) &&
        Object.keys(value).length === 2 &&
        typeof value.id === "string" &&
        typeof value.value === "string"
      ) {
        return { success: true, data: { id: value.id, value: value.value } };
      }
      return { success: false, error: {} };
    }
  } as unknown as FixtureSchema;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ProviderGatewayFixtureState {
  implementationFingerprint: string;
  inventoryToolId: string;
  inventoryDescription: string;
  responseValue: unknown;
  responseBytes: Buffer | null;
  workspaceNetwork: "deny" | "unrestricted";
  failDecisionAudit: boolean;
  transportFailuresRemaining: number;
  credentialValue: string;
}

export function createProviderGatewayFixture(options: {
  workspaceBinding?: ProviderWorkspaceBinding;
  retry?: "none" | "one-idempotent-read";
  maxProviderRequests?: number;
} = {}) {
  const events: string[] = [];
  const auditRecords: ProviderAuditMetadata[] = [];
  const counters = {
    credentialCalls: 0,
    inventoryCalls: 0,
    transportCalls: 0,
    workspaceCalls: 0
  };
  const state: ProviderGatewayFixtureState = {
    implementationFingerprint: "1".repeat(64),
    inventoryToolId: "record.read",
    inventoryDescription: "initial prose",
    responseValue: { id: "123", value: "ok" },
    responseBytes: null,
    workspaceNetwork: "unrestricted",
    failDecisionAudit: false,
    transportFailuresRemaining: 0,
    credentialValue: "fixture-secret-credential"
  };

  const manifest = {
    adapterId: ADAPTER_ID,
    adapterContractVersion: "1",
    implementationDigest: "3".repeat(64),
    inventoryMode: "DYNAMIC" as const,
    networkPolicy: {
      kind: "internet" as const,
      origins: ["https://api.fixture.example"],
      redirect: null
    },
    credentialBroker: {
      kind: "external-helper" as const,
      credentialKind: "bearer" as const,
      argv: ["credential"],
      environment: {}
    },
    operations: [{
      id: "record.read",
      method: "GET" as const,
      origin: "https://api.fixture.example",
      pathTemplate: "/records/{id}",
      allowedQueryKeys: [] as string[],
      fixedHeaders: { accept: "application/json" },
      inputSchema: fixtureInputSchema(),
      encodeRequest(input: unknown) {
        if (!isRecord(input) || typeof input.id !== "string") {
          throw new CapabilityError("PROVIDER_INPUT_INVALID", "fixture operation input is invalid");
        }
        return { pathParameters: { id: input.id } };
      }
    }],
    mappings: [{
      semanticCapabilityId: SEMANTIC_ID,
      adapterId: ADAPTER_ID,
      adapterOperationId: "record.read",
      effect: "REMOTE_READ" as const,
      workspaceBinding: options.workspaceBinding ?? "REQUIRED",
      inputSchema: fixtureInputSchema(),
      outputSchema: fixtureOutputSchema(),
      maxProviderRequests: options.maxProviderRequests ?? 2,
      retry: options.retry ?? "none",
      auditFields: ["id"]
    }]
  };
  const adapters = new ProviderAdapterRegistry([manifest]);
  const store = new MemoryProviderStore(events);

  const audit = {
    async record(metadata: ProviderAuditMetadata): Promise<void> {
      events.push(`audit-${metadata.operation}-${metadata.phase}`);
      if (metadata.phase === "decision" && state.failDecisionAudit) {
        throw new CapabilityError("PROVIDER_AUDIT_UNAVAILABLE", "fixture audit unavailable");
      }
      auditRecords.push(structuredClone(metadata));
    }
  };
  const credentials: ProviderCredentialBroker = {
    async acquire(input) {
      if (input.signal.aborted) throw new CapabilityError("PROVIDER_CANCELLED", "fixture credential cancelled");
      counters.credentialCalls += 1;
      events.push("credential");
      return { kind: "bearer", value: state.credentialValue };
    }
  };
  const inventory: ProviderInventorySource = {
    async fetch(input) {
      if (input.signal.aborted) throw new CapabilityError("PROVIDER_CANCELLED", "fixture inventory cancelled");
      counters.inventoryCalls += 1;
      events.push("inventory");
      return {
        adapterContractVersion: "1",
        providerContractVersion: "fixture-v1",
        description: state.inventoryDescription,
        tools: [{
          id: state.inventoryToolId,
          description: state.inventoryDescription,
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          outputSchema: { type: "object", properties: { id: { type: "string" }, value: { type: "string" } } }
        }]
      } as unknown as ProviderStructuralInventory;
    }
  };
  const resolveImplementationIdentity = async () => ({
    implementationFingerprint: state.implementationFingerprint,
    helperIdentity: { canonicalPath: HELPER_PATH, sha256: HELPER_SHA }
  });

  let providerCounter = 0;
  let operationCounter = 0;
  const operator = new ProviderOperatorService({
    store,
    adapters,
    audit,
    credentials,
    inventory,
    resolveImplementationIdentity,
    generateProviderInstanceId: () => `prv_${(++providerCounter).toString(16).padStart(32, "0")}`,
    generateOperationId: () => `op_fixture_${++operationCounter}`,
    nowIso: () => "2026-08-16T00:00:00.000Z",
    workspaceRoots: () => ["/workspace"]
  });
  const gateway = new ProviderGatewayServiceImpl({
    registry: store,
    adapters,
    audit,
    credentials,
    inventory,
    resolveImplementationIdentity,
    transport: {
      async request(input) {
        counters.transportCalls += 1;
        events.push("transport");
        input.budget.claimRequest();
        if (state.transportFailuresRemaining > 0) {
          state.transportFailuresRemaining -= 1;
          throw new CapabilityError("PROVIDER_UNAVAILABLE", "fixture transient provider failure");
        }
        return {
          statusCode: 200,
          headers: { "content-type": "application/json", authorization: "redacted-fixture-header" },
          body: state.responseBytes ?? Buffer.from(JSON.stringify(state.responseValue), "utf8"),
          finalOrigin: "https://api.fixture.example"
        };
      }
    },
    workspaceAuthority: {
      async resolve(workspaceId) {
        counters.workspaceCalls += 1;
        events.push("workspace-authority");
        return { workspaceId, network: state.workspaceNetwork };
      }
    },
    generateOperationId: () => `op_fixture_${++operationCounter}`,
    workspaceRoots: () => ["/workspace"]
  });

  const addInput: ProviderAddInput = {
    adapterId: ADAPTER_ID,
    operatorName: "Fixture provider",
    credentialBroker: {
      kind: "external-helper",
      helperPath: HELPER_PATH,
      helperSha256: HELPER_SHA
    },
    nonSecretAdapterConfig: { tenant: "fixture" }
  };

  return {
    adapterId: ADAPTER_ID,
    semanticCapabilityId: SEMANTIC_ID,
    helperPath: HELPER_PATH,
    helperSha256: HELPER_SHA,
    addInput,
    manifest,
    adapters,
    store,
    operator,
    gateway,
    state,
    counters,
    events,
    auditRecords
  };
}
