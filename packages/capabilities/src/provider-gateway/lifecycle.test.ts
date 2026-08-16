import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ProviderSemanticMappingDefinition } from "./contracts.js";
import { ProviderOperationBudget } from "./lifecycle.js";

function mapping(overrides: Partial<ProviderSemanticMappingDefinition> = {}): ProviderSemanticMappingDefinition {
  return {
    semanticCapabilityId: "test.fixture.record.read",
    adapterId: "test.fixture.read.v1",
    adapterOperationId: "record.read",
    effect: "REMOTE_READ",
    workspaceBinding: "NONE",
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    maxProviderRequests: 2,
    retry: "none",
    auditFields: [],
    ...overrides
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ProviderOperationBudget", () => {
  it("enforces the hard request ceiling and a stricter mapping request ceiling", () => {
    const hard = new ProviderOperationBudget({});
    for (let index = 0; index < 8; index += 1) hard.claimRequest();
    expect(() => hard.claimRequest()).toThrowError(/request budget/i);
    hard.close();

    const strict = new ProviderOperationBudget({ maxRequests: 2 });
    strict.claimRequest();
    strict.claimRequest();
    expect(() => strict.claimRequest()).toThrowError(/request budget/i);
    strict.close();
  });

  it("permits one retry only for the compiled idempotent-read policy while budget remains", () => {
    let now = 1_000;
    const budget = new ProviderOperationBudget({ now: () => now, maxRequests: 2 });
    expect(budget.canRetry(mapping({ retry: "none" }), 0)).toBe(false);
    expect(budget.canRetry(mapping({ retry: "one-idempotent-read" }), 0)).toBe(true);
    expect(budget.canRetry(mapping({ retry: "one-idempotent-read" }), 1)).toBe(false);
    budget.claimRequest();
    budget.claimRequest();
    expect(budget.canRetry(mapping({ retry: "one-idempotent-read" }), 0)).toBe(false);
    now += 30_000;
    expect(budget.canRetry(mapping({ retry: "one-idempotent-read" }), 0)).toBe(false);
    budget.close();
  });

  it("maps caller abort to PROVIDER_CANCELLED and closes child attempts", async () => {
    const caller = new AbortController();
    const budget = new ProviderOperationBudget({ signal: caller.signal });
    let childAborted = false;
    const pending = budget.withAttemptTimeout(async (signal) => new Promise<void>((_resolve) => {
      signal.addEventListener("abort", () => { childAborted = true; }, { once: true });
    }));
    caller.abort();
    await expect(pending).rejects.toMatchObject({ code: "PROVIDER_CANCELLED" });
    expect(childAborted).toBe(true);
    budget.close();
  });

  it("maps the 10 second attempt deadline to PROVIDER_TIMEOUT and cleans the attempt", async () => {
    vi.useFakeTimers();
    const budget = new ProviderOperationBudget({});
    let childAborted = false;
    const pending = budget.withAttemptTimeout(async (signal) => new Promise<void>((_resolve) => {
      signal.addEventListener("abort", () => { childAborted = true; }, { once: true });
    }));
    const rejection = expect(pending).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(childAborted).toBe(true);
    budget.close();
  });

  it("maps the 30 second total deadline to PROVIDER_TIMEOUT", async () => {
    vi.useFakeTimers();
    const budget = new ProviderOperationBudget({});
    const pending = budget.withAttemptTimeout(async () => new Promise<void>(() => undefined));
    const rejection = expect(pending).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    budget.close();
  });

  it("close aborts remaining work and prevents new requests", async () => {
    const budget = new ProviderOperationBudget({});
    const pending = budget.withAttemptTimeout(async () => new Promise<void>(() => undefined));
    budget.close();
    await expect(pending).rejects.toMatchObject({ code: "PROVIDER_CANCELLED" });
    expect(() => budget.claimRequest()).toThrowError(expect.objectContaining({ code: "PROVIDER_CANCELLED" }));
  });
});
