import { describe, expect, it } from "vitest";

import type { ProviderRegistryRecord } from "@kodegpt/capabilities";

import { runProviderCommand, type ProviderCommandDependencies } from "./provider.js";

const providerId = "prv_0123456789abcdef0123456789abcdef";

function providerRecord(): ProviderRegistryRecord {
  return {
    schemaVersion: 1,
    providerInstanceId: providerId,
    operatorName: "Fixture provider",
    adapterId: "test.fixture.read.v1",
    adapterContractVersion: "1",
    enabled: true,
    implementationFingerprint: "a".repeat(64),
    inventoryMode: "STATIC",
    approvedInventoryFingerprint: null,
    credentialBroker: {
      kind: "external-helper",
      helperPath: "/opt/kodegpt/helper",
      helperSha256: "b".repeat(64)
    },
    nonSecretAdapterConfig: {},
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z"
  };
}

function fixture() {
  const calls: Array<{ method: string; input?: unknown }> = [];
  const record = providerRecord();
  const service = {
    async add(input: unknown) { calls.push({ method: "add", input }); return record; },
    async remove(id: string) { calls.push({ method: "remove", input: id }); return true; },
    async enable(id: string) { calls.push({ method: "enable", input: id }); return { ...record, enabled: true }; },
    async disable(id: string) { calls.push({ method: "disable", input: id }); return { ...record, enabled: false }; },
    async reapprove(id: string) { calls.push({ method: "reapprove", input: id }); return record; },
    async list() { calls.push({ method: "list" }); return [record]; },
    async inspect(id: string) { calls.push({ method: "inspect", input: id }); return record; }
  };
  const deps: ProviderCommandDependencies = { service };
  return { calls, deps };
}

describe("runProviderCommand", () => {
  it("does not accept an invoke subcommand", async () => {
    const fx = fixture();
    await expect(runProviderCommand(["invoke", providerId], fx.deps)).rejects.toThrow(/unknown provider command/i);
    expect(fx.calls).toEqual([]);
  });

  it("parses bounded add authority without transport fields", async () => {
    const fx = fixture();
    const output = await runProviderCommand([
      "add",
      "--adapter", "test.fixture.read.v1",
      "--name", "Fixture provider",
      "--config", "{}",
      "--helper-path", "/opt/kodegpt/helper",
      "--helper-sha256", "b".repeat(64)
    ], fx.deps);
    expect(output).toContain(providerId);
    expect(fx.calls).toEqual([{ method: "add", input: {
      adapterId: "test.fixture.read.v1",
      operatorName: "Fixture provider",
      credentialBroker: {
        kind: "external-helper",
        helperPath: "/opt/kodegpt/helper",
        helperSha256: "b".repeat(64)
      },
      nonSecretAdapterConfig: {}
    } }]);
  });

  it("rejects caller transport authority flags before service calls", async () => {
    const fx = fixture();
    await expect(runProviderCommand([
      "add", "--adapter", "test.fixture.read.v1", "--name", "Fixture", "--endpoint", "https://attacker.invalid"
    ], fx.deps)).rejects.toThrow(/unsupported provider add option/i);
    expect(fx.calls).toEqual([]);
  });

  it("validates opaque provider IDs before mutation calls", async () => {
    const fx = fixture();
    await expect(runProviderCommand(["disable", "not-a-provider-id"], fx.deps)).rejects.toThrow(/provider instance id/i);
    expect(fx.calls).toEqual([]);
  });

  it("redacts helper paths from default list and inspect output", async () => {
    const fx = fixture();
    const list = await runProviderCommand(["list"], fx.deps);
    const inspect = await runProviderCommand(["inspect", providerId], fx.deps);
    expect(list).toContain(providerId);
    expect(inspect).toContain("external-helper");
    expect(list).not.toContain("/opt/kodegpt/helper");
    expect(inspect).not.toContain("/opt/kodegpt/helper");
  });

  it("allows JSON inspection of the nonsecret registry descriptor", async () => {
    const fx = fixture();
    const output = await runProviderCommand(["inspect", providerId, "--json"], fx.deps);
    expect(JSON.parse(output)).toMatchObject({
      providerInstanceId: providerId,
      credentialBroker: { kind: "external-helper", helperPath: "/opt/kodegpt/helper" }
    });
  });
});
