import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  WorkspaceIdentityChangedError,
  WorkspaceTrustStore,
  WorkspaceTrustStoreVersionError
} from "./workspace-trust-store.js";

const roots: string[] = [];

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kodegpt-trust-store-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WorkspaceTrustStore", () => {
  it("persists versioned trusted identity atomically with mode 0600", async () => {
    const root = await stateRoot();
    const store = new WorkspaceTrustStore(root);
    const entry = await store.trust({
      canonicalRoot: "/tmp/kodegpt-workspace-a",
      identity: { deviceMajor: 8, deviceMinor: 1, inode: "1001" },
      profileCeiling: "develop"
    });

    expect(entry.id).toMatch(/^trust_[A-Za-z0-9]+$/);
    expect(await store.list()).toEqual([entry]);

    const path = join(root, "trust", "workspaces.json");
    const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(persisted.schemaVersion).toBe(1);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("fails closed when the same canonical pathname has a different persistent identity", async () => {
    const root = await stateRoot();
    const store = new WorkspaceTrustStore(root);
    await store.trust({
      canonicalRoot: "/tmp/kodegpt-workspace-b",
      identity: { deviceMajor: 8, deviceMinor: 1, inode: "2001" },
      profileCeiling: "trusted"
    });

    await expect(
      store.requireTrusted("/tmp/kodegpt-workspace-b", {
        deviceMajor: 8,
        deviceMinor: 1,
        inode: "9999"
      })
    ).rejects.toBeInstanceOf(WorkspaceIdentityChangedError);
    await expect(
      store.requireTrusted("/tmp/kodegpt-workspace-b", {
        deviceMajor: 8,
        deviceMinor: 1,
        inode: "9999"
      })
    ).rejects.toMatchObject({ code: "WORKSPACE_IDENTITY_CHANGED" });
  });

  it("rejects unknown future schema versions explicitly", async () => {
    const root = await stateRoot();
    await mkdir(join(root, "trust"), { recursive: true });
    await writeFile(
      join(root, "trust", "workspaces.json"),
      JSON.stringify({ schemaVersion: 2, entries: [] }),
      { mode: 0o600 }
    );

    const store = new WorkspaceTrustStore(root);
    await expect(store.list()).rejects.toBeInstanceOf(WorkspaceTrustStoreVersionError);
    await expect(store.list()).rejects.toMatchObject({ code: "TRUST_STORE_VERSION_UNSUPPORTED" });
  });

  it("updates an existing canonical root instead of creating duplicate trust records", async () => {
    const root = await stateRoot();
    const store = new WorkspaceTrustStore(root);
    const first = await store.trust({
      canonicalRoot: "/tmp/kodegpt-workspace-c",
      identity: { deviceMajor: 8, deviceMinor: 1, inode: "3001" },
      profileCeiling: "observe"
    });
    const second = await store.trust({
      canonicalRoot: "/tmp/kodegpt-workspace-c",
      identity: { deviceMajor: 8, deviceMinor: 1, inode: "3001" },
      profileCeiling: "develop"
    });

    expect(second.id).toBe(first.id);
    expect(second.profileCeiling).toBe("develop");
    expect(await store.list()).toHaveLength(1);

    await store.untrust(first.id);
    expect(await store.list()).toEqual([]);
  });
});
