import { describe, expect, it, vi } from "vitest";

import {
  getPublicActionDescriptor,
  searchPublicActions,
  type PublicActionId
} from "@kodegpt/capabilities";
import {
  rankSkillsForQuery,
  type SkillCatalogEntry,
  type SkillInspectResult,
  type SkillListResult
} from "@kodegpt/skills";

import {
  SYSTEM_DISCOVER_MAX_FLOWS,
  SYSTEM_DISCOVER_MAX_SKILL_INSPECTIONS,
  discoverKodegpt,
  type SystemDiscoverDependencies
} from "./discovery.js";

const GLOBAL_SOURCE = `ss_${"1".repeat(32)}`;
const LOCAL_SOURCE = `ss_${"2".repeat(32)}`;
const ALT_SOURCE = `ss_${"3".repeat(32)}`;
const WORKSPACE_ID = "ws_ready";

const nativeCompatibility = {
  classification: "NATIVE" as const,
  requiredCapabilities: [],
  missingCapabilities: [],
  requiredProviders: [],
  reasons: ["NATIVE_REQUIREMENTS_SATISFIED"],
  analysisBasis: "static" as const
};

function skillEntry(overrides: Partial<SkillCatalogEntry> = {}): SkillCatalogEntry {
  return {
    skillId: `sk_${"a".repeat(64)}`,
    name: "kodegpt-application-development-workflow",
    description: "Application development workflow from repository understanding through verified PR and CI evidence.",
    sourceId: GLOBAL_SOURCE,
    sourceKind: "agent-skills",
    fingerprint: "b".repeat(64),
    descriptorFingerprint: "c".repeat(64),
    nameCollision: false,
    compatibility: nativeCompatibility,
    availability: "live",
    pinned: false,
    ...overrides
  };
}

function listResult(skills: SkillCatalogEntry[], truncated = false): SkillListResult {
  return {
    schemaVersion: 1,
    skills,
    truncated,
    truncationReasons: truncated ? ["SOURCE_UNAVAILABLE"] : []
  };
}

function inspection(
  skill: SkillCatalogEntry,
  stages: Array<{ id: string; description?: string; actionIds: PublicActionId[] }> = []
): SkillInspectResult {
  return {
    schemaVersion: 1,
    skill,
    capabilityPlan: {
      schemaVersion: 1,
      classification: skill.compatibility.classification,
      nativeCapabilities: [],
      missingCapabilities: [],
      externalRequirements: [],
      blockedSemantics: [],
      guidance: [],
      truncated: false,
      truncationReasons: []
    },
    requirementGraph: {
      schemaVersion: 1,
      core: {
        classification: skill.compatibility.classification,
        actions: [],
        inferredActions: [],
        missingActions: []
      },
      stages: stages.map((stage) => ({
        id: stage.id,
        ...(stage.description === undefined ? {} : { description: stage.description }),
        classification: "NATIVE" as const,
        actions: stage.actionIds.map((id) => ({ id, known: true as const, source: "declared" as const })),
        missingActions: [],
        requiredCapabilities: [],
        requiredProviders: []
      })),
      analysisBasis: stages.length > 0 ? "declared" : "static",
      truncated: false,
      truncationReasons: []
    },
    frontmatter: { unknownMetadataKeys: [] },
    resources: [],
    instructionBytes: 64,
    bundleBytes: 64
  };
}

function baseDeps(overrides: Partial<SystemDiscoverDependencies> = {}): SystemDiscoverDependencies {
  const workflow = skillEntry();
  return {
    searchActions: (query, options) => searchPublicActions(query, options),
    rankSkills: (skills, query, options) => rankSkillsForQuery(skills, query, options),
    listSkills: async ({ workspaceId }) =>
      workspaceId === undefined ? listResult([workflow]) : listResult([workflow]),
    inspectSkill: async ({ skillId }) => {
      if (skillId !== workflow.skillId) throw new Error("unknown skill");
      return inspection(workflow, [
        {
          id: "visual",
          description: "Gather responsive visual evidence.",
          actionIds: ["visual.captureMatrix", "visual.compare"]
        }
      ]);
    },
    workspaceInfo: async ({ workspaceId }) => ({
      id: workspaceId,
      canonicalRoot: "/redacted/workspace",
      effectivePolicy: {
        allowRead: true,
        allowWrite: true,
        allowGit: true,
        allowProcess: true,
        allowDynamicExecutables: true,
        allowedExecutableNames: []
      }
    } as never),
    ...overrides
  };
}

describe("discoverKodegpt", () => {
  it("returns ranked actions, ranked skills, match reasons, and explicit stage-derived flows", async () => {
    const result = await discoverKodegpt(
      { query: "application development check responsive UI screenshots", workspaceId: WORKSPACE_ID, limit: 8 },
      baseDeps()
    );

    expect(result.schemaVersion).toBe(1);
    expect(result.actions.slice(0, 3).map((match) => match.id)).toContain("visual.captureMatrix");
    expect(result.actions[0]?.matchReasons.length).toBeGreaterThan(0);
    expect(result.skills[0]?.name).toBe("kodegpt-application-development-workflow");
    expect(result.skills[0]?.matchReasons.length).toBeGreaterThan(0);
    expect(result.skills[0]?.matchedStages?.map((stage) => stage.id)).toContain("visual");
    expect(result.flows).toContainEqual({
      source: "skill-stage",
      skillId: result.skills[0]!.skillId,
      skillName: "kodegpt-application-development-workflow",
      stageId: "visual",
      description: "Gather responsive visual evidence.",
      actionIds: ["visual.captureMatrix", "visual.compare"]
    });
  });

  it("groups exact name+fingerprint duplicates, prefers the matching workspace-local copy, and bounds alternate provenance", async () => {
    const global = skillEntry({ skillId: `sk_${"1".repeat(64)}`, sourceId: GLOBAL_SOURCE });
    const local = skillEntry({ skillId: `sk_${"2".repeat(64)}`, sourceId: LOCAL_SOURCE });
    const alternates = Array.from({ length: 7 }, (_, index) =>
      skillEntry({
        skillId: `sk_${String(index + 3).repeat(64)}`.slice(0, 67),
        sourceId: `ss_${String(index + 4).repeat(32)}`.slice(0, 35)
      })
    );
    const scoped = [global, local, ...alternates];
    const deps = baseDeps({
      listSkills: vi.fn(async ({ workspaceId }) =>
        workspaceId === undefined ? listResult([global, ...alternates]) : listResult(scoped)
      ),
      inspectSkill: vi.fn(async ({ skillId }) => inspection(scoped.find((item) => item.skillId === skillId)!))
    });

    const result = await discoverKodegpt(
      { query: "application development", workspaceId: WORKSPACE_ID, limit: 8 },
      deps
    );

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.skillId).toBe(local.skillId);
    expect(result.skills[0]?.sourceId).toBe(LOCAL_SOURCE);
    expect(result.skills[0]?.alternateSources).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(result.truncationReasons).toContain("ALTERNATE_SOURCE_LIMIT");
  });

  it("prefers pinned duplicate provenance without workspace context and keeps same-name different fingerprints separate", async () => {
    const live = skillEntry({ skillId: `sk_${"4".repeat(64)}`, sourceId: GLOBAL_SOURCE });
    const pinned = skillEntry({
      skillId: `sk_${"5".repeat(64)}`,
      sourceId: ALT_SOURCE,
      pinned: true,
      availability: "live+pinned"
    });
    const otherVersion = skillEntry({
      skillId: `sk_${"6".repeat(64)}`,
      sourceId: `ss_${"6".repeat(32)}`,
      fingerprint: "d".repeat(64)
    });
    const deps = baseDeps({
      listSkills: vi.fn(async () => listResult([live, pinned, otherVersion])),
      inspectSkill: vi.fn(async ({ skillId }) =>
        inspection([live, pinned, otherVersion].find((item) => item.skillId === skillId)!)
      )
    });

    const result = await discoverKodegpt({ query: "application development", limit: 8 }, deps);

    expect(result.skills).toHaveLength(2);
    const sameFingerprint = result.skills.find((item) => item.fingerprint === live.fingerprint)!;
    expect(sameFingerprint.skillId).toBe(pinned.skillId);
    expect(sameFingerprint.alternateSources).toContainEqual({
      skillId: live.skillId,
      sourceId: live.sourceId
    });
    expect(result.skills.some((item) => item.fingerprint === otherVersion.fingerprint)).toBe(true);
  });

  it("inspects at most five ranked skill representatives and returns at most five explicit stage flows", async () => {
    const skills = Array.from({ length: 8 }, (_, index) =>
      skillEntry({
        skillId: `sk_${String(index + 1).repeat(64)}`.slice(0, 67),
        name: `workflow-${index}`,
        description: "visual workflow application development",
        sourceId: `ss_${String(index + 1).repeat(32)}`.slice(0, 35),
        fingerprint: String(index + 1).repeat(64)
      })
    );
    const inspectSkill = vi.fn(async ({ skillId }: { skillId: string }) =>
      inspection(skills.find((item) => item.skillId === skillId)!, [
        {
          id: "visual",
          actionIds: ["visual.captureMatrix", "visual.compare"]
        },
        {
          id: "browser",
          actionIds: ["browser.inspect"]
        }
      ])
    );
    const deps = baseDeps({
      listSkills: vi.fn(async () => listResult(skills)),
      inspectSkill
    });

    const result = await discoverKodegpt({ query: "visual browser workflow", limit: 20 }, deps);

    expect(inspectSkill).toHaveBeenCalledTimes(SYSTEM_DISCOVER_MAX_SKILL_INSPECTIONS);
    expect(result.flows.length).toBeLessThanOrEqual(SYSTEM_DISCOVER_MAX_FLOWS);
    expect(result.truncated).toBe(true);
    expect(result.truncationReasons).toContain("SKILL_INSPECTION_LIMIT");
    expect(result.truncationReasons).toContain("FLOW_LIMIT");
    for (const flow of result.flows) expect(flow.source).toBe("skill-stage");
  });

  it("marks workspace-scoped actions context-required without workspace and unavailable for an invalid supplied workspace", async () => {
    const withoutWorkspace = await discoverKodegpt(
      { query: "continue previous work", limit: 8 },
      baseDeps()
    );
    const workspaceInfo = vi.fn(async () => {
      throw new Error("/private/path must not leak");
    });
    const invalidWorkspace = await discoverKodegpt(
      { query: "continue previous work", workspaceId: "ws_missing", limit: 8 },
      baseDeps({ workspaceInfo })
    );

    const noContext = withoutWorkspace.actions.find((item) => item.id === "workspace.info")!;
    expect(noContext.availability).toEqual({
      status: "CONTEXT_REQUIRED",
      reasons: ["WORKSPACE_REQUIRED"]
    });
    const unavailable = invalidWorkspace.actions.find((item) => item.id === "workspace.info")!;
    expect(unavailable.availability).toEqual({
      status: "UNAVAILABLE",
      reasons: ["WORKSPACE_UNAVAILABLE"]
    });
    expect(workspaceInfo).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(invalidWorkspace)).not.toContain("/private/path");
  });

  it("never invokes undeclared mutation, process, browser, GitHub, CI, or provider dependencies", async () => {
    const forbidden = {
      processRun: vi.fn(() => { throw new Error("MUST NOT CALL"); }),
      fileWrite: vi.fn(() => { throw new Error("MUST NOT CALL"); }),
      checkpoint: vi.fn(() => { throw new Error("MUST NOT CALL"); }),
      previewStart: vi.fn(() => { throw new Error("MUST NOT CALL"); }),
      browserOpen: vi.fn(() => { throw new Error("MUST NOT CALL"); }),
      github: vi.fn(() => { throw new Error("MUST NOT CALL"); }),
      ci: vi.fn(() => { throw new Error("MUST NOT CALL"); }),
      provider: vi.fn(() => { throw new Error("MUST NOT CALL"); })
    };
    const deps = Object.assign(baseDeps(), forbidden);

    await discoverKodegpt({ query: "create a pull request", limit: 8 }, deps);

    for (const fn of Object.values(forbidden)) expect(fn).not.toHaveBeenCalled();
  });

  it("returns registered global/repository actions as available without probing remote providers", async () => {
    const result = await discoverKodegpt({ query: "why ci failed", limit: 8 }, baseDeps());
    const failure = result.actions.find((item) => item.id === "ci.failure")!;
    const descriptor = getPublicActionDescriptor("ci.failure");

    expect(descriptor.scope).toBe("repository");
    expect(failure.availability).toEqual({ status: "AVAILABLE", reasons: [] });
    expect(failure.requiredInputs).toEqual(["runId"]);
  });
});
