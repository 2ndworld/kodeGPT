import { Buffer } from "node:buffer";

import {
  NATIVE_CAPABILITY_IDS,
  PUBLIC_ACTION_IDS,
  type PublicActionId
} from "@kodegpt/capabilities";

import type {
  ParsedSkillDocument,
  PublicActionRequirement,
  SkillCompatibility,
  SkillCompatibilityAnalysisBasis,
  SkillCompatibilityReport,
  SkillRequirementGraph,
  SkillRequirementStage
} from "./contracts.js";
import { readKodegptDeclaredRequirements } from "./declared-requirements.js";

const MAX_CORE_ACTIONS = 32;
const PUBLIC_ACTION_SET = new Set<string>(PUBLIC_ACTION_IDS);
const NATIVE_CAPABILITY_SET = new Set<string>(NATIVE_CAPABILITY_IDS);

export function buildSkillRequirementGraph(
  skill: ParsedSkillDocument,
  compatibility: SkillCompatibilityReport
): SkillRequirementGraph {
  const declared = readKodegptDeclaredRequirements(skill.metadata);
  const staticActions = staticPublicActionReferences(skill.instructions);
  const stageActionIds = new Set(declared.stages.flatMap((stage) => [...stage.actions]));
  const inferredCore = staticActions.filter((action) => !stageActionIds.has(action));

  const sourceByAction = new Map<string, "declared" | "static" | "declared+static">();
  for (const action of declared.actions) sourceByAction.set(action, "declared");
  for (const action of inferredCore) {
    sourceByAction.set(action, sourceByAction.has(action) ? "declared+static" : "static");
  }

  const sortedCoreIds = [...sourceByAction.keys()].sort(compareUtf8);
  const coreTruncated = sortedCoreIds.length > MAX_CORE_ACTIONS;
  const boundedCoreIds = sortedCoreIds.slice(0, MAX_CORE_ACTIONS);
  const coreActions = Object.freeze(
    boundedCoreIds.map((id) => actionRequirement(id, sourceByAction.get(id)!))
  );
  const missingActions = Object.freeze(
    boundedCoreIds.filter((id) => !PUBLIC_ACTION_SET.has(id)).sort(compareUtf8)
  );
  const boundedInferred = Object.freeze(
    inferredCore
      .filter((id) => boundedCoreIds.includes(id))
      .sort(compareUtf8) as PublicActionId[]
  );

  const stages = Object.freeze(
    declared.stages.map((stage) => buildStage(stage)).sort((left, right) => compareUtf8(left.id, right.id))
  );
  const analysisBasis = requirementAnalysisBasis(declared.present, staticActions.length > 0);
  const coreClassification = missingActions.length > 0
    ? downgradeToPartial(compatibility.classification)
    : compatibility.classification;

  return Object.freeze({
    schemaVersion: 1 as const,
    core: Object.freeze({
      classification: coreClassification,
      actions: coreActions,
      inferredActions: boundedInferred,
      missingActions
    }),
    stages,
    analysisBasis,
    truncated: coreTruncated,
    truncationReasons: Object.freeze(coreTruncated ? ["CORE_ACTION_LIMIT" as const] : [])
  });
}

function buildStage(stage: {
  readonly id: string;
  readonly description?: string;
  readonly actions: readonly string[];
  readonly capabilities: readonly string[];
  readonly providers: readonly string[];
}): SkillRequirementStage {
  const actions = Object.freeze(
    [...stage.actions]
      .sort(compareUtf8)
      .map((id) => actionRequirement(id, "declared"))
  );
  const missingActions = Object.freeze(
    stage.actions.filter((id) => !PUBLIC_ACTION_SET.has(id)).sort(compareUtf8)
  );
  const requiredCapabilities = Object.freeze([...stage.capabilities].sort(compareUtf8));
  const requiredProviders = Object.freeze([...stage.providers].sort(compareUtf8));
  const hasMissingCapability = stage.capabilities.some(
    (capability) => !NATIVE_CAPABILITY_SET.has(capability)
  );
  const classification: SkillCompatibility = requiredProviders.length > 0
    ? "PROVIDER_REQUIRED"
    : missingActions.length > 0 || hasMissingCapability
      ? "PARTIAL"
      : "NATIVE";

  return Object.freeze({
    id: stage.id,
    ...(stage.description === undefined ? {} : { description: stage.description }),
    classification,
    actions,
    missingActions,
    requiredCapabilities,
    requiredProviders
  });
}

function actionRequirement(
  id: string,
  source: "declared" | "static" | "declared+static"
): PublicActionRequirement {
  if (PUBLIC_ACTION_SET.has(id)) {
    return Object.freeze({
      id: id as PublicActionId,
      known: true as const,
      source
    });
  }
  return Object.freeze({
    id,
    known: false as const,
    source: "declared" as const
  });
}

function staticPublicActionReferences(instructions: string): PublicActionId[] {
  const result: PublicActionId[] = [];
  for (const action of PUBLIC_ACTION_IDS) {
    if (containsExactReference(instructions, action)) result.push(action);
  }
  return result.sort(compareUtf8);
}

function containsExactReference(instructions: string, action: string): boolean {
  const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-zA-Z0-9_.-])${escaped}([^a-zA-Z0-9_.-]|$)`, "u").test(
    instructions
  );
}

function downgradeToPartial(classification: SkillCompatibility): SkillCompatibility {
  return classification === "NATIVE" ? "PARTIAL" : classification;
}

function requirementAnalysisBasis(
  declared: boolean,
  staticFinding: boolean
): SkillCompatibilityAnalysisBasis {
  if (declared && staticFinding) return "declared+static";
  if (declared) return "declared";
  return "static";
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
