import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_SOURCE_ENTRIES,
  SkillError,
  SkillSourceManager,
  SkillSourceStore,
  type PersistedSkillSourceIdentity,
  type SkillSourceRuntimeAdapter
} from "./index.js";
import {
  createSkillTestStateRoot,
  removeSkillTestStateRoot,
  testSkillSourceIdentity
} from "./test-support.js";

type RuntimeCalls = {
  inspect: string[];
  register: Array<{ rootPath: string; expectedIdentity: PersistedSkillSourceIdentity }>;
  tree: Array<{ sourceCapabilityId: string; path: string; maxEntries: number }>;
  read: Array<{ sourceCapabilityId: string; path: string; offset: number; maxBytes: number }>;
  readBytes: Array<{ sourceCapabilityId: string; path: string; offset: number; maxBytes: number }>;
  unregister: string[];
};

function fakeRuntime(options?: {
  inspectIdentity?: PersistedSkillSourceIdentity;
  registerError?: Error;
  registerGate?: Promise<void>;
  unregisterErrorFor?: string;
}): { runtime: SkillSourceRuntimeAdapter; calls: RuntimeCalls } {
  const calls: RuntimeCalls = {
    inspect: [],
    register: [],
    tree: [],
    read: [],
    readBytes: [],
    unregister: []
  };
  let nextCapability = 1;
  let nextInspectionIdentity = 1;
  const runtime: SkillSourceRuntimeAdapter = {
    async inspectRoot(path) {
      calls.inspect.push(path);
      return {
        canonicalRoot: `/canonical${path}`,
        identity: options?.inspectIdentity ?? testSkillSourceIdentity(nextInspectionIdentity++)
      };
    },
    async register(input) {
      calls.register.push({
        rootPath: input.rootPath,
        expectedIdentity: { ...input.expectedIdentity }
      });
      if (options?.registerGate !== undefined) {
        await options.registerGate;
      }
      if (options?.registerError !== undefined) {
        throw options.registerError;
      }
      return { sourceCapabilityId: `sc_test_${nextCapability++}` };
    },
    async tree(input) {
      calls.tree.push({ ...input });
      return {
        entries: [{ path: "skill-a/SKILL.md", kind: "file", sizeBytes: 12 }],
        truncated: false
      };
    },
    async read(input) {
      calls.read.push({ ...input });
      return { contents: "instructions", bytesRead: 12, eof: true };
    },
    async readBytes(input) {
      calls.readBytes.push({ ...input });
      return { bytes: Uint8Array.from([0, 255, 1, 128]), bytesRead: 4, eof: true };
    },
    async unregister(sourceCapabilityId) {
      calls.unregister.push(sourceCapabilityId);
      if (options?.unregisterErrorFor === sourceCapabilityId) {
        throw new SkillError("SKILL_SOURCE_UNAVAILABLE", "Skill source runtime request failed");
      }
    }
  };
  return { runtime, calls };
}

const roots: string[] = [];

async function managerFixture(
  label: string,
  runtime: SkillSourceRuntimeAdapter
): Promise<{ store: SkillSourceStore; manager: SkillSourceManager }> {
  const root = await createSkillTestStateRoot(label);
  roots.push(root);
  const store = new SkillSourceStore(root);
  return { store, manager: new SkillSourceManager(store, runtime) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeSkillTestStateRoot));
});

describe("SkillSourceManager", () => {
  it("inspects before persisting a source and stores only the inspected canonical identity", async () => {
    const identity = testSkillSourceIdentity(7);
    const { runtime, calls } = fakeRuntime({ inspectIdentity: identity });
    const { store, manager } = await managerFixture("add", runtime);

    const source = await manager.addSource("/input/skills", "My skills");

    expect(calls.inspect).toEqual(["/input/skills"]);
    expect(calls.register).toEqual([]);
    expect(source).toEqual({
      sourceId: source.sourceId,
      label: "My skills",
      kind: "agent-skills"
    });
    expect(source).not.toHaveProperty("canonicalRoot");
    expect(source).not.toHaveProperty("identity");
    expect(await store.list()).toEqual([
      {
        sourceId: source.sourceId,
        label: "My skills",
        kind: "agent-skills",
        canonicalRoot: "/canonical/input/skills",
        identity
      }
    ]);
  });

  it("registers lazily with the exact persisted identity and reuses only an in-memory capability", async () => {
    const identity = testSkillSourceIdentity(9);
    const { runtime, calls } = fakeRuntime({ inspectIdentity: identity });
    const { manager } = await managerFixture("lazy", runtime);
    const source = await manager.addSource("/skills", "Skills");

    await expect(manager.ensureRegistered(source.sourceId)).resolves.toBeUndefined();
    await expect(manager.ensureRegistered(source.sourceId)).resolves.toBeUndefined();

    expect(calls.register).toEqual([
      { rootPath: "/canonical/skills", expectedIdentity: identity }
    ]);
  });

  it("coalesces concurrent registration for the same persistent source", async () => {
    let releaseRegistration!: () => void;
    const registerGate = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    const { runtime, calls } = fakeRuntime({ registerGate });
    const { manager } = await managerFixture("concurrent-register", runtime);
    const source = await manager.addSource("/skills", "Skills");

    const first = manager.ensureRegistered(source.sourceId);
    const second = manager.ensureRegistered(source.sourceId);
    releaseRegistration();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(calls.register).toHaveLength(1);
  });

  it("does not refresh persisted identity when runtime registration reports identity change", async () => {
    const identity = testSkillSourceIdentity(11);
    const { runtime, calls } = fakeRuntime({
      inspectIdentity: identity,
      registerError: new SkillError(
        "SKILL_SOURCE_IDENTITY_CHANGED",
        "Skill source runtime request failed"
      )
    });
    const { store, manager } = await managerFixture("identity-change", runtime);
    const source = await manager.addSource("/skills", "Skills");

    await expect(manager.ensureRegistered(source.sourceId)).rejects.toMatchObject({
      code: "SKILL_SOURCE_IDENTITY_CHANGED"
    });
    expect((await store.get(source.sourceId))?.identity).toEqual(identity);
    expect(calls.inspect).toEqual(["/skills"]);
    expect(calls.register).toHaveLength(1);
  });

  it("maps an invalid persisted source registration to unavailable", async () => {
    const { runtime } = fakeRuntime({
      registerError: new SkillError("SKILL_SOURCE_INVALID", "Skill source runtime request failed")
    });
    const { manager } = await managerFixture("persisted-root-unavailable", runtime);
    const source = await manager.addSource("/skills", "Skills");

    await expect(manager.ensureRegistered(source.sourceId)).rejects.toMatchObject({
      name: "SkillError",
      code: "SKILL_SOURCE_UNAVAILABLE"
    });
  });

  it("tree/read lazily register and accept only canonical relative paths", async () => {
    const { runtime, calls } = fakeRuntime();
    const { manager } = await managerFixture("read-tree", runtime);
    const source = await manager.addSource("/skills", "Skills");

    expect(await manager.tree({ sourceId: source.sourceId, path: "." })).toEqual({
      entries: [{ path: "skill-a/SKILL.md", kind: "file", sizeBytes: 12 }],
      truncated: false
    });
    expect(
      await manager.read({
        sourceId: source.sourceId,
        path: "skill-a/SKILL.md",
        offset: 0,
        maxBytes: 256
      })
    ).toEqual({ contents: "instructions", bytesRead: 12, eof: true });

    expect(calls.register).toHaveLength(1);
    expect(calls.tree).toEqual([
      { sourceCapabilityId: "sc_test_1", path: ".", maxEntries: MAX_SOURCE_ENTRIES }
    ]);
    expect(calls.read).toEqual([
      {
        sourceCapabilityId: "sc_test_1",
        path: "skill-a/SKILL.md",
        offset: 0,
        maxBytes: 256
      }
    ]);

    for (const invalidPath of ["/absolute/SKILL.md", "../escape", "skill-a/../SKILL.md", "./skill-a/SKILL.md"]) {
      await expect(
        manager.read({ sourceId: source.sourceId, path: invalidPath, offset: 0, maxBytes: 64 })
      ).rejects.toMatchObject({ code: "SKILL_SOURCE_BOUNDARY_VIOLATION" });
    }
    expect(calls.read).toHaveLength(1);
  });

  it("exposes bounded raw reads through the manager without exposing source capabilities", async () => {
    const { runtime } = fakeRuntime();
    const { manager } = await managerFixture("raw-read", runtime);
    const source = await manager.addSource("/skills", "Skills");

    const result = await manager.readBytes({
      sourceId: source.sourceId,
      path: "assets/binary.bin",
      offset: 0,
      maxBytes: 256
    });
    expect([...result.bytes]).toEqual([0, 255, 1, 128]);
    expect({ bytesRead: result.bytesRead, eof: result.eof }).toEqual({ bytesRead: 4, eof: true });
    expect(result).not.toHaveProperty("sourceCapabilityId");
  });

  it("unregisters before removing local admission and close attempts every active capability", async () => {
    const { runtime, calls } = fakeRuntime();
    const { store, manager } = await managerFixture("remove-close", runtime);
    const first = await manager.addSource("/one", "One");
    const second = await manager.addSource("/two", "Two");
    await manager.ensureRegistered(first.sourceId);
    await manager.ensureRegistered(second.sourceId);

    await expect(manager.removeSource(first.sourceId)).resolves.toBe(true);
    expect(calls.unregister).toEqual(["sc_test_1"]);
    expect(await store.get(first.sourceId)).toBeUndefined();

    await expect(manager.close()).resolves.toBeUndefined();
    expect(calls.unregister).toEqual(["sc_test_1", "sc_test_2"]);
  });

  it("close attempts all unregisters even when one fails and missing source ids are stable errors", async () => {
    const { runtime, calls } = fakeRuntime({ unregisterErrorFor: "sc_test_1" });
    const { manager } = await managerFixture("close-failure", runtime);
    const first = await manager.addSource("/one", "One");
    const second = await manager.addSource("/two", "Two");
    await manager.ensureRegistered(first.sourceId);
    await manager.ensureRegistered(second.sourceId);

    await expect(manager.close()).rejects.toMatchObject({ code: "SKILL_SOURCE_UNAVAILABLE" });
    expect(calls.unregister).toEqual(["sc_test_1", "sc_test_2"]);
    await expect(manager.ensureRegistered("ss_00000000000000000000000000000000")).rejects.toMatchObject({
      code: "SKILL_SOURCE_NOT_FOUND"
    });
  });
});
