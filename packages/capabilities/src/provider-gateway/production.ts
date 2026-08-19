import { CapabilityError } from "../errors.js";
import { ProviderAdapterRegistry } from "./adapter-registry.js";
import type {
  ProviderAdapterManifest,
  ProviderAuditMetadata,
  ProviderGatewayService
} from "./contracts.js";
import {
  DefaultProviderCredentialBroker,
  type ProviderCredential
} from "./credential-broker.js";
import { DefaultProviderNetworkTransport } from "./network-transport.js";
import {
  ProviderOperatorService,
  type ProviderInventorySource
} from "./operator-service.js";
import { ProviderRegistryStore } from "./registry.js";
import {
  ProviderGatewayServiceImpl,
  type ProviderWorkspaceAuthorityResolver
} from "./service.js";

export interface ProviderAuditSink {
  record(metadata: ProviderAuditMetadata): Promise<void>;
}

export interface ProviderGatewayRuntime {
  operator: ProviderOperatorService;
  gateway: ProviderGatewayService;
  acquireCredentialForEnabledAdapter(adapterId: string): Promise<ProviderCredential | null>;
  close(): Promise<void>;
}

export function createProviderGatewayRuntime(input: {
  stateRoot: string;
  manifests: readonly ProviderAdapterManifest[];
  audit: ProviderAuditSink;
  workspaceAuthority: ProviderWorkspaceAuthorityResolver;
  workspaceRoots: () => readonly string[];
}): ProviderGatewayRuntime {
  const registry = new ProviderRegistryStore(input.stateRoot);
  const adapters = new ProviderAdapterRegistry(input.manifests);
  const credentials = new DefaultProviderCredentialBroker({
    workspaceRoots: input.workspaceRoots
  });
  const transport = new DefaultProviderNetworkTransport();
  const inventory: ProviderInventorySource = {
    async fetch() {
      throw new CapabilityError(
        "PROVIDER_TOOL_UNAVAILABLE",
        "No production provider dynamic inventory source is registered"
      );
    }
  };

  const operator = new ProviderOperatorService({
    store: registry,
    adapters,
    audit: input.audit,
    credentials,
    inventory,
    workspaceRoots: input.workspaceRoots
  });
  const implementation = new ProviderGatewayServiceImpl({
    registry,
    adapters,
    audit: input.audit,
    credentials,
    transport,
    workspaceAuthority: input.workspaceAuthority,
    inventory,
    workspaceRoots: input.workspaceRoots
  });

  const lifetime = new AbortController();
  let closed = false;
  const gateway: ProviderGatewayService = {
    execute(request) {
      return implementation.execute(request, lifetime.signal);
    }
  };

  return {
    operator,
    gateway,
    async acquireCredentialForEnabledAdapter(adapterId: string): Promise<ProviderCredential | null> {
      const matching = (await operator.list()).filter(
        (record) => record.adapterId === adapterId && record.enabled
      );
      if (matching.length === 0) return null;
      if (matching.length !== 1) {
        throw new CapabilityError(
          "PROVIDER_STATE_INVALID",
          "Multiple enabled provider instances match the requested adapter"
        );
      }
      return credentials.acquire({
        provider: matching[0]!,
        manifest: adapters.require(adapterId),
        signal: lifetime.signal
      });
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      lifetime.abort();
    }
  };
}
