import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SystemdUserManager, UserServiceState } from "./systemd.js";
import {
  ServiceRuntimeStatusStore,
  waitForServiceReady,
  type ServiceRuntimeStatusV1
} from "./runtime-status.js";

const roots: string[] = [];

async function storeFixture(): Promise<{ root: string; store: ServiceRuntimeStatusStore }> {
  const root = await mkdtemp(join(tmpdir(), "kodegpt-service-runtime-status-"));
  roots.push(root);
  return { root, store: new ServiceRuntimeStatusStore(root) };
}

function ready(overrides: Partial<ServiceRuntimeStatusV1> = {}): ServiceRuntimeStatusV1 {
  return {
    schemaVersion: 1,
    releaseId: `rel_${"a".repeat(32)}`,
    pid: 4242,
    ready: true,
    localPort: 43_121,
    runtimeVersion: "0.1",
    protocolVersion: "2026-07-28",
    surfaceVersion: "0.4",
    reservedName: "public:kodegpt-dev",
    publicUrl: "https://kodegpt.example.invalid/mcp",
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("service runtime readiness state", () => {
  it("writes and reads only schema-1 sanitized readiness with mode 0600", async () => {
    const { store } = await storeFixture();
    const value = ready();

    await store.write(value);

    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    await expect(store.read()).resolves.toEqual(value);
  });

  it("reads an active surface 0.3 readiness file during a staged upgrade without rewriting its identity", async () => {
    const { store } = await storeFixture();
    const legacy = { ...ready(), surfaceVersion: "0.3" as const };
    await writeFile(store.path, JSON.stringify(legacy), "utf8");

    await expect(store.read()).resolves.toEqual(legacy);
  });

  it("reads the current surface 0.16 readiness file without dropping prior-version compatibility", async () => {
    const { store } = await storeFixture();
    const current = { ...ready(), surfaceVersion: "0.16" as const };
    await writeFile(store.path, JSON.stringify(current), "utf8");

    await expect(store.read()).resolves.toEqual(current);
  });

  it("rejects unknown fields and stale/malformed identities", async () => {
    const { store } = await storeFixture();
    await writeFile(
      store.path,
      JSON.stringify({ ...ready(), credentialMaterial: "[REDACTED_SECRET]" }),
      "utf8"
    );
    await expect(store.read()).rejects.toThrow(/unknown service runtime status field/);

    await writeFile(store.path, JSON.stringify({ ...ready(), schemaVersion: 2 }), "utf8");
    await expect(store.read()).rejects.toThrow(/unsupported service runtime status schema/);

    await writeFile(store.path, "not-json", "utf8");
    await expect(store.read()).rejects.toThrow(/not valid JSON/);
  });

  it("removes readiness only when release identity and pid both match", async () => {
    const { store } = await storeFixture();
    const value = ready();
    await store.write(value);

    await expect(store.removeIfMatches(value.releaseId, 7)).resolves.toBe(false);
    await expect(store.read()).resolves.toEqual(value);
    await expect(store.removeIfMatches(`rel_${"b".repeat(32)}`, value.pid)).resolves.toBe(false);
    await expect(store.removeIfMatches(value.releaseId, value.pid)).resolves.toBe(true);
    await expect(store.read()).resolves.toBeUndefined();
  });

  it("accepts readiness only when active systemd MainPID and releaseId match", async () => {
    const { store } = await storeFixture();
    const expected = ready();
    const states: UserServiceState[] = [
      {
        loadState: "loaded",
        activeState: "activating",
        subState: "start",
        unitFileState: "enabled"
      },
      {
        loadState: "loaded",
        activeState: "active",
        subState: "running",
        unitFileState: "enabled",
        mainPid: expected.pid
      }
    ];
    let index = 0;
    const manager = managerWithShow(async () => states[Math.min(index++, states.length - 1)]!);
    await store.write(expected);

    await expect(
      waitForServiceReady({
        manager,
        statusStore: store,
        expectedReleaseId: expected.releaseId,
        timeoutMs: 100,
        pollMs: 1,
        sleep: async () => undefined
      })
    ).resolves.toEqual(expected);
  });

  it("does not accept a stale ready file whose pid differs from systemd MainPID", async () => {
    const { store } = await storeFixture();
    const expected = ready();
    await store.write(expected);
    const manager = managerWithShow(async () => ({
      loadState: "loaded",
      activeState: "active",
      subState: "running",
      unitFileState: "enabled",
      mainPid: expected.pid + 1
    }));

    await expect(
      waitForServiceReady({
        manager,
        statusStore: store,
        expectedReleaseId: expected.releaseId,
        timeoutMs: 0,
        pollMs: 1,
        sleep: async () => undefined
      })
    ).rejects.toThrow(/timed out waiting for KodeGPT service readiness/);
  });
});

function managerWithShow(show: () => Promise<UserServiceState>): SystemdUserManager {
  return {
    daemonReload: async () => undefined,
    enable: async () => undefined,
    disable: async () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    restart: async () => undefined,
    resetFailed: async () => undefined,
    show,
    linger: async () => "disabled"
  };
}
