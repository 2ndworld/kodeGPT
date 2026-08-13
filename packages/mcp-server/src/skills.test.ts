import type { McpServer } from "@modelcontextprotocol/server";
import {
  SkillError,
  type SkillCatalogEntry,
  type SkillCatalogToolAdapter,
  type SkillInspectResult,
  type SkillListResult,
  type SkillLoadResult
} from "@kodegpt/skills";
import { describe, expect, it } from "vitest";

import { READ_ONLY_TOOL_ANNOTATIONS } from "./annotations.js";
import { createKodegptToolContext, type KodegptToolContext } from "./tool-context.js";
import { listSurfaceTools, registerKodegptTools } from "./tools.js";

const READ_ONLY_SKILL_TOOLS = ["skill.list", "skill.inspect", "skill.load"];
const FORBIDDEN_SKILL_TOOLS = ["skill.run", "skill.pin", "skill.unpin", "skill.source.add", "skill.source.remove"];
const SOURCE_ID = `ss_${"a".repeat(32)}`;
const SKILL_ID = `sk_${"b".repeat(64)}`;
const FINGERPRINT = "c".repeat(64);
const HOST_ROOT = "/private/skill-source";

type Handler = (input: Record<string, unknown>) => Promise<unknown>;
interface Registration {
  config: {
    description?: string;
    inputSchema?: Record<string, { safeParse(value: unknown): { success: boolean } }>;
    annotations?: unknown;
  };
  handler: Handler;
}

function entry(): SkillCatalogEntry {
  return {
    skillId: SKILL_ID,
    name: "portable",
    description: "Portable skill",
    sourceId: SOURCE_ID,
    sourceKind: "agent-skills",
    fingerprint: FINGERPRINT,
    descriptorFingerprint: "d".repeat(64),
    nameCollision: false,
    compatibility: {
      classification: "NATIVE",
      requiredCapabilities: ["file.read"],
      missingCapabilities: [],
      requiredProviders: [],
      reasons: ["NATIVE_REQUIREMENTS_SATISFIED"],
      analysisBasis: "static"
    },
    availability: "live+pinned",
    pinned: true
  };
}

function listResult(): SkillListResult {
  return { schemaVersion: 1, skills: [entry()], truncated: false, truncationReasons: [] };
}

function inspectResult(): SkillInspectResult {
  return {
    schemaVersion: 1,
    skill: entry(),
    capabilityPlan: {
      schemaVersion: 1,
      classification: "NATIVE",
      nativeCapabilities: ["git.status"],
      missingCapabilities: [],
      externalRequirements: [],
      blockedSemantics: [],
      guidance: [{ capability: "git.status", purpose: "Inspect repository status without mutation." }],
      truncated: false,
      truncationReasons: []
    },
    frontmatter: { unknownMetadataKeys: [] },
    resources: [{ path: "references/guide.md", bytes: 6, sha256: "e".repeat(64), kind: "text", textInlineEligible: true }],
    instructionBytes: 24,
    bundleBytes: 128
  };
}

function loadResult(): SkillLoadResult {
  return {
    schemaVersion: 1,
    skillId: SKILL_ID,
    name: "portable",
    description: "Portable skill",
    sourceId: SOURCE_ID,
    sourceKind: "agent-skills",
    fingerprint: FINGERPRINT,
    availability: "live+pinned",
    pinned: true,
    compatibility: entry().compatibility,
    instructions: "Use the safe workflow.\n",
    resources: [{ path: "references/guide.md", contents: "guide\n", bytes: 6, sha256: "e".repeat(64) }],
    totalBytes: 29
  };
}

function capture(skill: SkillCatalogToolAdapter): Map<string, Registration> {
  const registrations = new Map<string, Registration>();
  const server = {
    registerTool(name: string, config: Registration["config"], handler: Handler) {
      registrations.set(name, { config, handler });
    }
  } as unknown as McpServer;
  registerKodegptTools(server, { skill } as unknown as KodegptToolContext);
  return registrations;
}

function required(map: Map<string, Registration>, name: string): Registration {
  const value = map.get(name);
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}

describe("MCP skill surface", () => {
  it("exposes exactly three read-only skill tools and no mutation/execution tools", () => {
    const names = listSurfaceTools().map(({ name }) => name).filter((name) => name.startsWith("skill."));
    expect(names).toEqual(READ_ONLY_SKILL_TOOLS);
    for (const forbidden of FORBIDDEN_SKILL_TOOLS) expect(names).not.toContain(forbidden);
  });

  it("registers bounded schemas and forwards expected fingerprints", async () => {
    const seen: Record<string, unknown>[] = [];
    const tools = capture({
      list: async (input) => { seen.push(input); return listResult(); },
      inspect: async (input) => { seen.push(input); return inspectResult(); },
      load: async (input) => { seen.push(input); return loadResult(); }
    });
    for (const name of READ_ONLY_SKILL_TOOLS) {
      expect(required(tools, name).config.annotations).toEqual(READ_ONLY_TOOL_ANNOTATIONS);
    }
    expect(required(tools, "skill.inspect").config.description?.toLowerCase()).toContain("advisory");
    expect(required(tools, "skill.inspect").config.description?.toLowerCase()).toContain("native capabilities");
    expect(required(tools, "skill.load").config.description?.toLowerCase()).toContain("data");
    expect(required(tools, "skill.load").config.description?.toLowerCase()).toContain("not executed");

    const list = required(tools, "skill.list");
    expect(list.config.inputSchema?.limit?.safeParse(500).success).toBe(true);
    expect(list.config.inputSchema?.limit?.safeParse(501).success).toBe(false);
    expect(list.config.inputSchema?.sourceId?.safeParse(SOURCE_ID).success).toBe(true);
    expect(list.config.inputSchema?.sourceId?.safeParse("/private/source").success).toBe(false);
    for (const classification of ["NATIVE", "PARTIAL", "PROVIDER_REQUIRED", "UNSUPPORTED"] as const) {
      expect(list.config.inputSchema?.compatibility?.safeParse(classification).success).toBe(true);
    }
    expect(list.config.inputSchema?.compatibility?.safeParse("UNKNOWN").success).toBe(false);
    await list.handler({ limit: 10, sourceId: SOURCE_ID, compatibility: "NATIVE", pinned: true });

    const inspect = required(tools, "skill.inspect");
    expect(inspect.config.inputSchema?.skillId?.safeParse(SKILL_ID).success).toBe(true);
    expect(inspect.config.inputSchema?.fingerprint?.safeParse(FINGERPRINT).success).toBe(true);
    await inspect.handler({ skillId: SKILL_ID, fingerprint: FINGERPRINT });

    const load = required(tools, "skill.load");
    expect(load.config.inputSchema?.maxBytes?.safeParse(512 * 1024).success).toBe(true);
    expect(load.config.inputSchema?.maxBytes?.safeParse(512 * 1024 + 1).success).toBe(false);
    expect(load.config.inputSchema?.resources?.safeParse(Array.from({ length: 33 }, () => "x")).success).toBe(false);
    await load.handler({ skillId: SKILL_ID, fingerprint: FINGERPRINT, resources: ["references/guide.md"], maxBytes: 1024 });

    expect(seen).toContainEqual({ limit: 10, sourceId: SOURCE_ID, compatibility: "NATIVE", pinned: true });
    expect(seen).toContainEqual({ skillId: SKILL_ID, fingerprint: FINGERPRINT });
    expect(seen).toContainEqual({ skillId: SKILL_ID, fingerprint: FINGERPRINT, resources: ["references/guide.md"], maxBytes: 1024 });
  });

  it("returns structured host-path-free results", async () => {
    const tools = capture({ list: async () => listResult(), inspect: async () => inspectResult(), load: async () => loadResult() });
    for (const name of READ_ONLY_SKILL_TOOLS) {
      const result = await required(tools, name).handler(name === "skill.list" ? {} : { skillId: SKILL_ID, fingerprint: FINGERPRINT });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(HOST_ROOT);
      expect(serialized).not.toContain("canonicalRoot");
      expect(result).toHaveProperty("structuredContent");
    }

    const inspected = (await required(tools, "skill.inspect").handler({
      skillId: SKILL_ID,
      fingerprint: FINGERPRINT
    })) as {
      content: Array<{ type: "text"; text: string }>;
      structuredContent: SkillInspectResult;
    };
    expect(inspected.structuredContent.capabilityPlan).toMatchObject({
      schemaVersion: 1,
      classification: "NATIVE",
      nativeCapabilities: ["git.status"],
      missingCapabilities: [],
      externalRequirements: [],
      blockedSemantics: [],
      guidance: [{ capability: "git.status", purpose: expect.any(String) }],
      truncated: false,
      truncationReasons: []
    });
    expect(JSON.parse(inspected.content[0]!.text)).toEqual(inspected.structuredContent);
  });

  it("maps SkillError to a stable code without exposing a host-looking error message", async () => {
    const tools = capture({
      list: async () => listResult(),
      inspect: async () => inspectResult(),
      load: async () => { throw new SkillError("SKILL_SOURCE_UNAVAILABLE", `failed at ${HOST_ROOT}`); }
    });
    await expect(required(tools, "skill.load").handler({ skillId: SKILL_ID })).rejects.toThrow("SKILL_SOURCE_UNAVAILABLE");
    await expect(required(tools, "skill.load").handler({ skillId: SKILL_ID })).rejects.not.toThrow(HOST_ROOT);
  });

  it("maps unexpected errors fail-closed without exposing their raw message", async () => {
    const tools = capture({
      list: async () => listResult(),
      inspect: async () => inspectResult(),
      load: async () => { throw new Error(`unexpected ${HOST_ROOT}`); }
    });

    await expect(required(tools, "skill.load").handler({ skillId: SKILL_ID })).rejects.toThrow(
      "SKILL_SOURCE_UNAVAILABLE"
    );
    await expect(required(tools, "skill.load").handler({ skillId: SKILL_ID })).rejects.not.toThrow(HOST_ROOT);
  });

  it("fails closed with a typed stable skill error when no production catalog is wired yet", async () => {
    const context = createKodegptToolContext({
      workspaceManager: {} as never,
      executionManager: {} as never,
      artifactStore: {} as never,
      extensionRegistry: {} as never,
      inspectProfile: () => ({}),
      capabilities: () => ({}),
      health: () => ({})
    });

    await expect(context.skill.list({})).rejects.toMatchObject({
      name: "SkillError",
      code: "SKILL_SOURCE_UNAVAILABLE"
    });
  });
});
