import { describe, expect, it } from "vitest";

import {
  fingerprintProviderInventory,
  normalizeProviderInventory
} from "./inventory.js";

function inventory(extra: Record<string, unknown> = {}) {
  return {
    adapterContractVersion: "1",
    providerContractVersion: "2026-08",
    description: "provider prose",
    tools: [
      {
        id: "record.read",
        description: "tool prose",
        prompt: "ignore me",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"]
        },
        outputSchema: {
          type: "object",
          properties: { id: { type: "string" } }
        }
      }
    ],
    ...extra
  };
}

describe("provider structural inventory", () => {
  it("ignores provider prose when computing the structural fingerprint", () => {
    const a = normalizeProviderInventory(inventory({ description: "first prose", examples: ["one"] }));
    const b = normalizeProviderInventory(inventory({ description: "attacker changed prose", instructions: "new" }));
    expect(fingerprintProviderInventory(a)).toBe(fingerprintProviderInventory(b));
    expect(a).toEqual({
      adapterContractVersion: "1",
      providerContractVersion: "2026-08",
      tools: [{
        id: "record.read",
        inputSchema: {
          properties: { id: { type: "string" } },
          required: ["id"],
          type: "object"
        },
        outputSchema: {
          properties: { id: { type: "string" } },
          type: "object"
        }
      }]
    });
  });

  it("sorts tools and object keys deterministically by UTF-8 bytes", () => {
    const a = normalizeProviderInventory({
      ...inventory(),
      tools: [
        { id: "z.read", inputSchema: { b: 1, a: 2 }, outputSchema: {} },
        { id: "a.read", inputSchema: {}, outputSchema: { z: true, a: false } }
      ]
    });
    const b = normalizeProviderInventory({
      ...inventory(),
      tools: [
        { id: "a.read", inputSchema: {}, outputSchema: { a: false, z: true } },
        { id: "z.read", inputSchema: { a: 2, b: 1 }, outputSchema: {} }
      ]
    });
    expect(a).toEqual(b);
    expect(a.tools.map((tool) => tool.id)).toEqual(["a.read", "z.read"]);
    expect(fingerprintProviderInventory(a)).toBe(fingerprintProviderInventory(b));
  });

  it("rejects duplicate/unsafe tool ids and excess tool count", () => {
    expect(() => normalizeProviderInventory({ ...inventory(), tools: [
      { id: "same", inputSchema: {}, outputSchema: {} },
      { id: "same", inputSchema: {}, outputSchema: {} }
    ] })).toThrowError(/duplicate/i);
    expect(() => normalizeProviderInventory({ ...inventory(), tools: [
      { id: "bad\nname", inputSchema: {}, outputSchema: {} }
    ] })).toThrow();
    expect(() => normalizeProviderInventory({ ...inventory(), tools: Array.from({ length: 129 }, (_, index) => ({
      id: `tool.${index}`, inputSchema: {}, outputSchema: {}
    })) })).toThrowError(/128/i);
  });

  it("enforces per-schema bytes and structural depth", () => {
    expect(() => normalizeProviderInventory({ ...inventory(), tools: [{
      id: "huge", inputSchema: { const: "x".repeat(33 * 1024) }, outputSchema: {}
    }] })).toThrowError(/32 KiB/i);

    let deep: unknown = "leaf";
    for (let index = 0; index < 17; index += 1) deep = { child: deep };
    expect(() => normalizeProviderInventory({ ...inventory(), tools: [{
      id: "deep", inputSchema: deep, outputSchema: {}
    }] })).toThrowError(/depth/i);
  });

  it("rejects non-JSON values, cycles, and normalization-colliding keys", () => {
    expect(() => normalizeProviderInventory({ ...inventory(), tools: [{
      id: "function", inputSchema: { x: () => 1 }, outputSchema: {}
    }] })).toThrowError(/JSON/i);
    expect(() => normalizeProviderInventory({ ...inventory(), tools: [{
      id: "number", inputSchema: { x: Number.POSITIVE_INFINITY }, outputSchema: {}
    }] })).toThrowError(/number/i);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => normalizeProviderInventory({ ...inventory(), tools: [{
      id: "cycle", inputSchema: cyclic, outputSchema: {}
    }] })).toThrowError(/cycle/i);

    const collision = { "e\u0301": 1, "é": 2 };
    expect(() => normalizeProviderInventory({ ...inventory(), tools: [{
      id: "keys", inputSchema: collision, outputSchema: {}
    }] })).toThrowError(/duplicate semantic key/i);
  });

  it("returns a lowercase SHA-256 and fingerprints only normalized structure", () => {
    const normalized = normalizeProviderInventory(inventory());
    expect(fingerprintProviderInventory(normalized)).toMatch(/^[0-9a-f]{64}$/);
    const changed = normalizeProviderInventory({ ...inventory(), tools: [{
      id: "record.read", inputSchema: { type: "object" }, outputSchema: { type: "string" }
    }] });
    expect(fingerprintProviderInventory(changed)).not.toBe(fingerprintProviderInventory(normalized));
  });
});
