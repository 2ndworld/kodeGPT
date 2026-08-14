import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ServiceMetadataStore,
  emptyServiceMetadata,
  type ServiceReleaseRecord
} from "./metadata.js";

const roots: string[] = [];

async function fixture(): Promise<{ root: string; store: ServiceMetadataStore }> {
  const root = await mkdtemp(join(tmpdir(), "kodegpt-service-metadata-"));
  roots.push(root);
  return { root, store: new ServiceMetadataStore(root) };
}

function release(releaseId: string): ServiceReleaseRecord {
  const releaseRoot = `/home/test/.local/share/kodegpt/service/releases/${releaseId}`;
  return {
    releaseId,
    packageVersion: "0.1.0",
    runtimePackage: "@kodegpt/runtime-linux-x64",
    cliSha256: "a".repeat(64),
    runtimeSha256: "b".repeat(64),
    releaseRoot,
    cliPath: `${releaseRoot}/bin/kodegpt.mjs`,
    runtimePath: `${releaseRoot}/node_modules/@kodegpt/runtime-linux-x64/bin/kodegpt-runtime`,
    nodePath: "/opt/node/bin/node",
    zrokPath: "/usr/local/bin/zrok2",
    reservedName: "public:kodegpt-dev",
    port: 43_121
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("service metadata store", () => {
  it("treats a missing file as empty schema-1 metadata and writes mode 0600", async () => {
    const { store } = await fixture();
    await expect(store.read()).resolves.toEqual(emptyServiceMetadata());

    await store.write(emptyServiceMetadata());
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    await expect(store.read()).resolves.toEqual(emptyServiceMetadata());
  });

  it("stages and promotes releases while retaining one rollback identity", async () => {
    const { store } = await fixture();
    const a = release(`rel_${"1".repeat(32)}`);
    const b = release(`rel_${"2".repeat(32)}`);

    await store.stageRelease(a);
    expect(await store.read()).toEqual({
      schemaVersion: 1,
      unitName: "kodegpt.service",
      stagedReleaseId: a.releaseId,
      releases: { [a.releaseId]: a }
    });

    await store.promoteStagedRelease();
    expect((await store.read()).activeReleaseId).toBe(a.releaseId);

    await store.stageRelease(b);
    await store.promoteStagedRelease();
    const promoted = await store.read();
    expect(promoted.activeReleaseId).toBe(b.releaseId);
    expect(promoted.rollbackReleaseId).toBe(a.releaseId);
    expect(promoted.stagedReleaseId).toBeUndefined();
    expect(promoted.releases).toEqual({ [a.releaseId]: a, [b.releaseId]: b });
  });

  it("refuses to overwrite immutable metadata for an existing release identity", async () => {
    const { store } = await fixture();
    const a = release(`rel_${"4".repeat(32)}`);
    await store.stageRelease(a);
    await store.promoteStagedRelease();

    const conflicting = { ...a, port: 43_122 };
    await expect(store.stageRelease(conflicting)).rejects.toThrow(/release identity already exists with different metadata/);

    const unchanged = await store.read();
    expect(unchanged.activeReleaseId).toBe(a.releaseId);
    expect(unchanged.stagedReleaseId).toBeUndefined();
    expect(unchanged.releases[a.releaseId]).toEqual(a);
  });

  it("rejects unknown schemas and references to missing releases", async () => {
    const { root, store } = await fixture();
    await mkdir(root, { recursive: true });
    await writeFile(store.path, JSON.stringify({ schemaVersion: 2, unitName: "kodegpt.service", releases: {} }), "utf8");
    await expect(store.read()).rejects.toThrow(/unsupported service metadata schema/);

    await writeFile(
      store.path,
      JSON.stringify({
        schemaVersion: 1,
        unitName: "kodegpt.service",
        activeReleaseId: `rel_${"3".repeat(32)}`,
        releases: {}
      }),
      "utf8"
    );
    await expect(store.read()).rejects.toThrow(/activeReleaseId references a missing release/);
  });

  it("deletes only service metadata and preserves sibling state-root files", async () => {
    const { root, store } = await fixture();
    const sentinel = join(root, "connector-credential.json");
    await writeFile(sentinel, "keep-me", "utf8");
    await store.write(emptyServiceMetadata());

    await store.delete();

    await expect(stat(store.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(sentinel)).resolves.toBeDefined();
  });
});
