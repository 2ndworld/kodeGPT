import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderRegistryRecord } from "./contracts.js";
import { ProviderRegistryStore } from "./registry.js";

let stateRoot = "";
let store: ProviderRegistryStore;
const fingerprint = "a".repeat(64);

function record(providerInstanceId: string, overrides: Partial<ProviderRegistryRecord> = {}): ProviderRegistryRecord {
  return {
    schemaVersion: 1,
    providerInstanceId,
    operatorName: `Provider ${providerInstanceId.slice(-4)}`,
    adapterId: "test.fixture.read.v1",
    adapterContractVersion: "1",
    enabled: true,
    implementationFingerprint: fingerprint,
    inventoryMode: "DYNAMIC",
    approvedInventoryFingerprint: fingerprint,
    credentialBroker: { kind: "none" },
    nonSecretAdapterConfig: {},
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    ...overrides
  };
}

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), "kodegpt-provider-registry-"));
  store = new ProviderRegistryStore(stateRoot);
});

afterEach(async () => {
  await rm(stateRoot, { recursive: true, force: true });
});

describe("ProviderRegistryStore", () => {
  it("uses the private providers registry path and treats absence as empty", async () => {
    expect(store.path).toBe(join(stateRoot, "providers", "registry.json"));
    await expect(store.list()).resolves.toEqual([]);
  });

  it("persists deterministically with private directory and file modes", async () => {
    const second = record("prv_ffffffffffffffffffffffffffffffff");
    const first = record("prv_00000000000000000000000000000000");
    await store.insert(second);
    await store.insert(first);

    expect((await store.list()).map((entry) => entry.providerInstanceId)).toEqual([
      first.providerInstanceId,
      second.providerInstanceId
    ]);
    const document = JSON.parse(await readFile(store.path, "utf8")) as { entries: ProviderRegistryRecord[] };
    expect(document.entries.map((entry) => entry.providerInstanceId)).toEqual([
      first.providerInstanceId,
      second.providerInstanceId
    ]);
    expect((await stat(dirname(store.path))).mode & 0o777).toBe(0o700);
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  });

  it("supports get replace and remove without leaking mutable store state", async () => {
    const original = record("prv_11111111111111111111111111111111");
    await store.insert(original);
    const loaded = await store.get(original.providerInstanceId);
    expect(loaded).toEqual(original);
    if (loaded === null) throw new Error("missing fixture record");
    loaded.operatorName = "mutated outside store";
    expect((await store.get(original.providerInstanceId))?.operatorName).toBe(original.operatorName);

    const replacement = { ...original, enabled: false, updatedAt: "2026-08-16T01:00:00.000Z" };
    await store.replace(replacement);
    expect(await store.get(original.providerInstanceId)).toEqual(replacement);
    await expect(store.remove(original.providerInstanceId)).resolves.toBe(true);
    await expect(store.remove(original.providerInstanceId)).resolves.toBe(false);
  });

  it("rejects unknown authority-bearing document and record fields", async () => {
    await mkdir(dirname(store.path), { recursive: true });
    await writeFile(store.path, JSON.stringify({
      schemaVersion: 1,
      entries: [{ ...record("prv_22222222222222222222222222222222"), providerInvoke: true }]
    }));
    await expect(store.list()).rejects.toMatchObject({ code: "PROVIDER_STATE_INVALID" });

    await writeFile(store.path, JSON.stringify({ schemaVersion: 1, entries: [], providerEndpoint: "https://example.com" }));
    await expect(store.list()).rejects.toMatchObject({ code: "PROVIDER_STATE_INVALID" });
  });

  it("rejects malformed existing state, unsupported versions, and secret-looking config keys", async () => {
    await mkdir(dirname(store.path), { recursive: true });
    await writeFile(store.path, "not json");
    await expect(store.list()).rejects.toMatchObject({ code: "PROVIDER_STATE_INVALID" });

    await writeFile(store.path, JSON.stringify({ schemaVersion: 2, entries: [] }));
    await expect(store.list()).rejects.toMatchObject({ code: "PROVIDER_STATE_INVALID" });

    await rm(store.path, { force: true });
    const secretLikeKey = ["api", "token"].join("");
    await expect(store.insert(record("prv_33333333333333333333333333333333", {
      nonSecretAdapterConfig: { [secretLikeKey]: "fixture-value" }
    }))).rejects.toMatchObject({ code: "PROVIDER_STATE_INVALID" });
  });

  it("rejects invalid ids, fingerprints, timestamps, duplicates, and missing replacements", async () => {
    await expect(store.insert(record("bad"))).rejects.toMatchObject({ code: "PROVIDER_STATE_INVALID" });
    await expect(store.insert(record("prv_44444444444444444444444444444444", {
      implementationFingerprint: "not-a-digest"
    }))).rejects.toMatchObject({ code: "PROVIDER_STATE_INVALID" });
    await expect(store.insert(record("prv_55555555555555555555555555555555", {
      updatedAt: "not-a-date"
    }))).rejects.toMatchObject({ code: "PROVIDER_STATE_INVALID" });

    const valid = record("prv_66666666666666666666666666666666");
    await store.insert(valid);
    await expect(store.insert(valid)).rejects.toMatchObject({ code: "PROVIDER_STATE_INVALID" });
    await expect(store.replace(record("prv_77777777777777777777777777777777")))
      .rejects.toMatchObject({ code: "PROVIDER_STATE_INVALID" });
  });

  it("repairs overly broad existing modes on the next durable write", async () => {
    const valid = record("prv_88888888888888888888888888888888");
    await store.insert(valid);
    await chmod(dirname(store.path), 0o755);
    await chmod(store.path, 0o644);
    await store.replace({ ...valid, enabled: false, updatedAt: "2026-08-16T02:00:00.000Z" });
    expect((await stat(dirname(store.path))).mode & 0o777).toBe(0o700);
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  });
});
