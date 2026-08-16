import { describe, expect, it } from "vitest";

import * as capabilities from "./index.js";

describe("native capability semantic metadata", () => {
  it("has exactly one immutable metadata entry for every existing native capability", () => {
    const registry = (capabilities as Record<string, unknown>).NATIVE_CAPABILITY_SEMANTICS as
      | Record<string, { id: string; purpose: string; semanticAliases: readonly string[] }>
      | undefined;
    const lookup = (capabilities as Record<string, unknown>).getNativeCapabilitySemanticMetadata as
      | ((id: string) => { id: string; purpose: string; semanticAliases: readonly string[] })
      | undefined;

    expect(registry).toBeDefined();
    expect(lookup).toBeTypeOf("function");
    expect(Object.keys(registry ?? {}).sort()).toEqual([...capabilities.NATIVE_CAPABILITY_IDS].sort());
    for (const id of capabilities.NATIVE_CAPABILITY_IDS) {
      const metadata = lookup?.(id);
      expect(metadata?.id).toBe(id);
      expect(metadata?.purpose.length).toBeGreaterThan(0);
      expect(metadata?.semanticAliases.length).toBeGreaterThan(0);
      expect(Object.isFrozen(metadata?.semanticAliases)).toBe(true);
      expect(Object.isFrozen(metadata)).toBe(true);
    }
    expect(Object.isFrozen(registry)).toBe(true);
  });

  it("describes exactly the five Remote-CI capabilities as bounded read-only semantics", () => {
    const registry = capabilities.NATIVE_CAPABILITY_SEMANTICS;
    const ciEntries = Object.values(registry).filter(({ id }) => id.startsWith("ci."));

    expect(ciEntries.map(({ id }) => id)).toEqual([
      "ci.repository",
      "ci.status",
      "ci.runs",
      "ci.run",
      "ci.failure"
    ]);
    for (const metadata of ciEntries) {
      expect(metadata.purpose.toLowerCase()).toContain("bounded");
      expect(metadata.purpose.toLowerCase()).toContain("read-only");
      expect(metadata.semanticAliases.some((alias) => alias.startsWith("ci "))).toBe(true);
    }
  });

  it("contains descriptions only and no authority-bearing runtime state", () => {
    const registry = (capabilities as Record<string, unknown>).NATIVE_CAPABILITY_SEMANTICS;
    expect(registry).toBeDefined();
    const serialized = JSON.stringify(registry ?? {});
    for (const forbidden of [
      "workspaceId",
      "sourceCapabilityId",
      "canonicalRoot",
      "stateRoot",
      "token",
      "credential",
      "operationId",
      "pid"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
