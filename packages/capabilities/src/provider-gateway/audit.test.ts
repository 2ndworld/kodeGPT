import { describe, expect, it, vi } from "vitest";

import { CapabilityError } from "../errors.js";
import type { ProviderAuditMetadata } from "./contracts.js";
import { ProviderAuditClient } from "./audit.js";

const metadata: ProviderAuditMetadata = {
  operationId: "op_test",
  operation: "execute",
  phase: "decision",
  providerInstanceId: "prv_0123456789abcdef0123456789abcdef",
  adapterId: "test.fixture.read.v1",
  semanticCapabilityId: "test.fixture.record.read"
};

describe("ProviderAuditClient", () => {
  it("records a global provider.audit RPC without workspace capability authority", async () => {
    const request = vi.fn(async (_method: string, _params: unknown) => ({ ok: true }));
    const client = new ProviderAuditClient({ request });

    await expect(client.record(metadata)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("provider.audit", metadata);
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("capabilityId");
  });

  it("rejects unknown or credential-bearing metadata before RPC", async () => {
    const request = vi.fn(async (_method: string, _params: unknown) => ({ ok: true }));
    const client = new ProviderAuditClient({ request });
    const withUnknown = { ...metadata, credential: "fixture" } as ProviderAuditMetadata;
    await expect(client.record(withUnknown)).rejects.toMatchObject({ code: "PROVIDER_INPUT_INVALID" });
    expect(request).not.toHaveBeenCalled();
  });

  it("maps durable audit sink failure to PROVIDER_AUDIT_UNAVAILABLE", async () => {
    const request = vi.fn(async () => {
      throw new Error("AUDIT_UNAVAILABLE");
    });
    const client = new ProviderAuditClient({ request });
    await expect(client.record(metadata)).rejects.toMatchObject({ code: "PROVIDER_AUDIT_UNAVAILABLE" });
  });

  it("fails closed on an invalid runtime acknowledgement", async () => {
    const client = new ProviderAuditClient({ request: async () => ({ ok: true, extra: true }) });
    await expect(client.record(metadata)).rejects.toMatchObject({ code: "PROVIDER_AUDIT_UNAVAILABLE" });
  });

  it("accepts only the stable provider error vocabulary", async () => {
    const request = vi.fn(async (_method: string, _params: unknown) => ({ ok: true }));
    const client = new ProviderAuditClient({ request });
    await expect(client.record({ ...metadata, phase: "failed", errorCode: "PROVIDER_TIMEOUT" })).resolves.toBeUndefined();
    await expect(client.record({ ...metadata, errorCode: "UNSAFE" as "PROVIDER_TIMEOUT" }))
      .rejects.toBeInstanceOf(CapabilityError);
  });
});
