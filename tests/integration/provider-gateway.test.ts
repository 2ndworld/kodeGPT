import {
  PRODUCTION_PROVIDER_MANIFESTS,
  PROVIDER_CREDENTIAL_TIMEOUT_MS,
  PROVIDER_MAX_METADATA_RESPONSE_BYTES,
  PROVIDER_MAX_REQUEST_BODY_BYTES,
  PROVIDER_MAX_REQUESTS,
  PROVIDER_MAX_RESULT_ELEMENTS,
  PROVIDER_MAX_SEMANTIC_RESULT_BYTES,
  PROVIDER_MAX_STRUCTURAL_DEPTH,
  PROVIDER_NETWORK_ATTEMPT_TIMEOUT_MS,
  PROVIDER_OPERATION_TIMEOUT_MS,
  assertProviderInternetAddressAllowed,
  selectProviderInternetAddress
} from "../../packages/capabilities/src/index.js";
import { getProfilePreset } from "../../packages/profiles/src/index.js";
import { describe, expect, it } from "vitest";

import { MCP_SURFACE_VERSION } from "../../packages/mcp-server/src/surface-version.js";
import { listSurfaceTools } from "../../packages/mcp-server/src/server.js";
import { createProviderGatewayFixture } from "../helpers/provider-gateway-fixture.js";

async function admitFixture(fx: ReturnType<typeof createProviderGatewayFixture>) {
  return fx.operator.add(fx.addInput);
}

function executeInput(fx: ReturnType<typeof createProviderGatewayFixture>, providerInstanceId: string, workspaceId?: string) {
  return {
    semanticCapabilityId: fx.semanticCapabilityId,
    providerInstanceId,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    input: { id: "123" }
  };
}

function nestedValue(depth: number): unknown {
  let value: unknown = "leaf";
  for (let index = 0; index < depth; index += 1) value = { nested: value };
  return value;
}

describe("Provider Gateway conformance boundary", () => {
  it("composes admission and semantic execution in the fail-closed audited order", async () => {
    const fx = createProviderGatewayFixture();
    const provider = await admitFixture(fx);
    expect(fx.events).toEqual([
      "audit-add-decision",
      "credential",
      "inventory",
      "registry-insert",
      "audit-add-success"
    ]);

    fx.events.length = 0;
    const result = await fx.gateway.execute(executeInput(fx, provider.providerInstanceId, "ws_test"));
    expect(result).toEqual({
      semanticCapabilityId: fx.semanticCapabilityId,
      providerInstanceId: provider.providerInstanceId,
      value: { id: "123", value: "ok" },
      truncated: false,
      truncationReasons: []
    });
    expect(fx.events).toEqual([
      "workspace-authority",
      "audit-execute-decision",
      "credential",
      "inventory",
      "transport",
      "audit-execute-success"
    ]);

    const auditJson = JSON.stringify(fx.auditRecords);
    for (const forbidden of [
      fx.helperPath,
      fx.state.credentialValue,
      "redacted-fixture-header",
      "authorization",
      '"body"',
      '"environment"'
    ]) {
      expect(auditJson).not.toContain(forbidden);
    }
  });

  it("fails before credentials, inventory, network, or state when decision audit is unavailable", async () => {
    const fx = createProviderGatewayFixture();
    fx.state.failDecisionAudit = true;

    await expect(admitFixture(fx)).rejects.toMatchObject({ code: "PROVIDER_AUDIT_UNAVAILABLE" });
    expect(fx.counters.credentialCalls).toBe(0);
    expect(fx.counters.inventoryCalls).toBe(0);
    expect(fx.counters.transportCalls).toBe(0);
    expect(await fx.store.list()).toEqual([]);
  });

  it("blocks implementation identity drift before credential or network execution", async () => {
    const fx = createProviderGatewayFixture();
    const provider = await admitFixture(fx);
    fx.counters.credentialCalls = 0;
    fx.counters.inventoryCalls = 0;
    fx.counters.transportCalls = 0;
    fx.state.implementationFingerprint = "4".repeat(64);

    await expect(fx.gateway.execute(executeInput(fx, provider.providerInstanceId, "ws_test")))
      .rejects.toMatchObject({ code: "PROVIDER_IDENTITY_CHANGED" });
    expect(fx.counters.credentialCalls).toBe(0);
    expect(fx.counters.inventoryCalls).toBe(0);
    expect(fx.counters.transportCalls).toBe(0);
  });

  it("blocks structural inventory drift until explicit reapproval", async () => {
    const fx = createProviderGatewayFixture();
    const provider = await admitFixture(fx);
    fx.state.inventoryToolId = "record.read.v2";
    fx.counters.transportCalls = 0;

    await expect(fx.gateway.execute(executeInput(fx, provider.providerInstanceId, "ws_test")))
      .rejects.toMatchObject({ code: "PROVIDER_INVENTORY_CHANGED" });
    expect(fx.counters.transportCalls).toBe(0);
    await expect(fx.gateway.execute(executeInput(fx, provider.providerInstanceId, "ws_test")))
      .rejects.toMatchObject({ code: "PROVIDER_INVENTORY_CHANGED" });

    await fx.operator.reapprove(provider.providerInstanceId);
    await expect(fx.gateway.execute(executeInput(fx, provider.providerInstanceId, "ws_test")))
      .resolves.toMatchObject({ value: { id: "123", value: "ok" } });
  });

  it("ignores prose-only inventory changes for the structural fingerprint", async () => {
    const fx = createProviderGatewayFixture();
    const provider = await admitFixture(fx);
    const approved = provider.approvedInventoryFingerprint;
    fx.state.inventoryDescription = "completely different provider prose and instructions";

    await expect(fx.gateway.execute(executeInput(fx, provider.providerInstanceId, "ws_test")))
      .resolves.toMatchObject({ value: { id: "123", value: "ok" } });
    const reapproved = await fx.operator.reapprove(provider.providerInstanceId);
    expect(reapproved.approvedInventoryFingerprint).toBe(approved);
  });

  it.each(["observe", "develop"] as const)("denies %s workspace-bound provider network", async (profile) => {
    const fx = createProviderGatewayFixture({ workspaceBinding: "REQUIRED" });
    const provider = await admitFixture(fx);
    const policy = getProfilePreset(profile);
    fx.state.workspaceNetwork = policy.network === "unrestricted" ? "unrestricted" : "deny";
    fx.counters.credentialCalls = 0;
    fx.counters.transportCalls = 0;

    await expect(fx.gateway.execute(executeInput(fx, provider.providerInstanceId, "ws_test")))
      .rejects.toMatchObject({ code: "PROVIDER_NETWORK_DENIED" });
    expect(fx.counters.credentialCalls).toBe(0);
    expect(fx.counters.transportCalls).toBe(0);
  });

  it("permits trusted workspace-bound network and NONE never consults workspace policy", async () => {
    const trusted = createProviderGatewayFixture({ workspaceBinding: "REQUIRED" });
    const trustedProvider = await admitFixture(trusted);
    const trustedPolicy = getProfilePreset("trusted");
    trusted.state.workspaceNetwork = trustedPolicy.network === "unrestricted" ? "unrestricted" : "deny";
    await expect(trusted.gateway.execute(executeInput(trusted, trustedProvider.providerInstanceId, "ws_test")))
      .resolves.toMatchObject({ value: { id: "123", value: "ok" } });

    const none = createProviderGatewayFixture({ workspaceBinding: "NONE" });
    const noneProvider = await admitFixture(none);
    none.state.workspaceNetwork = "deny";
    none.counters.workspaceCalls = 0;
    await expect(none.gateway.execute(executeInput(none, noneProvider.providerInstanceId)))
      .resolves.toMatchObject({ value: { id: "123", value: "ok" } });
    expect(none.counters.workspaceCalls).toBe(0);
  });

  it.each([
    [Buffer.from([0xff]), "PROVIDER_RESPONSE_INVALID"],
    [Buffer.from('{"id":"123","value":"bad\\u0000value"}', "utf8"), "PROVIDER_RESPONSE_INVALID"],
    [Buffer.from(JSON.stringify({ id: "123", value: "ok", extra: true }), "utf8"), "PROVIDER_RESPONSE_INVALID"],
    [Buffer.from(JSON.stringify({ id: "123", value: "ok", extra: nestedValue(20) }), "utf8"), "PROVIDER_RESPONSE_INVALID"],
    [Buffer.from(JSON.stringify({ id: "123", value: "ok", extra: Array.from({ length: 1_001 }, () => 1) }), "utf8"), "PROVIDER_RESPONSE_INVALID"],
    [Buffer.from(JSON.stringify({ id: "123", value: "x".repeat(600 * 1024) }), "utf8"), "PROVIDER_OUTPUT_LIMIT_EXCEEDED"]
  ])("fails closed on malformed or oversized semantic output", async (body, code) => {
    const fx = createProviderGatewayFixture();
    const provider = await admitFixture(fx);
    fx.state.responseBytes = body;
    await expect(fx.gateway.execute(executeInput(fx, provider.providerInstanceId, "ws_test")))
      .rejects.toMatchObject({ code });
  });

  it("enforces one-idempotent-read retry and the mapping request ceiling", async () => {
    const retry = createProviderGatewayFixture({ retry: "one-idempotent-read", maxProviderRequests: 2 });
    const provider = await admitFixture(retry);
    retry.state.transportFailuresRemaining = 1;
    retry.counters.transportCalls = 0;
    await expect(retry.gateway.execute(executeInput(retry, provider.providerInstanceId, "ws_test")))
      .resolves.toMatchObject({ value: { id: "123", value: "ok" } });
    expect(retry.counters.transportCalls).toBe(2);

    const noRetry = createProviderGatewayFixture({ retry: "none", maxProviderRequests: 1 });
    const noRetryProvider = await admitFixture(noRetry);
    noRetry.state.transportFailuresRemaining = 1;
    await expect(noRetry.gateway.execute(executeInput(noRetry, noRetryProvider.providerInstanceId, "ws_test")))
      .rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(noRetry.counters.transportCalls).toBe(1);
  });

  it("cancels before provider effects and leaves no background activity", async () => {
    const fx = createProviderGatewayFixture();
    const provider = await admitFixture(fx);
    fx.counters.credentialCalls = 0;
    fx.counters.inventoryCalls = 0;
    fx.counters.transportCalls = 0;
    const controller = new AbortController();
    controller.abort();

    await expect(fx.gateway.execute(
      executeInput(fx, provider.providerInstanceId, "ws_test"),
      controller.signal
    )).rejects.toMatchObject({ code: "PROVIDER_CANCELLED" });
    const snapshot = { ...fx.counters };
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fx.counters).toEqual(snapshot);
    expect(fx.counters.credentialCalls).toBe(0);
    expect(fx.counters.transportCalls).toBe(0);
  });

  it("keeps Provider Gateway authority fixed while the aggregate MCP surface adds bounded preview", () => {
    for (const address of [
      { address: "127.0.0.1", family: 4 as const },
      { address: "10.0.0.5", family: 4 as const },
      { address: "169.254.169.254", family: 4 as const },
      { address: "::1", family: 6 as const },
      { address: "::ffff:127.0.0.1", family: 6 as const }
    ]) {
      expect(() => assertProviderInternetAddressAllowed(address)).toThrow();
    }
    expect(() => selectProviderInternetAddress([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 }
    ])).toThrow();
    expect(PROVIDER_CREDENTIAL_TIMEOUT_MS).toBe(5_000);
    expect(PROVIDER_NETWORK_ATTEMPT_TIMEOUT_MS).toBe(10_000);
    expect(PROVIDER_OPERATION_TIMEOUT_MS).toBe(30_000);
    expect(PROVIDER_MAX_REQUESTS).toBe(8);
    expect(PROVIDER_MAX_REQUEST_BODY_BYTES).toBe(256 * 1024);
    expect(PROVIDER_MAX_METADATA_RESPONSE_BYTES).toBe(2 * 1024 * 1024);
    expect(PROVIDER_MAX_SEMANTIC_RESULT_BYTES).toBe(512 * 1024);
    expect(PROVIDER_MAX_STRUCTURAL_DEPTH).toBe(16);
    expect(PROVIDER_MAX_RESULT_ELEMENTS).toBe(1_000);
    expect(() => createProviderGatewayFixture({ maxProviderRequests: PROVIDER_MAX_REQUESTS + 1 })).toThrow();
    expect(PRODUCTION_PROVIDER_MANIFESTS.map(({ adapterId }) => adapterId)).toEqual([
      "github.read.v1",
      "github.write.v1"
    ]);
    expect(PRODUCTION_PROVIDER_MANIFESTS[0]?.mappings.map(({ semanticCapabilityId }) => semanticCapabilityId)).toEqual([
      "github.repository.inspect",
      "github.pr.inspect",
      "github.pr.list",
      "github.issue.inspect",
      "github.issue.list"
    ]);
    expect(PRODUCTION_PROVIDER_MANIFESTS[1]?.mappings.map(({ semanticCapabilityId }) => semanticCapabilityId)).toEqual([
      "github.pr.create",
      "github.pr.merge"
    ]);
    const names = listSurfaceTools().map(({ name }) => name);
    expect(MCP_SURFACE_VERSION).toBe("0.22");
    expect(names).toHaveLength(76);
    expect(names).toContain("system.discover");
    expect(names.filter((name) => name.startsWith("github."))).toEqual([
      "github.issue.inspect",
      "github.issue.list",
      "github.pr.create",
      "github.pr.inspect",
      "github.pr.list",
      "github.pr.merge",
      "github.repository.inspect"
    ]);
    expect(names.some((name) => name.startsWith("deploy."))).toBe(false);
    expect(names).not.toContain("file.search");
    expect(names.some((name) => name.startsWith("provider."))).toBe(false);
    expect(names.some((name) => /github\..*(update|delete|comment|label)/.test(name))).toBe(false);
  });
});
