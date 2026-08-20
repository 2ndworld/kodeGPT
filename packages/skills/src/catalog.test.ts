import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_LOADED_RESOURCES,
  MAX_RESOURCES_PER_SKILL,
  MAX_SKILLS_PER_SOURCE,
  MAX_SOURCE_ENTRIES,
  RESOURCE_TEXT_MAX_BYTES,
  SKILL_BUNDLE_MAX_BYTES,
  SKILL_DESCRIPTOR_MAX_BYTES,
  SKILL_MD_MAX_BYTES,
  SkillCatalog,
  SkillError,
  SkillPinStore,
  type PersistedSkillSource,
  type SkillSourceReadBytesResult,
  type SkillSourceTreeEntry,
  type SkillSourceTreeResult
} from "./index.js";
import { createSkillTestStateRoot, removeSkillTestStateRoot } from "./test-support.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORKFLOW_SKILL_NAME = "kodegpt-application-development-workflow";
const WORKFLOW_SKILL_PATH = join(REPOSITORY_ROOT, "skills", WORKFLOW_SKILL_NAME, "SKILL.md");
const catalogStateRoots: string[] = [];

afterEach(async () => {
  while (catalogStateRoots.length > 0) {
    await removeSkillTestStateRoot(catalogStateRoots.pop()!);
  }
});

type FakeEntry = SkillSourceTreeEntry & { bytes?: Uint8Array };

type FakeSource = {
  source: PersistedSkillSource;
  entries: Map<string, FakeEntry>;
};

class FakeSourceManager {
  readonly sources = new Map<string, FakeSource>();
  readonly unavailableSourceIds = new Set<string>();
  readonly workspaceBySourceId = new Map<string, string>();

  addSource(sourceId: string, label: string): FakeSource {
    const source: PersistedSkillSource = {
      sourceId,
      label,
      kind: "agent-skills",
      canonicalRoot: `/private/${label}`,
      identity: {
        deviceMajor: 8,
        deviceMinor: 1,
        inode: String(this.sources.size + 100)
      }
    };
    const value = { source, entries: new Map<string, FakeEntry>() };
    this.sources.set(sourceId, value);
    return value;
  }

  addWorkspaceSource(workspaceId: string, sourceId: string, label: string): FakeSource {
    const source = this.addSource(sourceId, label);
    this.workspaceBySourceId.set(sourceId, workspaceId);
    return source;
  }

  async listSources(workspaceId?: string): Promise<PersistedSkillSource[]> {
    return [...this.sources.values()]
      .filter(({ source }) => {
        const scope = this.workspaceBySourceId.get(source.sourceId);
        return scope === undefined || scope === workspaceId;
      })
      .map(({ source }) => ({
        ...source,
        identity: { ...source.identity }
      }));
  }

  async listReadyWorkspaceIds(): Promise<string[]> {
    return [...new Set(this.workspaceBySourceId.values())].sort(compareUtf8);
  }

  async tree(input: { workspaceId?: string; sourceId: string; path: string }): Promise<SkillSourceTreeResult> {
    if (this.unavailableSourceIds.has(input.sourceId)) throw new Error("fake source unavailable");
    const source = this.requiredSource(input.sourceId, input.workspaceId);
    const prefix = input.path === "." ? "" : `${input.path}/`;
    const entries = [...source.entries.values()]
      .filter((entry) => prefix === "" || entry.path.startsWith(prefix))
      .sort((left, right) => compareUtf8(left.path, right.path))
      .slice(0, MAX_SOURCE_ENTRIES)
      .map(({ bytes: _bytes, ...entry }) => ({ ...entry }));
    const total = [...source.entries.values()].filter(
      (entry) => prefix === "" || entry.path.startsWith(prefix)
    ).length;
    return { entries, truncated: total > MAX_SOURCE_ENTRIES };
  }

  async readBytes(input: {
    workspaceId?: string;
    sourceId: string;
    path: string;
    offset: number;
    maxBytes: number;
  }): Promise<SkillSourceReadBytesResult> {
    if (this.unavailableSourceIds.has(input.sourceId)) throw new Error("fake source unavailable");
    const entry = this.requiredSource(input.sourceId, input.workspaceId).entries.get(input.path);
    if (entry?.kind !== "file" || entry.bytes === undefined) {
      throw new Error("fake file unavailable");
    }
    const end = Math.min(entry.bytes.byteLength, input.offset + input.maxBytes);
    const bytes = entry.bytes.slice(input.offset, end);
    return {
      bytes,
      bytesRead: bytes.byteLength,
      eof: end >= entry.bytes.byteLength
    };
  }

  setFile(sourceId: string, path: string, bytes: Uint8Array): void {
    const source = this.requiredSource(sourceId, this.workspaceBySourceId.get(sourceId));
    source.entries.set(path, { path, kind: "file", sizeBytes: bytes.byteLength, bytes });
  }

  setEntry(sourceId: string, entry: FakeEntry): void {
    this.requiredSource(sourceId, this.workspaceBySourceId.get(sourceId)).entries.set(entry.path, entry);
  }

  private requiredSource(sourceId: string, workspaceId?: string): FakeSource {
    const source = this.sources.get(sourceId);
    if (source === undefined) throw new Error(`missing fake source ${sourceId}`);
    const scope = this.workspaceBySourceId.get(sourceId);
    if (scope !== undefined && scope !== workspaceId) {
      throw new SkillError("SKILL_WORKSPACE_MISMATCH", "fake workspace skill mismatch");
    }
    return source;
  }
}

const SOURCE_A = `ss_${"a".repeat(32)}`;
const SOURCE_B = `ss_${"b".repeat(32)}`;
const SOURCE_C = `ss_${"c".repeat(32)}`;
const SOURCE_D = `ss_${"d".repeat(32)}`;

function bytes(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

function skillDocument(name: string, description = `${name} description`, body = `${name} instructions\n`): Uint8Array {
  return bytes(`---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
}

function addSkill(
  manager: FakeSourceManager,
  sourceId: string,
  name: string,
  options?: { description?: string; body?: string }
): void {
  manager.setEntry(sourceId, { path: name, kind: "directory", sizeBytes: 4096 });
  manager.setFile(
    sourceId,
    `${name}/SKILL.md`,
    skillDocument(name, options?.description, options?.body)
  );
}

function addDirectory(manager: FakeSourceManager, sourceId: string, path: string): void {
  manager.setEntry(sourceId, { path, kind: "directory", sizeBytes: 4096 });
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

describe("SkillCatalog live discovery", () => {
  it("discovers, inspects, and loads the repository application-development workflow as native host guidance", async () => {
    const document = await readFile(WORKFLOW_SKILL_PATH);
    const manager = new FakeSourceManager();
    manager.addSource(SOURCE_A, "repository-skills");
    manager.setEntry(SOURCE_A, { path: WORKFLOW_SKILL_NAME, kind: "directory", sizeBytes: 4096 });
    manager.setFile(SOURCE_A, `${WORKFLOW_SKILL_NAME}/SKILL.md`, document);
    const catalog = new SkillCatalog(manager);

    const listed = await catalog.listLive();
    expect(listed.skills).toHaveLength(1);
    const workflow = listed.skills[0]!;
    expect(workflow).toMatchObject({
      name: WORKFLOW_SKILL_NAME,
      sourceKind: "agent-skills",
      compatibility: {
        classification: "NATIVE",
        missingCapabilities: [],
        requiredProviders: []
      }
    });

    const inspected = await catalog.inspect({ skillId: workflow.skillId });
    expect(inspected.capabilityPlan).toMatchObject({
      classification: "NATIVE",
      missingCapabilities: [],
      externalRequirements: [],
      blockedSemantics: []
    });
    expect(inspected.requirementGraph.schemaVersion).toBe(1);
    expect(inspected.requirementGraph.core.actions.length).toBeGreaterThan(0);
    expect(inspected.requirementGraph.stages.map((stage) => stage.id)).toEqual([
      "browser",
      "ci",
      "continuity",
      "git-delivery",
      "implementation",
      "preview",
      "pull-request",
      "repository-understanding",
      "verification",
      "visual"
    ]);
    const stage = (id: string) => inspected.requirementGraph.stages.find((item) => item.id === id)!;
    expect(stage("continuity").actions.map((action) => action.id)).toContain("workspace.info");
    expect(stage("preview").actions.map((action) => action.id)).toContain("preview.start");
    expect(stage("browser").actions.map((action) => action.id)).toContain("browser.openPreview");
    expect(stage("visual").actions.map((action) => action.id)).toContain("visual.captureMatrix");
    expect(stage("pull-request").actions.map((action) => action.id)).toContain("github.pr.create");
    expect(stage("ci").actions.map((action) => action.id)).toContain("ci.status");
    expect(inspected.capabilityPlan.nativeCapabilities).toEqual(
      expect.arrayContaining([
        "context.build",
        "code.search",
        "code.impact",
        "file.edit",
        "verify.run",
        "process.run",
        "git.diff",
        "git.commit",
        "git.push",
        "ci.status",
        "ci.runs",
        "ci.failure",
        "ci.rerun"
      ])
    );

    const loaded = await catalog.loadLiveRaw({ skillId: workflow.skillId });
    const instructions = Buffer.from(loaded.skillDocument).toString("utf8");
    for (const toolFamily of ["preview.start", "browser.openPreview", "visual.captureMatrix", "github.pr.create"]) {
      expect(instructions).toContain(toolFamily);
    }
    for (const behavior of [
      "Host owns orchestration",
      "Resume / continuation",
      ".ai-bridge/current-plan.md",
      ".ai-bridge/agent-status.md",
      "do not invent a new phase",
      "before `context.build`",
      "never blind retry",
      "final diff review",
      "CI failure evidence",
      "never busy-poll",
      "ci.rerun",
      "accepted: true",
      "refresh with `ci.run` or `ci.status`",
      "terminal rerunnable state",
      "Netlify"
    ]) {
      expect(instructions).toContain(behavior);
    }
    expect(instructions).toContain("skill.run");
    expect(instructions).toContain("Do not automatically deploy");
    expect(loaded.descriptor.compatibility).toMatchObject({
      classification: "NATIVE",
      missingCapabilities: [],
      requiredProviders: []
    });
  });

  it("discovers only direct regular Agent Skills, sorts deterministically, and marks name collisions", async () => {
    const manager = new FakeSourceManager();
    manager.addSource(SOURCE_B, "private-b");
    manager.addSource(SOURCE_A, "private-a");
    addSkill(manager, SOURCE_B, "zeta");
    addSkill(manager, SOURCE_B, "duplicate");
    addSkill(manager, SOURCE_A, "alpha");
    addSkill(manager, SOURCE_A, "duplicate");
    manager.setEntry(SOURCE_A, { path: "symlink-skill", kind: "symlink", sizeBytes: 5 });
    manager.setEntry(SOURCE_A, { path: "bad-skill", kind: "directory", sizeBytes: 4096 });
    manager.setEntry(SOURCE_A, { path: "bad-skill/SKILL.md", kind: "symlink", sizeBytes: 7 });
    manager.setFile(SOURCE_A, "🙂.txt", bytes("not a skill"));

    const result = await new SkillCatalog(manager).listLive();

    expect(result.truncated).toBe(false);
    expect(result.truncationReasons).toEqual([]);
    expect(result.skills.map((skill) => `${skill.name}:${skill.sourceId}`)).toEqual([
      `alpha:${SOURCE_A}`,
      `duplicate:${SOURCE_A}`,
      `duplicate:${SOURCE_B}`,
      `zeta:${SOURCE_B}`
    ]);
    expect(result.skills.filter((skill) => skill.name === "duplicate").every((skill) => skill.nameCollision))
      .toBe(true);
    expect(result.skills.find((skill) => skill.name === "alpha")?.nameCollision).toBe(false);
    for (const descriptor of result.skills) {
      expect(descriptor.skillId).toMatch(/^sk_[a-f0-9]{64}$/);
      expect(descriptor.descriptorFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(descriptor.sourceKind).toBe("agent-skills");
      expect(descriptor).not.toHaveProperty("canonicalRoot");
      expect(descriptor).not.toHaveProperty("relativeDirectory");
      expect(descriptor).not.toHaveProperty("sourceCapabilityId");
    }
    expect(JSON.stringify(result)).not.toContain("/private/");
  });

  it("refreshes live descriptors on every call rather than caching source contents", async () => {
    const manager = new FakeSourceManager();
    manager.addSource(SOURCE_A, "private-a");
    addSkill(manager, SOURCE_A, "fresh", { description: "Before" });
    const catalog = new SkillCatalog(manager);

    const before = (await catalog.listLive()).skills[0]!;
    manager.setFile(SOURCE_A, "fresh/SKILL.md", skillDocument("fresh", "After"));
    const after = (await catalog.listLive()).skills[0]!;

    expect(before.description).toBe("Before");
    expect(after.description).toBe("After");
    expect(after.descriptorFingerprint).not.toBe(before.descriptorFingerprint);
    expect(after.skillId).toBe(before.skillId);
  });

  it("reports source, skill-count, and descriptor-size truncation explicitly", async () => {
    const sourceLimitManager = new FakeSourceManager();
    sourceLimitManager.addSource(SOURCE_A, "source-limit");
    for (let index = 0; index <= MAX_SOURCE_ENTRIES; index += 1) {
      sourceLimitManager.setFile(
        SOURCE_A,
        `junk/${String(index).padStart(5, "0")}.txt`,
        bytes("x")
      );
    }
    const sourceLimit = await new SkillCatalog(sourceLimitManager).listLive();
    expect(sourceLimit).toMatchObject({ truncated: true });
    expect(sourceLimit.truncationReasons).toContain("SOURCE_ENTRY_LIMIT");

    const skillLimitManager = new FakeSourceManager();
    skillLimitManager.addSource(SOURCE_A, "skill-limit");
    for (let index = 0; index <= MAX_SKILLS_PER_SOURCE; index += 1) {
      const name = `skill-${String(index).padStart(4, "0")}`;
      addSkill(skillLimitManager, SOURCE_A, name);
    }
    const skillLimit = await new SkillCatalog(skillLimitManager).listLive();
    expect(skillLimit.skills).toHaveLength(MAX_SKILLS_PER_SOURCE);
    expect(skillLimit.truncated).toBe(true);
    expect(skillLimit.truncationReasons).toContain("SKILL_COUNT_LIMIT");

    const descriptorLimitManager = new FakeSourceManager();
    descriptorLimitManager.addSource(SOURCE_A, "descriptor-limit");
    descriptorLimitManager.setEntry(SOURCE_A, {
      path: "too-large",
      kind: "directory",
      sizeBytes: 4096
    });
    descriptorLimitManager.setFile(
      SOURCE_A,
      "too-large/SKILL.md",
      skillDocument("too-large", "ok", "x".repeat(SKILL_MD_MAX_BYTES))
    );
    const descriptorLimit = await new SkillCatalog(descriptorLimitManager).listLive();
    expect(descriptorLimit.skills).toEqual([]);
    expect(descriptorLimit.truncated).toBe(true);
    expect(descriptorLimit.truncationReasons).toContain("DESCRIPTOR_SIZE_LIMIT");

    const frontmatterLimitManager = new FakeSourceManager();
    frontmatterLimitManager.addSource(SOURCE_A, "frontmatter-limit");
    frontmatterLimitManager.setEntry(SOURCE_A, {
      path: "frontmatter-limit",
      kind: "directory",
      sizeBytes: 4096
    });
    frontmatterLimitManager.setFile(
      SOURCE_A,
      "frontmatter-limit/SKILL.md",
      bytes(
        `---\nname: frontmatter-limit\ndescription: ok\nmetadata:\n  padding: "${"x".repeat(SKILL_DESCRIPTOR_MAX_BYTES)}"\n---\nbody\n`
      )
    );
    const frontmatterLimit = await new SkillCatalog(frontmatterLimitManager).listLive();
    expect(frontmatterLimit.skills).toEqual([]);
    expect(frontmatterLimit.truncated).toBe(true);
    expect(frontmatterLimit.truncationReasons).toContain("DESCRIPTOR_SIZE_LIMIT");
  });
});

describe("SkillCatalog workspace scope", () => {
  it("adds READY workspace skills only with matching scope and reports required/mismatch on scoped misses", async () => {
    const manager = new FakeSourceManager();
    manager.addSource(SOURCE_A, "global");
    manager.addWorkspaceSource("ws_1", SOURCE_C, "workspace-one");
    manager.addWorkspaceSource("ws_2", SOURCE_D, "workspace-two");
    addSkill(manager, SOURCE_A, "global-skill");
    addSkill(manager, SOURCE_C, "local-one");
    addSkill(manager, SOURCE_D, "local-two");
    const catalog = new SkillCatalog(manager);

    const global = await catalog.list();
    expect(global.skills.map((skill) => skill.name)).toEqual(["global-skill"]);

    const scoped = await catalog.list({ workspaceId: "ws_1" });
    expect(scoped.skills.map((skill) => skill.name)).toEqual(["global-skill", "local-one"]);
    const local = scoped.skills.find((skill) => skill.name === "local-one")!;

    await expect(catalog.inspect({ skillId: local.skillId, workspaceId: "ws_1" }))
      .resolves.toMatchObject({ skill: { name: "local-one" } });
    await expect(catalog.loadRaw({ skillId: local.skillId, workspaceId: "ws_1" }))
      .resolves.toMatchObject({ descriptor: { name: "local-one" }, availability: "live" });

    await expect(catalog.inspect({ skillId: local.skillId }))
      .rejects.toMatchObject({ code: "SKILL_WORKSPACE_REQUIRED" });
    await expect(catalog.loadRaw({ skillId: local.skillId }))
      .rejects.toMatchObject({ code: "SKILL_WORKSPACE_REQUIRED" });
    await expect(catalog.inspect({ skillId: local.skillId, workspaceId: "ws_2" }))
      .rejects.toMatchObject({ code: "SKILL_WORKSPACE_MISMATCH" });
    await expect(catalog.loadRaw({ skillId: local.skillId, workspaceId: "ws_2" }))
      .rejects.toMatchObject({ code: "SKILL_WORKSPACE_MISMATCH" });

    await expect(catalog.inspect({ skillId: `sk_${"f".repeat(64)}` }))
      .rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
  });
});

describe("SkillCatalog inspection and raw loading", () => {
  function richCatalog(): { manager: FakeSourceManager; catalog: SkillCatalog } {
    const manager = new FakeSourceManager();
    manager.addSource(SOURCE_A, "private-a");
    addSkill(manager, SOURCE_A, "bundle", { body: "Bundle instructions\n" });
    addDirectory(manager, SOURCE_A, "bundle/references");
    manager.setFile(SOURCE_A, "bundle/references/guide.md", bytes("guide body\n"));
    addDirectory(manager, SOURCE_A, "bundle/assets");
    manager.setFile(SOURCE_A, "bundle/assets/binary.bin", Uint8Array.from([0, 255, 1, 128]));
    addDirectory(manager, SOURCE_A, "bundle/scripts");
    manager.setFile(SOURCE_A, "bundle/scripts/run.sh", bytes("#!/bin/sh\necho inert\n"));
    manager.setFile(
      SOURCE_A,
      "bundle/large.txt",
      bytes("x".repeat(RESOURCE_TEXT_MAX_BYTES + 1))
    );
    return { manager, catalog: new SkillCatalog(manager) };
  }

  it("returns metadata and bounded inventory without resource bodies, while scripts stay inert", async () => {
    const { catalog } = richCatalog();
    const descriptor = (await catalog.listLive()).skills[0]!;
    const inspection = await catalog.inspectLive({
      skillId: descriptor.skillId,
      expectedDescriptorFingerprint: descriptor.descriptorFingerprint
    });

    expect(inspection.bundleFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(inspection.bundleBytes).toBeGreaterThan(0);
    expect(inspection.descriptor.compatibility).toMatchObject({
      classification: "NATIVE",
      missingCapabilities: [],
      requiredProviders: []
    });
    expect(inspection.frontmatter).toMatchObject({ name: "bundle", description: "bundle description" });
    expect(inspection.resources).toEqual([
      expect.objectContaining({
        path: "assets/binary.bin",
        bytes: 4,
        kind: "binary",
        textInlineEligible: false
      }),
      expect.objectContaining({
        path: "large.txt",
        bytes: RESOURCE_TEXT_MAX_BYTES + 1,
        kind: "text",
        textInlineEligible: false
      }),
      expect.objectContaining({
        path: "references/guide.md",
        bytes: 11,
        kind: "text",
        textInlineEligible: true
      }),
      expect.objectContaining({
        path: "scripts/run.sh",
        kind: "text",
        textInlineEligible: true
      })
    ]);
    const serialized = JSON.stringify(inspection);
    expect(serialized).not.toContain("guide body");
    expect(serialized).not.toContain("echo inert");
    expect(serialized).not.toContain("/private/");
  });

  it("produces identical bundle fingerprints for identical bundles in different sources", async () => {
    const manager = new FakeSourceManager();
    manager.addSource(SOURCE_A, "host-a");
    manager.addSource(SOURCE_B, "host-b");
    for (const sourceId of [SOURCE_A, SOURCE_B]) {
      addSkill(manager, sourceId, "portable");
      addDirectory(manager, sourceId, "portable/references");
      manager.setFile(sourceId, "portable/references/guide.md", bytes("same guide"));
    }
    const catalog = new SkillCatalog(manager);
    const descriptors = (await catalog.listLive()).skills;
    const first = await catalog.inspectLive({ skillId: descriptors[0]!.skillId });
    const second = await catalog.inspectLive({ skillId: descriptors[1]!.skillId });

    expect(first.descriptor.descriptorFingerprint).toBe(second.descriptor.descriptorFingerprint);
    expect(first.bundleFingerprint).toBe(second.bundleFingerprint);
    expect(first.descriptor.skillId).not.toBe(second.descriptor.skillId);
  });

  it("changes bundle fingerprint when a resource changes while descriptor fingerprint remains stable", async () => {
    const { manager, catalog } = richCatalog();
    const descriptor = (await catalog.listLive()).skills[0]!;
    const before = await catalog.inspectLive({ skillId: descriptor.skillId });
    manager.setFile(SOURCE_A, "bundle/references/guide.md", bytes("changed guide"));
    const after = await catalog.inspectLive({ skillId: descriptor.skillId });

    expect(after.descriptor.descriptorFingerprint).toBe(before.descriptor.descriptorFingerprint);
    expect(after.bundleFingerprint).not.toBe(before.bundleFingerprint);
  });

  it("loads only inventory-member raw resources and detects stale descriptor/bundle fingerprints", async () => {
    const { manager, catalog } = richCatalog();
    const descriptor = (await catalog.listLive()).skills[0]!;
    const inspection = await catalog.inspectLive({ skillId: descriptor.skillId });
    const load = await catalog.loadLiveRaw({
      skillId: descriptor.skillId,
      expectedDescriptorFingerprint: descriptor.descriptorFingerprint,
      expectedBundleFingerprint: inspection.bundleFingerprint,
      resources: ["references/guide.md", "assets/binary.bin"]
    });

    expect(Buffer.from(load.skillDocument).toString("utf8")).toContain("Bundle instructions");
    expect(load.descriptor.compatibility).toMatchObject({ classification: "NATIVE" });
    expect(load.resources.map((resource) => resource.path)).toEqual([
      "assets/binary.bin",
      "references/guide.md"
    ]);
    expect([...load.resources[0]!.bytes]).toEqual([0, 255, 1, 128]);
    expect(Buffer.from(load.resources[1]!.bytes).toString("utf8")).toBe("guide body\n");
    expect(load).not.toHaveProperty("sourceCapabilityId");

    await expect(
      catalog.loadLiveRaw({ skillId: descriptor.skillId, resources: ["../outside"] })
    ).rejects.toMatchObject({ code: "SKILL_RESOURCE_UNSUPPORTED" });
    await expect(
      catalog.loadLiveRaw({ skillId: descriptor.skillId, resources: ["SKILL.md"] })
    ).rejects.toMatchObject({ code: "SKILL_RESOURCE_UNSUPPORTED" });

    const resourceNames = Array.from(
      { length: MAX_LOADED_RESOURCES + 1 },
      (_, index) => `requested-${String(index).padStart(2, "0")}.txt`
    );
    for (const resourceName of resourceNames) {
      manager.setFile(SOURCE_A, `bundle/${resourceName}`, bytes(resourceName));
    }
    await expect(
      catalog.loadLiveRaw({ skillId: descriptor.skillId, resources: resourceNames })
    ).rejects.toMatchObject({ code: "SKILL_LOAD_LIMIT_EXCEEDED" });
    await expect(
      catalog.loadLiveRaw({
        skillId: descriptor.skillId,
        resources: ["references/guide.md", "references/guide.md"]
      })
    ).rejects.toMatchObject({ code: "SKILL_RESOURCE_UNSUPPORTED" });

    await expect(
      catalog.inspectLive({ skillId: descriptor.skillId, expectedDescriptorFingerprint: "0".repeat(64) })
    ).rejects.toMatchObject({ code: "SKILL_FINGERPRINT_MISMATCH" });
    await expect(
      catalog.loadLiveRaw({
        skillId: descriptor.skillId,
        expectedBundleFingerprint: "0".repeat(64)
      })
    ).rejects.toMatchObject({ code: "SKILL_FINGERPRINT_MISMATCH" });

    manager.setFile(SOURCE_A, "bundle/SKILL.md", skillDocument("bundle", "mutated"));
    await expect(
      catalog.inspectLive({
        skillId: descriptor.skillId,
        expectedDescriptorFingerprint: descriptor.descriptorFingerprint
      })
    ).rejects.toMatchObject({ code: "SKILL_FINGERPRINT_MISMATCH" });
  });

  it("rejects symlink/other resources, excessive resources, and aggregate bundles over the hard cap", async () => {
    const symlinkManager = new FakeSourceManager();
    symlinkManager.addSource(SOURCE_A, "symlink");
    addSkill(symlinkManager, SOURCE_A, "unsafe");
    symlinkManager.setEntry(SOURCE_A, {
      path: "unsafe/references-link",
      kind: "symlink",
      sizeBytes: 10
    });
    const symlinkCatalog = new SkillCatalog(symlinkManager);
    const symlinkSkill = (await symlinkCatalog.listLive()).skills[0]!;
    await expect(symlinkCatalog.inspectLive({ skillId: symlinkSkill.skillId })).rejects.toMatchObject({
      code: "SKILL_RESOURCE_UNSUPPORTED"
    });

    const countManager = new FakeSourceManager();
    countManager.addSource(SOURCE_A, "count");
    addSkill(countManager, SOURCE_A, "many");
    for (let index = 0; index <= MAX_RESOURCES_PER_SKILL; index += 1) {
      countManager.setFile(
        SOURCE_A,
        `many/r-${String(index).padStart(3, "0")}.txt`,
        bytes("x")
      );
    }
    const countCatalog = new SkillCatalog(countManager);
    const countSkill = (await countCatalog.listLive()).skills[0]!;
    await expect(countCatalog.inspectLive({ skillId: countSkill.skillId })).rejects.toMatchObject({
      code: "SKILL_LOAD_LIMIT_EXCEEDED"
    });

    const byteManager = new FakeSourceManager();
    byteManager.addSource(SOURCE_A, "bytes");
    addSkill(byteManager, SOURCE_A, "huge");
    byteManager.setFile(
      SOURCE_A,
      "huge/payload.bin",
      new Uint8Array(SKILL_BUNDLE_MAX_BYTES)
    );
    const byteCatalog = new SkillCatalog(byteManager);
    const byteSkill = (await byteCatalog.listLive()).skills[0]!;
    await expect(byteCatalog.inspectLive({ skillId: byteSkill.skillId })).rejects.toMatchObject({
      code: "SKILL_LOAD_LIMIT_EXCEEDED"
    });
  });
});

describe("SkillCatalog pinned snapshots", () => {
  it("keeps an old pin reproducible while live content changes and after the source disappears", async () => {
    const stateRoot = await createSkillTestStateRoot("catalog-pins");
    catalogStateRoots.push(stateRoot);
    const manager = new FakeSourceManager();
    manager.addSource(SOURCE_A, "private-a");
    addSkill(manager, SOURCE_A, "portable", { body: "Read file context, then run tests.\n" });
    addDirectory(manager, SOURCE_A, "portable/references");
    manager.setFile(SOURCE_A, "portable/references/guide.md", bytes("old guide\n"));
    const pins = new SkillPinStore(stateRoot, {
      now: () => new Date("2026-08-12T07:45:00.000Z")
    });
    const catalog = new SkillCatalog(manager, { pins });

    const liveOnly = await catalog.list();
    expect(liveOnly.skills).toHaveLength(1);
    expect(liveOnly.skills[0]).toMatchObject({ availability: "live", pinned: false });

    const pinned = await catalog.pin({ skillId: liveOnly.skills[0]!.skillId });
    const combined = await catalog.list();
    expect(combined.skills).toHaveLength(1);
    expect(combined.skills[0]).toMatchObject({
      skillId: pinned.skillId,
      fingerprint: pinned.fingerprint,
      availability: "live+pinned",
      pinned: true,
      compatibility: { classification: "NATIVE" }
    });

    manager.setFile(SOURCE_A, "portable/references/guide.md", bytes("new guide\n"));
    manager.setFile(
      SOURCE_A,
      "portable/SKILL.md",
      skillDocument("portable", undefined, "Search code for the target, then review diff output.\n")
    );
    const changed = await catalog.list();
    const versions = changed.skills.filter((skill) => skill.skillId === pinned.skillId);
    expect(versions).toHaveLength(2);
    expect(versions.find((skill) => skill.fingerprint === pinned.fingerprint)).toMatchObject({
      availability: "pinned",
      pinned: true
    });
    expect(versions.find((skill) => skill.fingerprint !== pinned.fingerprint)).toMatchObject({
      availability: "live",
      pinned: false
    });

    const currentInspection = await catalog.inspect({ skillId: pinned.skillId });
    expect(currentInspection.skill).toMatchObject({ availability: "live", pinned: false });
    expect(currentInspection.skill.fingerprint).not.toBe(pinned.fingerprint);
    expect(currentInspection.capabilityPlan).toMatchObject({
      classification: currentInspection.skill.compatibility.classification,
      nativeCapabilities: expect.arrayContaining(["code.search", "git.diff"])
    });
    expect(currentInspection.capabilityPlan.nativeCapabilities).not.toContain("file.read");
    const pinnedInspection = await catalog.inspect({
      skillId: pinned.skillId,
      fingerprint: pinned.fingerprint
    });
    expect(pinnedInspection.skill).toMatchObject({
      fingerprint: pinned.fingerprint,
      availability: "pinned",
      pinned: true
    });
    expect(pinnedInspection.capabilityPlan).toMatchObject({
      classification: pinnedInspection.skill.compatibility.classification,
      nativeCapabilities: expect.arrayContaining(["file.read", "verify.run"])
    });
    expect(pinnedInspection.capabilityPlan.nativeCapabilities).not.toContain("code.search");
    await expect(
      catalog.inspect({ skillId: pinned.skillId, fingerprint: "0".repeat(64) })
    ).rejects.toMatchObject({ code: "SKILL_FINGERPRINT_MISMATCH" });

    manager.unavailableSourceIds.add(SOURCE_A);
    const offline = await catalog.list();
    expect(offline.truncated).toBe(true);
    expect(offline.truncationReasons).toContain("SOURCE_UNAVAILABLE");
    expect(offline.skills).toEqual([
      expect.objectContaining({
        skillId: pinned.skillId,
        fingerprint: pinned.fingerprint,
        availability: "pinned",
        pinned: true
      })
    ]);
    const loaded = await catalog.loadRaw({
      skillId: pinned.skillId,
      fingerprint: pinned.fingerprint,
      resources: ["references/guide.md"]
    });
    expect(loaded.availability).toBe("pinned");
    expect(loaded.descriptor.compatibility).toMatchObject({ classification: "NATIVE" });
    expect(Buffer.from(loaded.resources[0]!.bytes).toString("utf8")).toBe("old guide\n");
    expect(JSON.stringify({ offline, loaded: { ...loaded, skillDocument: undefined, resources: [] } })).not.toContain(
      "/private/"
    );
  });

  it("reports source unavailability instead of claiming an unresolved live skill is absent", async () => {
    const manager = new FakeSourceManager();
    manager.addSource(SOURCE_A, "offline-a");
    addSkill(manager, SOURCE_A, "portable");
    const catalog = new SkillCatalog(manager);
    const skillId = (await catalog.list()).skills[0]!.skillId;

    manager.unavailableSourceIds.add(SOURCE_A);

    await expect(catalog.loadRaw({ skillId })).rejects.toMatchObject({
      code: "SKILL_SOURCE_UNAVAILABLE"
    });
  });
});
