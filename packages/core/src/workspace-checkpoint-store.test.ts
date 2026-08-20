import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  WorkspaceCheckpointError,
  WorkspaceCheckpointStore,
  type WorkspaceCheckpointBody
} from "./workspace-checkpoint-store.js";

const roots: string[] = [];
const TRUST_ID = `trust_${"a".repeat(32)}`;

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `kodegpt-checkpoint-${label}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function activeBody(overrides: Partial<WorkspaceCheckpointBody> = {}): WorkspaceCheckpointBody {
  return {
    objective: "Continue the current implementation",
    status: "active",
    baseline: { branch: "feat/checkpoint", headOid: "A".repeat(40) },
    nextActions: ["Run the focused tests"],
    evidenceRefs: [
      { kind: "git", ref: "611b947", summary: "Dynamic skill CLI compatibility" }
    ],
    notes: "Keep the next step bounded.",
    ...overrides
  };
}

describe("WorkspaceCheckpointStore", () => {
  it("creates, reads, updates, clears, and persists private schema-v1 checkpoint state", async () => {
    const stateRoot = await temporaryRoot("lifecycle");
    const times = [
      new Date("2026-08-20T07:00:00.000Z"),
      new Date("2026-08-20T07:01:00.000Z")
    ];
    const store = new WorkspaceCheckpointStore(stateRoot, {
      now: () => times.shift() ?? new Date("2026-08-20T07:02:00.000Z")
    });

    await expect(store.read(TRUST_ID)).resolves.toBeUndefined();
    const created = await store.upsert({ trustId: TRUST_ID, body: activeBody() });
    expect(created).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      updatedAt: "2026-08-20T07:00:00.000Z",
      status: "active",
      baseline: { branch: "feat/checkpoint", headOid: "a".repeat(40) }
    });
    expect(await store.read(TRUST_ID)).toEqual(created);

    const path = join(stateRoot, "workspace-checkpoints", `${TRUST_ID}.json`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(stateRoot, "workspace-checkpoints"))).mode & 0o777).toBe(0o700);
    const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(persisted).toEqual(created);

    const updated = await store.upsert({
      trustId: TRUST_ID,
      expectedRevision: 1,
      body: activeBody({ objective: "Finish continuity", nextActions: ["Wire MCP"] })
    });
    expect(updated).toMatchObject({
      revision: 2,
      updatedAt: "2026-08-20T07:01:00.000Z",
      objective: "Finish continuity"
    });

    await store.clear(TRUST_ID, 2);
    await expect(store.read(TRUST_ID)).resolves.toBeUndefined();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces create/update/clear CAS semantics and stable errors", async () => {
    const root = await temporaryRoot("cas");
    const store = new WorkspaceCheckpointStore(root);
    const created = await store.upsert({ trustId: TRUST_ID, body: activeBody() });

    await expect(store.upsert({ trustId: TRUST_ID, body: activeBody() })).rejects.toMatchObject({
      code: "CHECKPOINT_STALE"
    });
    await expect(
      store.upsert({ trustId: TRUST_ID, expectedRevision: created.revision + 1, body: activeBody() })
    ).rejects.toMatchObject({ code: "CHECKPOINT_STALE" });
    await expect(store.clear(TRUST_ID, created.revision + 1)).rejects.toMatchObject({
      code: "CHECKPOINT_STALE"
    });

    const missingId = `trust_${"b".repeat(32)}`;
    await expect(
      store.upsert({ trustId: missingId, expectedRevision: 1, body: activeBody() })
    ).rejects.toMatchObject({ code: "CHECKPOINT_NOT_FOUND" });
    await expect(store.clear(missingId, 1)).rejects.toMatchObject({
      code: "CHECKPOINT_NOT_FOUND"
    });
  });

  it("serializes concurrent CAS writers so only one update with the same revision succeeds", async () => {
    const root = await temporaryRoot("concurrent");
    const store = new WorkspaceCheckpointStore(root);
    await store.upsert({ trustId: TRUST_ID, body: activeBody() });

    const results = await Promise.allSettled([
      store.upsert({
        trustId: TRUST_ID,
        expectedRevision: 1,
        body: activeBody({ objective: "writer-a" })
      }),
      store.upsert({
        trustId: TRUST_ID,
        expectedRevision: 1,
        body: activeBody({ objective: "writer-b" })
      })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "CHECKPOINT_STALE" })
    });
    const final = await store.read(TRUST_ID);
    expect(final?.revision).toBe(2);
    expect(["writer-a", "writer-b"]).toContain(final?.objective);
  });

  it("validates strict body bounds and status invariants before persisting", async () => {
    const root = await temporaryRoot("bounds");
    const store = new WorkspaceCheckpointStore(root);
    const invalidBodies: Array<[WorkspaceCheckpointBody, string]> = [
      [activeBody({ objective: "x".repeat(2049) }), "CHECKPOINT_LIMIT_EXCEEDED"],
      [activeBody({ nextActions: Array.from({ length: 9 }, () => "x") }), "CHECKPOINT_LIMIT_EXCEEDED"],
      [activeBody({ nextActions: ["x".repeat(513)] }), "CHECKPOINT_LIMIT_EXCEEDED"],
      [
        activeBody({
          evidenceRefs: Array.from({ length: 17 }, (_, index) => ({ kind: "note", ref: String(index) }))
        }),
        "CHECKPOINT_LIMIT_EXCEEDED"
      ],
      [activeBody({ evidenceRefs: [{ kind: "note", ref: "x".repeat(513) }] }), "CHECKPOINT_LIMIT_EXCEEDED"],
      [activeBody({ evidenceRefs: [{ kind: "note", ref: "x", summary: "x".repeat(1025) }] }), "CHECKPOINT_LIMIT_EXCEEDED"],
      [activeBody({ status: "blocked", blocker: "x".repeat(2049) }), "CHECKPOINT_LIMIT_EXCEEDED"],
      [activeBody({ notes: "x".repeat(4097) }), "CHECKPOINT_LIMIT_EXCEEDED"],
      [activeBody({ blocker: "blocked while active" }), "CHECKPOINT_INVALID"],
      [activeBody({ status: "blocked", blocker: "" }), "CHECKPOINT_INVALID"],
      [activeBody({ status: "complete", nextActions: ["still pending"] }), "CHECKPOINT_INVALID"],
      [activeBody({ baseline: { headOid: "f".repeat(39) } }), "CHECKPOINT_INVALID"],
      [activeBody({ baseline: { branch: "main", extra: true } as never }), "CHECKPOINT_INVALID"],
      [activeBody({ evidenceRefs: [{ kind: "unknown", ref: "x" } as never] }), "CHECKPOINT_INVALID"]
    ];

    for (const [body, code] of invalidBodies) {
      await expect(store.upsert({ trustId: TRUST_ID, body })).rejects.toMatchObject({ code });
      await expect(store.read(TRUST_ID)).resolves.toBeUndefined();
    }

    await expect(
      store.upsert({
        trustId: TRUST_ID,
        body: { ...activeBody(), unexpected: true } as never
      })
    ).rejects.toMatchObject({ code: "CHECKPOINT_INVALID" });
    await expect(
      store.upsert({ trustId: "../escape", body: activeBody() })
    ).rejects.toMatchObject({ code: "CHECKPOINT_INVALID" });
    await expect(
      store.upsert({ trustId: TRUST_ID, expectedRevision: 0, body: activeBody() })
    ).rejects.toMatchObject({ code: "CHECKPOINT_INVALID" });
    await expect(store.clear(TRUST_ID, 0)).rejects.toMatchObject({ code: "CHECKPOINT_INVALID" });
  });

  it("rejects future/malformed persisted state and enforces the total serialized checkpoint bound", async () => {
    const root = await temporaryRoot("persisted-invalid");
    const directory = join(root, "workspace-checkpoints");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${TRUST_ID}.json`);
    const store = new WorkspaceCheckpointStore(root);

    await writeFile(path, JSON.stringify({ schemaVersion: 2 }), { mode: 0o600 });
    await expect(store.read(TRUST_ID)).rejects.toMatchObject({ code: "CHECKPOINT_SCHEMA_UNSUPPORTED" });

    await writeFile(path, "{not-json", { mode: 0o600 });
    await expect(store.read(TRUST_ID)).rejects.toBeInstanceOf(WorkspaceCheckpointError);

    for (const malformed of [
      {
        schemaVersion: 1,
        revision: 0,
        status: "active",
        nextActions: [],
        evidenceRefs: [],
        updatedAt: "2026-08-20T07:00:00.000Z"
      },
      {
        schemaVersion: 1,
        revision: 1,
        status: "active",
        nextActions: [],
        evidenceRefs: [],
        updatedAt: "not-a-timestamp"
      },
      {
        schemaVersion: 1,
        revision: 1,
        status: "active",
        nextActions: [],
        evidenceRefs: [],
        updatedAt: "2026-08-20T07:00:00.000Z",
        unexpected: true
      }
    ]) {
      await writeFile(path, JSON.stringify(malformed), { mode: 0o600 });
      await expect(store.read(TRUST_ID)).rejects.toMatchObject({ code: "CHECKPOINT_INVALID" });
    }
    await rm(path);

    await expect(
      store.upsert({
        trustId: TRUST_ID,
        body: activeBody({
          objective: "o".repeat(2048),
          nextActions: Array.from({ length: 8 }, () => "n".repeat(512)),
          evidenceRefs: Array.from({ length: 8 }, (_, index) => ({
            kind: "note",
            ref: `ref-${index}`,
            summary: "s".repeat(1024)
          })),
          blocker: undefined,
          notes: "z".repeat(4096)
        })
      })
    ).rejects.toMatchObject({ code: "CHECKPOINT_LIMIT_EXCEEDED" });
  });

  it("purges checkpoint state idempotently for untrust lifecycle cleanup", async () => {
    const root = await temporaryRoot("purge");
    const store = new WorkspaceCheckpointStore(root);
    await store.upsert({ trustId: TRUST_ID, body: activeBody() });
    await store.purge(TRUST_ID);
    await store.purge(TRUST_ID);
    await expect(store.read(TRUST_ID)).resolves.toBeUndefined();
  });
});
