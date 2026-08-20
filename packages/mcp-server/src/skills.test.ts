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
const WORKSPACE_ID = "ws_1";
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

function externalCliInspectResult(): SkillInspectResult {
  const result = inspectResult();
  result.skill.compatibility = {
    classification: "PARTIAL",
    requiredCapabilities: [],
    missingCapabilities: ["external-cli:npx"],
    requiredProviders: [],
    reasons: ["EXTERNAL_CLI_REQUIRED:npx"],
    analysisBasis: "static"
  };
  result.capabilityPlan = {
    schemaVersion: 1,
    classification: "PARTIAL",
    nativeCapabilities: [],
    missingCapabilities: ["external-cli:npx"],
    externalRequirements: [],
    blockedSemantics: [],
    guidance: [],
    truncated: false,
    truncationReasons: []
  };
  return result;
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
    expect(required(tools, "skill.list").config.description?.toLowerCase()).toContain("static");
    expect(required(tools, "skill.inspect").config.description?.toLowerCase()).toContain("advisory");
    expect(required(tools, "skill.inspect").config.description?.toLowerCase()).toContain("workspace-aware");
    expect(required(tools, "skill.inspect").config.description?.toLowerCase()).toContain("without executing");
    expect(required(tools, "system.capabilities").config.description?.toLowerCase()).toContain("public mcp");
    expect(required(tools, "skill.load").config.description?.toLowerCase()).toContain("data");
    expect(required(tools, "skill.load").config.description?.toLowerCase()).toContain("not executed");

    const list = required(tools, "skill.list");
    expect(list.config.inputSchema?.limit?.safeParse(500).success).toBe(true);
    expect(list.config.inputSchema?.limit?.safeParse(501).success).toBe(false);
    expect(list.config.inputSchema?.sourceId?.safeParse(SOURCE_ID).success).toBe(true);
    expect(list.config.inputSchema?.sourceId?.safeParse("/private/source").success).toBe(false);
    expect(list.config.inputSchema?.workspaceId?.safeParse(WORKSPACE_ID).success).toBe(true);
    for (const classification of ["NATIVE", "PARTIAL", "PROVIDER_REQUIRED", "UNSUPPORTED"] as const) {
      expect(list.config.inputSchema?.compatibility?.safeParse(classification).success).toBe(true);
    }
    expect(list.config.inputSchema?.compatibility?.safeParse("UNKNOWN").success).toBe(false);
    await list.handler({
      limit: 10,
      sourceId: SOURCE_ID,
      compatibility: "NATIVE",
      pinned: true,
      workspaceId: WORKSPACE_ID
    });

    const inspect = required(tools, "skill.inspect");
    expect(inspect.config.inputSchema?.skillId?.safeParse(SKILL_ID).success).toBe(true);
    expect(inspect.config.inputSchema?.fingerprint?.safeParse(FINGERPRINT).success).toBe(true);
    expect(inspect.config.inputSchema?.workspaceId?.safeParse(WORKSPACE_ID).success).toBe(true);
    await inspect.handler({ skillId: SKILL_ID, fingerprint: FINGERPRINT, workspaceId: WORKSPACE_ID });

    const load = required(tools, "skill.load");
    expect(load.config.inputSchema?.maxBytes?.safeParse(512 * 1024).success).toBe(true);
    expect(load.config.inputSchema?.maxBytes?.safeParse(512 * 1024 + 1).success).toBe(false);
    expect(load.config.inputSchema?.resources?.safeParse(Array.from({ length: 33 }, () => "x")).success).toBe(false);
    expect(load.config.inputSchema?.workspaceId?.safeParse(WORKSPACE_ID).success).toBe(true);
    await load.handler({
      skillId: SKILL_ID,
      fingerprint: FINGERPRINT,
      resources: ["references/guide.md"],
      maxBytes: 1024,
      workspaceId: WORKSPACE_ID
    });

    expect(seen).toContainEqual({
      limit: 10,
      sourceId: SOURCE_ID,
      compatibility: "NATIVE",
      pinned: true,
      workspaceId: WORKSPACE_ID
    });
    expect(seen).toContainEqual({ skillId: SKILL_ID, fingerprint: FINGERPRINT, workspaceId: WORKSPACE_ID });
    expect(seen).toContainEqual({
      skillId: SKILL_ID,
      fingerprint: FINGERPRINT,
      resources: ["references/guide.md"],
      maxBytes: 1024,
      workspaceId: WORKSPACE_ID
    });
  });

  it("resolves external CLI requirements against an explicitly supplied READY workspace", async () => {
    let probes = 0;
    let readyChecks = 0;
    const catalogInputs: unknown[] = [];
    const skillCatalog: SkillCatalogToolAdapter = {
      list: async () => listResult(),
      inspect: async (input) => {
        catalogInputs.push(input);
        return externalCliInspectResult();
      },
      load: async () => loadResult()
    };
    const context = createKodegptToolContext({
      workspaceManager: {
        requireReady(workspaceId: string) {
          readyChecks += 1;
          expect(workspaceId).toBe(WORKSPACE_ID);
          return {
            effectivePolicy: {
              name: "trusted",
              allowWrite: true,
              allowProcess: true,
              network: "unrestricted",
              allowedExecutableNames: ["npx"],
              inheritEnv: false,
              envAllowlist: []
            }
          };
        },
        async inspectExecutable(workspaceId: string, executable: string) {
          probes += 1;
          expect(workspaceId).toBe(WORKSPACE_ID);
          expect(executable).toBe("npx");
          return { schemaVersion: 1, executableAvailable: true, sandboxAvailable: true };
        }
      } as never,
      executionManager: {} as never,
      artifactStore: {} as never,
      extensionRegistry: {} as never,
      skillCatalog,
      inspectProfile: () => ({}),
      capabilities: () => ({}),
      health: () => ({})
    });

    const resolved = await context.skill.inspect({
      skillId: SKILL_ID,
      fingerprint: FINGERPRINT,
      workspaceId: WORKSPACE_ID
    });

    expect(readyChecks).toBe(1);
    expect(probes).toBe(1);
    expect(catalogInputs[0]).toEqual({
      skillId: SKILL_ID,
      fingerprint: FINGERPRINT,
      workspaceId: WORKSPACE_ID
    });
    expect(resolved.skill.compatibility.classification).toBe("PARTIAL");
    expect(resolved.capabilityPlan.classification).toBe("NATIVE");
    expect(resolved.capabilityPlan.missingCapabilities).toEqual([]);
    expect(resolved.capabilityPlan.nativeCapabilities).toContain("process.run");
    expect(resolved.capabilityPlan.externalCliRequirements).toEqual([
      {
        requirement: "external-cli:npx",
        executable: "npx",
        status: "available",
        capability: "process.run"
      }
    ]);

    const generic = await context.skill.inspect({ skillId: SKILL_ID, fingerprint: FINGERPRINT });
    expect(readyChecks).toBe(1);
    expect(probes).toBe(1);
    expect(catalogInputs[1]).toEqual({ skillId: SKILL_ID, fingerprint: FINGERPRINT });
    expect(generic.capabilityPlan.classification).toBe("PARTIAL");
    expect(generic.capabilityPlan.externalCliRequirements).toBeUndefined();
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

  it("serializes provider requirements as advisory data without provider authority", async () => {
    const providerInspect = inspectResult();
    providerInspect.skill.compatibility = {
      classification: "PROVIDER_REQUIRED",
      requiredCapabilities: [],
      missingCapabilities: [],
      requiredProviders: ["github"],
      reasons: ["PROVIDER_REQUIRED:github"],
      analysisBasis: "declared"
    };
    providerInspect.capabilityPlan = {
      schemaVersion: 1,
      classification: "PROVIDER_REQUIRED",
      nativeCapabilities: [],
      missingCapabilities: [],
      externalRequirements: ["provider:github"],
      blockedSemantics: [],
      guidance: [],
      truncated: false,
      truncationReasons: []
    };
    const tools = capture({
      list: async () => listResult(),
      inspect: async () => providerInspect,
      load: async () => loadResult()
    });

    const inspected = await required(tools, "skill.inspect").handler({
      skillId: SKILL_ID,
      fingerprint: FINGERPRINT
    });
    const serialized = JSON.stringify(inspected);
    expect(serialized).toContain("provider:github");
    for (const forbidden of [
      "providerInstanceId",
      "credentialBroker",
      "helperPath",
      "provider.invoke",
      '"invoke"'
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(listSurfaceTools().map(({ name }) => name)).not.toContain("provider.invoke");
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
