import { describe, expect, it } from "vitest";

import { runSkillCommand, type SkillCommandDependencies } from "./skill.js";

const SOURCE_ID = `ss_${"a".repeat(32)}`;
const OTHER_SOURCE_ID = `ss_${"b".repeat(32)}`;
const SKILL_ID = `sk_${"c".repeat(64)}`;
const FINGERPRINT = "d".repeat(64);
const OTHER_FINGERPRINT = "e".repeat(64);

function dependencies(overrides: Partial<SkillCommandDependencies> = {}): SkillCommandDependencies {
  return {
    sourceStore: {
      list: async () => [],
      remove: async () => false
    },
    sourceManager: {
      addSource: async () => ({ sourceId: SOURCE_ID, label: "skills", kind: "agent-skills" })
    },
    catalog: {
      pin: async () => ({ skillId: SKILL_ID, fingerprint: FINGERPRINT }) as never
    },
    pinStore: {
      list: async () => [],
      unpin: async () => false
    },
    ...overrides
  };
}

describe("local skill CLI", () => {
  it("adds an absolute Agent Skills source through the inspected source manager", async () => {
    const calls: unknown[] = [];
    const deps = dependencies({
      sourceManager: {
        addSource: async (path, label) => {
          calls.push({ path, label });
          return { sourceId: SOURCE_ID, label, kind: "agent-skills" };
        }
      }
    });

    await expect(
      runSkillCommand(["source", "add", "/opt/agent-skills", "--kind", "agent-skills"], deps)
    ).resolves.toBe(`added ${SOURCE_ID} agent-skills /opt/agent-skills`);
    expect(calls).toEqual([{ path: "/opt/agent-skills", label: "agent-skills" }]);
  });

  it("lists canonical source paths locally and removes only a valid source id", async () => {
    const removed: string[] = [];
    const deps = dependencies({
      sourceStore: {
        list: async () => [
          {
            sourceId: OTHER_SOURCE_ID,
            label: "second",
            kind: "agent-skills",
            canonicalRoot: "/private/second",
            identity: { deviceMajor: 8, deviceMinor: 1, inode: "2" }
          },
          {
            sourceId: SOURCE_ID,
            label: "first",
            kind: "agent-skills",
            canonicalRoot: "/private/first",
            identity: { deviceMajor: 8, deviceMinor: 1, inode: "1" }
          }
        ],
        remove: async (sourceId) => {
          removed.push(sourceId);
          return sourceId === SOURCE_ID;
        }
      }
    });

    const listed = await runSkillCommand(["source", "list"], deps);
    expect(listed.split("\n")).toEqual([
      `${SOURCE_ID}\tagent-skills\t/private/first\tfirst`,
      `${OTHER_SOURCE_ID}\tagent-skills\t/private/second\tsecond`
    ]);
    await expect(runSkillCommand(["source", "remove", SOURCE_ID], deps)).resolves.toBe(`removed ${SOURCE_ID}`);
    expect(removed).toEqual([SOURCE_ID]);
  });

  it("pins a live skill with an optional expected bundle fingerprint", async () => {
    const calls: unknown[] = [];
    const deps = dependencies({
      catalog: {
        pin: async (input) => {
          calls.push(input);
          return { skillId: SKILL_ID, fingerprint: FINGERPRINT } as never;
        }
      }
    });

    await expect(
      runSkillCommand(["pin", SKILL_ID, "--fingerprint", FINGERPRINT], deps)
    ).resolves.toBe(`pinned ${SKILL_ID} ${FINGERPRINT}`);
    expect(calls).toEqual([{ skillId: SKILL_ID, expectedBundleFingerprint: FINGERPRINT }]);
  });

  it("unpins the explicit fingerprint or resolves a unique pinned fingerprint locally", async () => {
    const calls: unknown[] = [];
    const deps = dependencies({
      pinStore: {
        list: async () => [
          { skillId: SKILL_ID, fingerprint: FINGERPRINT },
          { skillId: `sk_${"f".repeat(64)}`, fingerprint: OTHER_FINGERPRINT }
        ] as never,
        unpin: async (skillId, fingerprint) => {
          calls.push({ skillId, fingerprint });
          return true;
        }
      }
    });

    await expect(runSkillCommand(["unpin", SKILL_ID], deps)).resolves.toBe(
      `unpinned ${SKILL_ID} ${FINGERPRINT}`
    );
    await expect(
      runSkillCommand(["unpin", SKILL_ID, "--fingerprint", OTHER_FINGERPRINT], deps)
    ).resolves.toBe(`unpinned ${SKILL_ID} ${OTHER_FINGERPRINT}`);
    expect(calls).toEqual([
      { skillId: SKILL_ID, fingerprint: FINGERPRINT },
      { skillId: SKILL_ID, fingerprint: OTHER_FINGERPRINT }
    ]);
  });

  it("requires an explicit fingerprint when multiple pinned versions exist", async () => {
    const deps = dependencies({
      pinStore: {
        list: async () => [
          { skillId: SKILL_ID, fingerprint: FINGERPRINT },
          { skillId: SKILL_ID, fingerprint: OTHER_FINGERPRINT }
        ] as never,
        unpin: async () => true
      }
    });

    await expect(runSkillCommand(["unpin", SKILL_ID], deps)).rejects.toThrow(/--fingerprint/i);
  });

  it("rejects relative paths, unsupported kinds, malformed ids, unknown options, and extra positionals", async () => {
    const deps = dependencies();
    const invalidCases: string[][] = [
      ["source", "add", "relative/skills"],
      ["source", "add", "/opt/skills", "--kind", "codex"],
      ["source", "add", "/opt/skills", "--unknown", "value"],
      ["source", "remove", "ksrc_old"],
      ["source", "remove", SOURCE_ID, "extra"],
      ["pin", "skill_old"],
      ["pin", SKILL_ID, "--fingerprint", "bad"],
      ["pin", SKILL_ID, "extra"],
      ["unpin", SKILL_ID, "--unknown", "value"]
    ];

    for (const args of invalidCases) {
      await expect(runSkillCommand(args, deps)).rejects.toThrow();
    }
  });
});
