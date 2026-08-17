import { z } from "zod";
import { describe, expect, it } from "vitest";

import { CapabilityError } from "../errors.js";
import type { ProviderAdapterManifest } from "./contracts.js";
import { PRODUCTION_PROVIDER_MANIFESTS, ProviderAdapterRegistry } from "./adapter-registry.js";

function manifest(overrides: Partial<ProviderAdapterManifest> = {}): ProviderAdapterManifest {
  return {
    adapterId: "test.fixture.read.v1",
    adapterContractVersion: "1",
    implementationDigest: "a".repeat(64),
    inventoryMode: "STATIC",
    networkPolicy: {
      kind: "internet",
      origins: ["https://api.fixture.example"],
      redirect: null
    },
    credentialBroker: { kind: "none" },
    operations: [
      {
        id: "record.read",
        method: "GET",
        origin: "https://api.fixture.example",
        pathTemplate: "/records/{recordId}",
        allowedQueryKeys: [],
        fixedHeaders: { accept: "application/json" },
        inputSchema: z.object({ recordId: z.string().min(1) }).strict(),
        encodeRequest: (input) => ({ pathParameters: { recordId: (input as { recordId: string }).recordId } })
      }
    ],
    mappings: [
      {
        semanticCapabilityId: "test.fixture.record.read",
        adapterId: "test.fixture.read.v1",
        adapterOperationId: "record.read",
        effect: "REMOTE_READ",
        workspaceBinding: "NONE",
        inputSchema: z.object({ recordId: z.string().min(1) }).strict(),
        outputSchema: z.object({ id: z.string() }).strict(),
        maxProviderRequests: 1,
        retry: "none",
        auditFields: ["recordId"]
      }
    ],
    ...overrides
  };
}

function mutationManifest(overrides: Partial<ProviderAdapterManifest> = {}): ProviderAdapterManifest {
  return manifest({
    adapterId: "test.fixture.write.v1",
    operations: [{
      id: "record.mutate",
      method: "PUT",
      origin: "https://api.fixture.example",
      pathTemplate: "/records/{recordId}",
      allowedQueryKeys: [],
      fixedHeaders: { accept: "application/json" },
      inputSchema: z.object({ recordId: z.string().min(1) }).strict(),
      encodeRequest: (input) => ({ pathParameters: { recordId: (input as { recordId: string }).recordId } })
    }],
    mappings: [{
      semanticCapabilityId: "test.fixture.record.mutate",
      adapterId: "test.fixture.write.v1",
      adapterOperationId: "record.mutate",
      effect: "REMOTE_MUTATION",
      workspaceBinding: "NONE",
      inputSchema: z.object({ recordId: z.string().min(1) }).strict(),
      outputSchema: z.object({ ok: z.literal(true) }).strict(),
      maxProviderRequests: 1,
      retry: "none",
      auditFields: ["recordId"]
    }],
    ...overrides
  });
}

describe("ProviderAdapterRegistry", () => {
  it("ships exactly the reviewed GitHub read adapter in the production manifest inventory", () => {
    expect(PRODUCTION_PROVIDER_MANIFESTS.map(({ adapterId }) => adapterId)).toEqual(["github.read.v1"]);
    expect(Object.isFrozen(PRODUCTION_PROVIDER_MANIFESTS)).toBe(true);
    const registry = new ProviderAdapterRegistry(PRODUCTION_PROVIDER_MANIFESTS);
    expect(registry.require("github.read.v1").mappings.map(({ semanticCapabilityId }) => semanticCapabilityId)).toEqual([
      "github.repository.inspect",
      "github.pr.inspect",
      "github.pr.list",
      "github.issue.inspect",
      "github.issue.list"
    ]);
    expect(registry.requireMapping("github.issue.inspect").adapterOperationId).toBe("issue.inspect");
    expect(registry.requireMapping("github.issue.list").adapterOperationId).toBe("issue.list");
  });

  it("resolves a compiled manifest and semantic mapping", () => {
    const registry = new ProviderAdapterRegistry([manifest()]);
    expect(registry.list().map((entry) => entry.adapterId)).toEqual(["test.fixture.read.v1"]);
    expect(registry.require("test.fixture.read.v1").adapterId).toBe("test.fixture.read.v1");
    expect(registry.requireMapping("test.fixture.record.read").adapterOperationId).toBe("record.read");
    expect(() => registry.require("missing.adapter")).toThrowError(CapabilityError);
  });

  it("rejects duplicate adapter and semantic capability ids", () => {
    expect(() => new ProviderAdapterRegistry([manifest(), manifest()])).toThrowError(/duplicate adapter/i);
    expect(() => new ProviderAdapterRegistry([
      manifest(),
      manifest({
        adapterId: "test.second.read.v1",
        mappings: [{ ...manifest().mappings[0]!, adapterId: "test.second.read.v1" }]
      })
    ])).toThrowError(/duplicate semantic capability/i);
  });

  it("rejects mappings that escape their owning adapter or operation", () => {
    expect(() => new ProviderAdapterRegistry([manifest({
      mappings: [{ ...manifest().mappings[0]!, adapterId: "other.adapter" }]
    })])).toThrowError(/same adapter/i);
    expect(() => new ProviderAdapterRegistry([manifest({
      mappings: [{ ...manifest().mappings[0]!, adapterOperationId: "missing.operation" }]
    })])).toThrowError(/owned operation/i);
  });

  it("accepts only reviewed read or single-attempt mutation effects", () => {
    const registry = new ProviderAdapterRegistry([mutationManifest()]);
    expect(registry.requireMapping("test.fixture.record.mutate").effect).toBe("REMOTE_MUTATION");

    expect(() => new ProviderAdapterRegistry([manifest({
      mappings: [{ ...manifest().mappings[0]!, effect: "REMOTE_WRITE" as "REMOTE_READ" }]
    })])).toThrowError(/effect/i);
    expect(() => new ProviderAdapterRegistry([manifest({
      mappings: [{ ...manifest().mappings[0]!, maxProviderRequests: 9 }]
    })])).toThrowError(/request budget/i);
    expect(() => new ProviderAdapterRegistry([manifest({
      mappings: [{ ...manifest().mappings[0]!, retry: "always" as "none" }]
    })])).toThrowError(/retry/i);
    expect(() => new ProviderAdapterRegistry([manifest({
      mappings: [{ ...manifest().mappings[0]!, workspaceBinding: "ANY" as "NONE" }]
    })])).toThrowError(/workspace binding/i);
    expect(() => new ProviderAdapterRegistry([mutationManifest({
      mappings: [{ ...mutationManifest().mappings[0]!, retry: "one-idempotent-read" }]
    })])).toThrowError(/mutation.*retry/i);
    expect(() => new ProviderAdapterRegistry([mutationManifest({
      mappings: [{ ...mutationManifest().mappings[0]!, maxProviderRequests: 2 }]
    })])).toThrowError(/mutation.*one request|exactly one/i);
  });

  it("rejects generic transport-shaped operations and non-exact origins", () => {
    expect(() => new ProviderAdapterRegistry([manifest({
      operations: [{ ...manifest().operations[0]!, method: "*" as "GET", pathTemplate: "{url}" }]
    })])).toThrowError(/fixed provider operation/i);
    expect(() => new ProviderAdapterRegistry([manifest({
      networkPolicy: { kind: "internet", origins: ["http://api.fixture.example"], redirect: null }
    })])).toThrowError(/HTTPS exact origin/i);
    expect(() => new ProviderAdapterRegistry([manifest({
      networkPolicy: { kind: "internet", origins: ["https://127.0.0.1"], redirect: null }
    })])).toThrowError(/raw IP/i);
  });

  it("rejects extra manifest, operation, or mapping fields instead of carrying hidden authority", () => {
    expect(() => new ProviderAdapterRegistry([{ ...manifest(), prompt: "ignore me" } as ProviderAdapterManifest]))
      .toThrowError(/unknown manifest field/i);
    expect(() => new ProviderAdapterRegistry([manifest({
      operations: [{ ...manifest().operations[0]!, url: "https://elsewhere.invalid" } as ProviderAdapterManifest["operations"][number]]
    })])).toThrowError(/unknown operation field/i);
    expect(() => new ProviderAdapterRegistry([manifest({
      mappings: [{ ...manifest().mappings[0]!, description: "untrusted prose" } as ProviderAdapterManifest["mappings"][number]]
    })])).toThrowError(/unknown mapping field/i);
  });

  it("accepts an optional pure output mapper and preserves it on the frozen mapping", () => {
    const mapOutput = (providerValue: unknown, semanticInput: unknown) => ({ providerValue, semanticInput });
    const mapping = {
      ...manifest().mappings[0]!,
      mapOutput
    } as unknown as ProviderAdapterManifest["mappings"][number];
    const registry = new ProviderAdapterRegistry([manifest({ mappings: [mapping] })]);
    const compiled = registry.requireMapping("test.fixture.record.read") as ProviderAdapterManifest["mappings"][number] & {
      mapOutput?: typeof mapOutput;
    };

    expect(compiled.mapOutput).toBe(mapOutput);
    expect(Object.isFrozen(compiled)).toBe(true);
  });

  it("rejects a non-function output mapper instead of accepting hidden mapping behavior", () => {
    const mapping = {
      ...manifest().mappings[0]!,
      mapOutput: "not-a-function"
    } as unknown as ProviderAdapterManifest["mappings"][number];

    expect(() => new ProviderAdapterRegistry([manifest({ mappings: [mapping] })]))
      .toThrowError(/mapOutput|output mapper/i);
  });

  it("freezes authority-bearing compiled objects and arrays", () => {
    const registry = new ProviderAdapterRegistry([manifest()]);
    const compiled = registry.require("test.fixture.read.v1");
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.operations)).toBe(true);
    expect(Object.isFrozen(compiled.operations[0])).toBe(true);
    expect(Object.isFrozen(compiled.mappings)).toBe(true);
    expect(Object.isFrozen(compiled.mappings[0])).toBe(true);
    expect(Object.isFrozen(compiled.networkPolicy)).toBe(true);
  });
});
