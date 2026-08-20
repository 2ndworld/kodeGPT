import { Buffer } from "node:buffer";

import {
  type PublicActionId,
  type PublicActionRole,
  type PublicActionSearchMatch
} from "@kodegpt/capabilities";
import {
  SKILL_TOOL_LIST_MAX,
  type SkillCatalogEntry,
  type SkillCompatibility,
  type SkillInspectResult,
  type SkillListResult,
  type SkillSearchMatch,
  type SkillSearchOptions
} from "@kodegpt/skills";
import type { WorkspaceInfo } from "../../core/src/index.js";

export const SYSTEM_DISCOVER_DEFAULT_LIMIT = 8;
export const SYSTEM_DISCOVER_MAX_LIMIT = 20;
export const SYSTEM_DISCOVER_MAX_QUERY_BYTES = 512;
export const SYSTEM_DISCOVER_MAX_SKILL_INSPECTIONS = 5;
export const SYSTEM_DISCOVER_MAX_FLOWS = 5;
export const SYSTEM_DISCOVER_MAX_MATCH_REASONS = 8;
export const SYSTEM_DISCOVER_MAX_ALTERNATE_SOURCES = 5;

export interface SystemDiscoverInput {
  readonly query: string;
  readonly workspaceId?: string;
  readonly limit?: number;
}

export type SystemDiscoverAvailabilityStatus = "AVAILABLE" | "CONTEXT_REQUIRED" | "UNAVAILABLE";

export interface SystemDiscoverActionMatch {
  readonly id: PublicActionId;
  readonly family: string;
  readonly purpose: string;
  readonly role: PublicActionRole;
  readonly score: number;
  readonly matchReasons: readonly string[];
  readonly requiredInputs: readonly string[];
  readonly availability: {
    readonly status: SystemDiscoverAvailabilityStatus;
    readonly reasons: readonly string[];
  };
}

export interface SystemDiscoverMatchedStage {
  readonly id: string;
  readonly classification: SkillCompatibility;
  readonly actionIds: readonly PublicActionId[];
}

export interface SystemDiscoverSkillMatch {
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
  readonly sourceId: string;
  readonly fingerprint: string;
  readonly compatibility: SkillCompatibility;
  readonly score: number;
  readonly matchReasons: readonly string[];
  readonly alternateSources?: readonly { readonly skillId: string; readonly sourceId: string }[];
  readonly matchedStages?: readonly SystemDiscoverMatchedStage[];
}

export interface SystemDiscoverFlow {
  readonly source: "skill-stage";
  readonly skillId: string;
  readonly skillName: string;
  readonly stageId: string;
  readonly description?: string;
  readonly actionIds: readonly PublicActionId[];
}

export interface SystemDiscoverResult {
  readonly schemaVersion: 1;
  readonly query: string;
  readonly actions: readonly SystemDiscoverActionMatch[];
  readonly skills: readonly SystemDiscoverSkillMatch[];
  readonly flows: readonly SystemDiscoverFlow[];
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
}

export interface SystemDiscoverDependencies {
  readonly searchActions: (query: string, options?: { limit?: number }) => readonly PublicActionSearchMatch[];
  readonly rankSkills: (
    skills: readonly SkillCatalogEntry[],
    query: string,
    options?: SkillSearchOptions
  ) => readonly SkillSearchMatch[];
  readonly listSkills: (input: { limit?: number; workspaceId?: string }) => Promise<SkillListResult>;
  readonly inspectSkill: (input: {
    skillId: string;
    fingerprint?: string;
    workspaceId?: string;
  }) => Promise<SkillInspectResult>;
  readonly workspaceInfo: (input: { workspaceId: string }) => Promise<WorkspaceInfo>;
}

type WorkspaceReadiness = "absent" | "ready" | "unavailable";
type RankedGroup = { representative: SkillSearchMatch; members: readonly SkillSearchMatch[] };
type RankedFlow = {
  readonly score: number;
  readonly skillOrder: number;
  readonly stageId: string;
  readonly flow: SystemDiscoverFlow;
};

const DISCOVERY_TRUNCATION_ORDER = [
  "SOURCE_UNAVAILABLE",
  "SOURCE_ENTRY_LIMIT",
  "SKILL_COUNT_LIMIT",
  "DESCRIPTOR_SIZE_LIMIT",
  "ACTION_LIMIT",
  "SKILL_LIMIT",
  "ALTERNATE_SOURCE_LIMIT",
  "SKILL_INSPECTION_LIMIT",
  "SKILL_INSPECTION_UNAVAILABLE",
  "FLOW_LIMIT"
] as const;

export async function discoverKodegpt(
  input: SystemDiscoverInput,
  deps: SystemDiscoverDependencies
): Promise<SystemDiscoverResult> {
  const query = requireQuery(input.query);
  const limit = requireLimit(input.limit);
  const truncationReasons = new Set<string>();
  const workspaceReadiness = await readWorkspaceReadiness(input.workspaceId, deps);

  const actionMatches = deps.searchActions(query, { limit: SYSTEM_DISCOVER_MAX_LIMIT });
  if (actionMatches.length > limit) truncationReasons.add("ACTION_LIMIT");

  const globalSkills = await safeListSkills(deps, { limit: SKILL_TOOL_LIST_MAX }, truncationReasons);
  let candidateSkills = globalSkills.skills;
  let workspaceSourceIds = new Set<string>();

  if (input.workspaceId !== undefined && workspaceReadiness === "ready") {
    const scopedSkills = await safeListSkills(
      deps,
      { limit: SKILL_TOOL_LIST_MAX, workspaceId: input.workspaceId },
      truncationReasons
    );
    candidateSkills = scopedSkills.skills;
    const globalSourceIds = new Set(globalSkills.skills.map((skill) => skill.sourceId));
    workspaceSourceIds = new Set(
      candidateSkills
        .map((skill) => skill.sourceId)
        .filter((sourceId) => !globalSourceIds.has(sourceId))
    );
  }

  const rankedSkills = deps.rankSkills(candidateSkills, query, { workspaceSourceIds });
  const groupedSkills = groupRankedSkills(rankedSkills, workspaceSourceIds, truncationReasons);
  if (groupedSkills.length > limit) truncationReasons.add("SKILL_LIMIT");
  const visibleGroups = groupedSkills.slice(0, limit);

  const actionScoreById = new Map(actionMatches.map((match) => [match.action.id, match.score]));
  const actionIdSet = new Set(actionMatches.map((match) => match.action.id));
  const inspectedGroupCount = Math.min(visibleGroups.length, SYSTEM_DISCOVER_MAX_SKILL_INSPECTIONS);
  if (visibleGroups.length > SYSTEM_DISCOVER_MAX_SKILL_INSPECTIONS) {
    truncationReasons.add("SKILL_INSPECTION_LIMIT");
  }

  const matchedStagesBySkill = new Map<string, SystemDiscoverMatchedStage[]>();
  const rankedFlows: RankedFlow[] = [];
  for (let index = 0; index < inspectedGroupCount; index += 1) {
    const group = visibleGroups[index]!;
    const selected = group.representative.skill;
    let inspected: SkillInspectResult;
    try {
      inspected = await deps.inspectSkill({
        skillId: selected.skillId,
        fingerprint: selected.fingerprint,
        ...(input.workspaceId === undefined || workspaceReadiness !== "ready"
          ? {}
          : { workspaceId: input.workspaceId })
      });
    } catch {
      truncationReasons.add("SKILL_INSPECTION_UNAVAILABLE");
      continue;
    }

    const stageEvidence = matchedStageEvidence(inspected, query, actionIdSet, actionScoreById);
    if (stageEvidence.length === 0) continue;
    matchedStagesBySkill.set(
      selected.skillId,
      stageEvidence.map(({ stage }) => stage)
    );
    for (const evidence of stageEvidence) {
      rankedFlows.push({
        score: evidence.score,
        skillOrder: index,
        stageId: evidence.stage.id,
        flow: evidence.flow
      });
    }
  }

  rankedFlows.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if (left.skillOrder !== right.skillOrder) return left.skillOrder - right.skillOrder;
    return compareUtf8(left.stageId, right.stageId);
  });
  if (rankedFlows.length > SYSTEM_DISCOVER_MAX_FLOWS) truncationReasons.add("FLOW_LIMIT");

  const actions = Object.freeze(
    actionMatches.slice(0, limit).map((match) =>
      toActionResult(match, input.workspaceId, workspaceReadiness)
    )
  );
  const skills = Object.freeze(
    visibleGroups.map((group) =>
      toSkillResult(group, matchedStagesBySkill.get(group.representative.skill.skillId))
    )
  );
  const flows = Object.freeze(
    rankedFlows.slice(0, SYSTEM_DISCOVER_MAX_FLOWS).map((item) => item.flow)
  );
  const orderedTruncationReasons = Object.freeze(orderTruncationReasons(truncationReasons));

  return Object.freeze({
    schemaVersion: 1 as const,
    query,
    actions,
    skills,
    flows,
    truncated: orderedTruncationReasons.length > 0,
    truncationReasons: orderedTruncationReasons
  });
}

function requireQuery(value: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, "utf8") > SYSTEM_DISCOVER_MAX_QUERY_BYTES
  ) {
    throw new RangeError("Discovery query must be between 1 and 512 UTF-8 bytes");
  }
  return normalized;
}

function requireLimit(value: number | undefined): number {
  const limit = value ?? SYSTEM_DISCOVER_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SYSTEM_DISCOVER_MAX_LIMIT) {
    throw new RangeError("Discovery limit must be between 1 and 20");
  }
  return limit;
}

async function readWorkspaceReadiness(
  workspaceId: string | undefined,
  deps: SystemDiscoverDependencies
): Promise<WorkspaceReadiness> {
  if (workspaceId === undefined) return "absent";
  try {
    await deps.workspaceInfo({ workspaceId });
    return "ready";
  } catch {
    return "unavailable";
  }
}

async function safeListSkills(
  deps: SystemDiscoverDependencies,
  input: { limit: number; workspaceId?: string },
  truncationReasons: Set<string>
): Promise<SkillListResult> {
  try {
    const result = await deps.listSkills(input);
    if (result.truncated) {
      for (const reason of result.truncationReasons) truncationReasons.add(reason);
    }
    return result;
  } catch {
    truncationReasons.add("SOURCE_UNAVAILABLE");
    return {
      schemaVersion: 1,
      skills: [],
      truncated: true,
      truncationReasons: ["SOURCE_UNAVAILABLE"]
    };
  }
}

function groupRankedSkills(
  rankedSkills: readonly SkillSearchMatch[],
  workspaceSourceIds: ReadonlySet<string>,
  truncationReasons: Set<string>
): RankedGroup[] {
  const grouped = new Map<string, SkillSearchMatch[]>();
  for (const match of rankedSkills) {
    const key = `${match.skill.name}:${match.skill.fingerprint}`;
    const bucket = grouped.get(key);
    if (bucket === undefined) grouped.set(key, [match]);
    else bucket.push(match);
  }

  const result: RankedGroup[] = [];
  for (const members of grouped.values()) {
    const representative = selectRepresentative(members, workspaceSourceIds);
    if (members.length - 1 > SYSTEM_DISCOVER_MAX_ALTERNATE_SOURCES) {
      truncationReasons.add("ALTERNATE_SOURCE_LIMIT");
    }
    result.push({ representative, members: Object.freeze([...members]) });
  }

  result.sort((left, right) => {
    if (left.representative.score !== right.representative.score) {
      return right.representative.score - left.representative.score;
    }
    const nameOrder = compareUtf8(left.representative.skill.name, right.representative.skill.name);
    if (nameOrder !== 0) return nameOrder;
    const sourceOrder = compareUtf8(
      left.representative.skill.sourceId,
      right.representative.skill.sourceId
    );
    if (sourceOrder !== 0) return sourceOrder;
    return compareUtf8(left.representative.skill.skillId, right.representative.skill.skillId);
  });
  return result;
}

function selectRepresentative(
  members: readonly SkillSearchMatch[],
  workspaceSourceIds: ReadonlySet<string>
): SkillSearchMatch {
  const workspaceLocal = members.filter((match) => workspaceSourceIds.has(match.skill.sourceId));
  if (workspaceLocal.length > 0) return bestMatch(workspaceLocal);
  const pinned = members.filter(
    (match) => match.skill.pinned || match.skill.availability === "live+pinned"
  );
  if (pinned.length > 0) return bestMatch(pinned);
  return bestMatch(members);
}

function bestMatch(matches: readonly SkillSearchMatch[]): SkillSearchMatch {
  return [...matches].sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    const sourceOrder = compareUtf8(left.skill.sourceId, right.skill.sourceId);
    if (sourceOrder !== 0) return sourceOrder;
    return compareUtf8(left.skill.skillId, right.skill.skillId);
  })[0]!;
}

function toActionResult(
  match: PublicActionSearchMatch,
  workspaceId: string | undefined,
  workspaceReadiness: WorkspaceReadiness
): SystemDiscoverActionMatch {
  const descriptor = match.action;
  return Object.freeze({
    id: descriptor.id,
    family: descriptor.family,
    purpose: descriptor.purpose,
    role: descriptor.role,
    score: match.score,
    matchReasons: Object.freeze(match.matchReasons.slice(0, SYSTEM_DISCOVER_MAX_MATCH_REASONS)),
    requiredInputs: Object.freeze([...descriptor.requiredInputs]),
    availability: actionAvailability(descriptor.scope, workspaceId, workspaceReadiness)
  });
}

function actionAvailability(
  scope: "global" | "workspace" | "repository" | "preview",
  workspaceId: string | undefined,
  workspaceReadiness: WorkspaceReadiness
): SystemDiscoverActionMatch["availability"] {
  if (scope === "global" || scope === "repository") {
    return Object.freeze({ status: "AVAILABLE" as const, reasons: Object.freeze([]) });
  }
  if (workspaceId === undefined) {
    return Object.freeze({
      status: "CONTEXT_REQUIRED" as const,
      reasons: Object.freeze(["WORKSPACE_REQUIRED"])
    });
  }
  if (workspaceReadiness === "ready") {
    return Object.freeze({ status: "AVAILABLE" as const, reasons: Object.freeze([]) });
  }
  return Object.freeze({
    status: "UNAVAILABLE" as const,
    reasons: Object.freeze(["WORKSPACE_UNAVAILABLE"])
  });
}

function toSkillResult(
  group: RankedGroup,
  matchedStages: readonly SystemDiscoverMatchedStage[] | undefined
): SystemDiscoverSkillMatch {
  const selected = group.representative;
  const alternateSources = group.members
    .filter((member) => member.skill.skillId !== selected.skill.skillId)
    .slice(0, SYSTEM_DISCOVER_MAX_ALTERNATE_SOURCES)
    .map((member) => ({ skillId: member.skill.skillId, sourceId: member.skill.sourceId }));
  return Object.freeze({
    skillId: selected.skill.skillId,
    name: selected.skill.name,
    description: selected.skill.description,
    sourceId: selected.skill.sourceId,
    fingerprint: selected.skill.fingerprint,
    compatibility: selected.skill.compatibility.classification,
    score: selected.score,
    matchReasons: Object.freeze(selected.matchReasons.slice(0, SYSTEM_DISCOVER_MAX_MATCH_REASONS)),
    ...(alternateSources.length === 0 ? {} : { alternateSources: Object.freeze(alternateSources) }),
    ...(matchedStages === undefined || matchedStages.length === 0
      ? {}
      : { matchedStages: Object.freeze([...matchedStages]) })
  });
}

function matchedStageEvidence(
  inspected: SkillInspectResult,
  _query: string,
  actionIds: ReadonlySet<PublicActionId>,
  actionScoreById: ReadonlyMap<PublicActionId, number>
): Array<{ stage: SystemDiscoverMatchedStage; score: number; flow: SystemDiscoverFlow }> {
  const evidence: Array<{
    stage: SystemDiscoverMatchedStage;
    score: number;
    flow: SystemDiscoverFlow;
  }> = [];

  for (const stage of inspected.requirementGraph.stages) {
    const knownActionIds = stage.actions.filter((action) => action.known).map((action) => action.id);
    const matchedActionIds = knownActionIds.filter((id) => actionIds.has(id));
    if (matchedActionIds.length === 0) continue;
    const score = matchedActionIds.reduce(
      (total, id) => total + (actionScoreById.get(id) ?? 0),
      0
    );
    const matchedStage: SystemDiscoverMatchedStage = {
      id: stage.id,
      classification: stage.classification,
      actionIds: Object.freeze([...knownActionIds])
    };
    const flow: SystemDiscoverFlow = {
      source: "skill-stage",
      skillId: inspected.skill.skillId,
      skillName: inspected.skill.name,
      stageId: stage.id,
      ...(stage.description === undefined ? {} : { description: stage.description }),
      actionIds: Object.freeze([...knownActionIds])
    };
    evidence.push({ stage: Object.freeze(matchedStage), score, flow: Object.freeze(flow) });
  }

  evidence.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    return compareUtf8(left.stage.id, right.stage.id);
  });
  return evidence;
}

function orderTruncationReasons(reasons: ReadonlySet<string>): string[] {
  const ordered: string[] = [];
  for (const reason of DISCOVERY_TRUNCATION_ORDER) {
    if (reasons.has(reason)) ordered.push(reason);
  }
  const known = new Set<string>(DISCOVERY_TRUNCATION_ORDER);
  ordered.push(...[...reasons].filter((reason) => !known.has(reason)).sort(compareUtf8));
  return ordered;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
