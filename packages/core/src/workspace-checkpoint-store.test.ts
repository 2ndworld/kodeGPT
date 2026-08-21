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
const SOURCE_STATE_A = {
  headOid: "1".repeat(40),
  changesFingerprint: "a".repeat(64)
};
const SOURCE_STATE_B = {
  headOid: "2".repeat(40),
  changesFingerprint: "b".repeat(64)
};

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

function upsert(
  store: WorkspaceCheckpointStore,
  input: {
    trustId: string;
    body: WorkspaceCheckpointBody;
    expectedRevision?: number;
    capturedSourceState?: typeof SOURCE_STATE_A;
  }
): ReturnType<WorkspaceCheckpointStore["upsert"]> {
  return (store.upsert as (value: {
    trustId: string;
    body: WorkspaceCheckpointBody;
    expectedRevision?: number;
    capturedSourceState: typeof SOURCE_STATE_A;
  }) => ReturnType<WorkspaceCheckpointStore["upsert"]>)({
    ...input,
    capturedSourceState: input.capturedSourceState ?? SOURCE_STATE_A
  });
}

describe("WorkspaceCheckpointStore", () => {
  it("normalizes persisted public schema-v1 checkpoints into continuity records without inventing source state", async () => {
    const root = await temporaryRoot("legacy-continuity");
    const directory = join(root, "workspace-checkpoints");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const checkpoint = {
      schemaVersion: 1,
      revision: 3,
      ...activeBody(),
      updatedAt: "2026-08-20T07:03:00.000Z"
    };
    await writeFile(join(directory, `${TRUST_ID}.json`), JSON.stringify(checkpoint), { mode: 0o600 });
    const store = new WorkspaceCheckpointStore(root);

    const record = await (
      store as WorkspaceCheckpointStore & {
        readContinuity(trustId: string): Promise<unknown>;
      }
    ).readContinuity(TRUST_ID);

    expect(record).toEqual({
      checkpoint: {
        ...checkpoint,
        baseline: { branch: "feat/checkpoint", headOid: "a".repeat(40) }
      },
      continuity: { schemaVersion: 1, milestones: [] }
    });
  });

  it("accepts strict private schema-v2 continuity envelopes and rejects malformed v2 state", async () => {
    const root = await temporaryRoot("v2-continuity");
    const directory = join(root, "workspace-checkpoints");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${TRUST_ID}.json`);
    const checkpoint = {
      schemaVersion: 1,
      revision: 2,
      ...activeBody(),
      updatedAt: "2026-08-20T07:02:00.000Z"
    };
    const store = new WorkspaceCheckpointStore(root);
    const reader = store as WorkspaceCheckpointStore & {
      readContinuity(trustId: string): Promise<unknown>;
    };

    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        current: checkpoint,
        capturedSourceState: SOURCE_STATE_A,
        milestones: [
          {
            revision: 1,
            status: "active",
            objective: "Earlier milestone",
            sourceState: SOURCE_STATE_A,
            updatedAt: "2026-08-20T07:01:00.000Z"
          }
        ]
      }),
      { mode: 0o600 }
    );

    await expect(reader.readContinuity(TRUST_ID)).resolves.toMatchObject({
      checkpoint: { revision: 2 },
      continuity: {
        schemaVersion: 1,
        capturedSourceState: SOURCE_STATE_A,
        milestones: [{ revision: 1, objective: "Earlier milestone" }]
      }
    });

    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        current: checkpoint,
        capturedSourceState: SOURCE_STATE_A,
        milestones: [],
        unexpected: true
      }),
      { mode: 0o600 }
    );
    await expect(reader.readContinuity(TRUST_ID)).rejects.toMatchObject({
      code: "CHECKPOINT_INVALID"
    });

    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        current: checkpoint,
        capturedSourceState: { ...SOURCE_STATE_A, changesFingerprint: "not-a-fingerprint" },
        milestones: []
      }),
      { mode: 0o600 }
    );
    await expect(reader.readContinuity(TRUST_ID)).rejects.toMatchObject({
      code: "CHECKPOINT_INVALID"
    });

    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        current: checkpoint,
        capturedSourceState: SOURCE_STATE_A,
        milestones: Array.from({ length: 9 }, (_, index) => ({
          revision: index + 1,
          status: "active",
          updatedAt: "2026-08-20T07:01:00.000Z"
        }))
      }),
      { mode: 0o600 }
    );
    await expect(reader.readContinuity(TRUST_ID)).rejects.toMatchObject({
      code: "CHECKPOINT_LIMIT_EXCEEDED"
    });

    await writeFile(path, "x".repeat(32 * 1024 + 1), { mode: 0o600 });
    await expect(reader.readContinuity(TRUST_ID)).rejects.toMatchObject({
      code: "CHECKPOINT_LIMIT_EXCEEDED"
    });
  });

  it("persists captured source state and compacts displaced revisions into bounded milestone history", async () => {
    const root = await temporaryRoot("milestones");
    const store = new WorkspaceCheckpointStore(root);
    const upsertContinuity = store.upsert.bind(store) as (input: {
      trustId: string;
      body: WorkspaceCheckpointBody;
      expectedRevision?: number;
      capturedSourceState: typeof SOURCE_STATE_A;
    }) => ReturnType<WorkspaceCheckpointStore["upsert"]>;

    await upsertContinuity({
      trustId: TRUST_ID,
      body: activeBody({ objective: "界".repeat(300) }),
      capturedSourceState: SOURCE_STATE_A
    });
    const firstRecord = await store.readContinuity(TRUST_ID);
    expect(firstRecord?.continuity).toEqual({
      schemaVersion: 1,
      capturedSourceState: SOURCE_STATE_A,
      milestones: []
    });

    await upsertContinuity({
      trustId: TRUST_ID,
      expectedRevision: 1,
      body: activeBody({ objective: "second" }),
      capturedSourceState: SOURCE_STATE_B
    });
    const secondRecord = await store.readContinuity(TRUST_ID);
    expect(secondRecord?.checkpoint.revision).toBe(2);
    expect(secondRecord?.continuity.capturedSourceState).toEqual(SOURCE_STATE_B);
    expect(secondRecord?.continuity.milestones).toHaveLength(1);
    expect(secondRecord?.continuity.milestones[0]).toMatchObject({
      revision: 1,
      status: "active",
      sourceState: SOURCE_STATE_A
    });
    expect(
      Buffer.byteLength(secondRecord?.continuity.milestones[0]?.objective ?? "", "utf8")
    ).toBeLessThanOrEqual(512);

    for (let revision = 2; revision <= 9; revision += 1) {
      await upsertContinuity({
        trustId: TRUST_ID,
        expectedRevision: revision,
        body: activeBody({ objective: `revision-${revision + 1}` }),
        capturedSourceState: SOURCE_STATE_B
      });
    }
    const bounded = await store.readContinuity(TRUST_ID);
    expect(bounded?.checkpoint.revision).toBe(10);
    expect(bounded?.continuity.milestones.map((milestone) => milestone.revision)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9
    ]);

    await store.clear(TRUST_ID, 10);
    await expect(store.readContinuity(TRUST_ID)).resolves.toBeUndefined();
  });

  it("lazily migrates legacy v1 state to v2 without fabricating historical source state", async () => {
    const root = await temporaryRoot("legacy-migration");
    const directory = join(root, "workspace-checkpoints");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${TRUST_ID}.json`);
    const legacy = {
      schemaVersion: 1,
      revision: 4,
      ...activeBody({ objective: "legacy objective" }),
      updatedAt: "2026-08-20T07:04:00.000Z"
    };
    await writeFile(path, JSON.stringify(legacy), { mode: 0o600 });
    const store = new WorkspaceCheckpointStore(root);
    const upsertContinuity = store.upsert.bind(store) as (input: {
      trustId: string;
      body: WorkspaceCheckpointBody;
      expectedRevision?: number;
      capturedSourceState: typeof SOURCE_STATE_A;
    }) => ReturnType<WorkspaceCheckpointStore["upsert"]>;

    await upsertContinuity({
      trustId: TRUST_ID,
      expectedRevision: 4,
      body: activeBody({ objective: "migrated objective" }),
      capturedSourceState: SOURCE_STATE_B
    });

    const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(persisted.schemaVersion).toBe(2);
    const record = await store.readContinuity(TRUST_ID);
    expect(record?.continuity.capturedSourceState).toEqual(SOURCE_STATE_B);
    expect(record?.continuity.milestones).toEqual([
      {
        revision: 4,
        status: "active",
        objective: "legacy objective",
        updatedAt: "2026-08-20T07:04:00.000Z"
      }
    ]);
  });

  it("creates, reads, updates, clears, and persists public checkpoint state inside private schema-v2 continuity", async () => {
    const stateRoot = await temporaryRoot("lifecycle");
    const times = [
      new Date("2026-08-20T07:00:00.000Z"),
      new Date("2026-08-20T07:01:00.000Z")
    ];
    const store = new WorkspaceCheckpointStore(stateRoot, {
      now: () => times.shift() ?? new Date("2026-08-20T07:02:00.000Z")
    });

    await expect(store.read(TRUST_ID)).resolves.toBeUndefined();
    const created = await upsert(store, { trustId: TRUST_ID, body: activeBody() });
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
    expect(persisted).toEqual({
      schemaVersion: 2,
      current: created,
      capturedSourceState: SOURCE_STATE_A,
      milestones: []
    });

    const updated = await upsert(store, {
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
    const created = await upsert(store, { trustId: TRUST_ID, body: activeBody() });

    await expect(upsert(store, { trustId: TRUST_ID, body: activeBody() })).rejects.toMatchObject({
      code: "CHECKPOINT_STALE"
    });
    await expect(
      upsert(store, { trustId: TRUST_ID, expectedRevision: created.revision + 1, body: activeBody() })
    ).rejects.toMatchObject({ code: "CHECKPOINT_STALE" });
    await expect(store.clear(TRUST_ID, created.revision + 1)).rejects.toMatchObject({
      code: "CHECKPOINT_STALE"
    });

    const missingId = `trust_${"b".repeat(32)}`;
    await expect(
      upsert(store, { trustId: missingId, expectedRevision: 1, body: activeBody() })
    ).rejects.toMatchObject({ code: "CHECKPOINT_NOT_FOUND" });
    await expect(store.clear(missingId, 1)).rejects.toMatchObject({
      code: "CHECKPOINT_NOT_FOUND"
    });
  });

  it("serializes concurrent CAS writers so only one update with the same revision succeeds", async () => {
    const root = await temporaryRoot("concurrent");
    const store = new WorkspaceCheckpointStore(root);
    await upsert(store, { trustId: TRUST_ID, body: activeBody() });

    const results = await Promise.allSettled([
      upsert(store, {
        trustId: TRUST_ID,
        expectedRevision: 1,
        body: activeBody({ objective: "writer-a" })
      }),
      upsert(store, {
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
      await expect(upsert(store, { trustId: TRUST_ID, body })).rejects.toMatchObject({ code });
      await expect(store.read(TRUST_ID)).resolves.toBeUndefined();
    }

    await expect(
      upsert(store, {
        trustId: TRUST_ID,
        body: { ...activeBody(), unexpected: true } as never
      })
    ).rejects.toMatchObject({ code: "CHECKPOINT_INVALID" });
    await expect(
      upsert(store, { trustId: "../escape", body: activeBody() })
    ).rejects.toMatchObject({ code: "CHECKPOINT_INVALID" });
    await expect(
      upsert(store, { trustId: TRUST_ID, expectedRevision: 0, body: activeBody() })
    ).rejects.toMatchObject({ code: "CHECKPOINT_INVALID" });
    await expect(store.clear(TRUST_ID, 0)).rejects.toMatchObject({ code: "CHECKPOINT_INVALID" });
  });

  it("rejects future/malformed persisted state and enforces the total serialized checkpoint bound", async () => {
    const root = await temporaryRoot("persisted-invalid");
    const directory = join(root, "workspace-checkpoints");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${TRUST_ID}.json`);
    const store = new WorkspaceCheckpointStore(root);

    await writeFile(path, JSON.stringify({ schemaVersion: 3 }), { mode: 0o600 });
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
      upsert(store, {
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
    await upsert(store, { trustId: TRUST_ID, body: activeBody() });
    await store.purge(TRUST_ID);
    await store.purge(TRUST_ID);
    await expect(store.read(TRUST_ID)).resolves.toBeUndefined();
  });
});
