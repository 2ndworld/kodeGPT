import { Buffer } from "node:buffer";

import {
  NATIVE_CAPABILITY_IDS,
  getNativeCapabilitySemanticMetadata,
  type NativeCapabilityId
} from "@kodegpt/capabilities";

import type {
  ParsedSkillDocument,
  SkillCapabilityGuidanceStep,
  SkillCapabilityPlan,
  SkillCapabilityPlanTruncationReason,
  SkillCapabilityRuntimeContext,
  SkillCompatibility,
  SkillCompatibilityReport,
  SkillExternalCliResolution,
  SkillExternalCliStatus
} from "./contracts.js";

const MAX_PLAN_FINDINGS = 64;
const NATIVE_CAPABILITIES = new Set<string>(NATIVE_CAPABILITY_IDS);

interface BoundedStrings {
  readonly values: readonly string[];
  readonly truncated: boolean;
}

export function buildSkillCapabilityPlan(
  skill: ParsedSkillDocument,
  compatibility: SkillCompatibilityReport
): SkillCapabilityPlan {
  const selected = new Set<NativeCapabilityId>();

  for (const capability of compatibility.requiredCapabilities) {
    if (NATIVE_CAPABILITIES.has(capability)) selected.add(capability as NativeCapabilityId);
  }
  for (const id of NATIVE_CAPABILITY_IDS) {
    const metadata = getNativeCapabilitySemanticMetadata(id);
    if (metadata.semanticAliases.some((alias) => containsSemanticAlias(skill.instructions, alias))) {
      selected.add(id);
    }
  }

  const nativeCapabilities = Object.freeze(sortedUnique(selected));
  const missingCapabilities = boundedStrings(compatibility.missingCapabilities);
  const externalRequirements = boundedStrings(
    compatibility.requiredProviders.map((provider) => `provider:${provider}`)
  );
  const blockedSemantics = boundedStrings(blockedSemanticsFrom(compatibility.reasons));

  const truncationReasons = new Set<SkillCapabilityPlanTruncationReason>();
  if (missingCapabilities.truncated) truncationReasons.add("MISSING_CAPABILITIES");
  if (externalRequirements.truncated) truncationReasons.add("EXTERNAL_REQUIREMENTS");
  if (blockedSemantics.truncated) truncationReasons.add("BLOCKED_SEMANTICS");
  const orderedTruncationReasons = Object.freeze(sortedUnique(truncationReasons));

  const guidance = Object.freeze(
    nativeCapabilities.map((capability) =>
      Object.freeze({
        capability,
        purpose: getNativeCapabilitySemanticMetadata(capability).purpose
      } satisfies SkillCapabilityGuidanceStep)
    )
  );

  return Object.freeze({
    schemaVersion: 1,
    classification: compatibility.classification,
    nativeCapabilities,
    missingCapabilities: missingCapabilities.values,
    externalRequirements: externalRequirements.values,
    blockedSemantics: blockedSemantics.values,
    guidance,
    truncated: orderedTruncationReasons.length > 0,
    truncationReasons: orderedTruncationReasons
  });
}

const EXTERNAL_CLI_PREFIX = "external-cli:";

export async function resolveSkillCapabilityPlan(
  plan: SkillCapabilityPlan,
  context: SkillCapabilityRuntimeContext
): Promise<SkillCapabilityPlan> {
  const requirements = sortedUnique(
    new Set(
      plan.missingCapabilities.filter(
        (value) => value.startsWith(EXTERNAL_CLI_PREFIX) && value.length > EXTERNAL_CLI_PREFIX.length
      )
    )
  );
  if (requirements.length === 0) return plan;

  const allowedExecutables = new Set(context.allowedExecutableNames);
  const resolvedAvailable = new Set<string>();
  const resolutions: SkillExternalCliResolution[] = [];

  for (const requirement of requirements) {
    const executable = requirement.slice(EXTERNAL_CLI_PREFIX.length);
    let status: SkillExternalCliStatus;
    if (
      !context.allowProcess ||
      (!allowedExecutables.has(executable) && !context.allowDynamicExecutables)
    ) {
      status = "not-allowed";
    } else {
      const availability = await context.inspectExecutable(executable);
      status = !availability.executableAvailable
        ? "not-installed"
        : !availability.sandboxAvailable
          ? "sandbox-unavailable"
          : "available";
    }
    if (status === "available") resolvedAvailable.add(requirement);
    resolutions.push(
      Object.freeze({
        requirement,
        executable,
        status,
        capability: "process.run" as const
      })
    );
  }

  const missingCapabilities = Object.freeze(
    plan.missingCapabilities.filter((value) => !resolvedAvailable.has(value))
  );
  const selected = new Set<NativeCapabilityId>(plan.nativeCapabilities);
  if (resolvedAvailable.size > 0) selected.add("process.run");
  const nativeCapabilities = Object.freeze(sortedUnique(selected));
  const guidance = Object.freeze(
    nativeCapabilities.map((capability) =>
      Object.freeze({
        capability,
        purpose: getNativeCapabilitySemanticMetadata(capability).purpose
      } satisfies SkillCapabilityGuidanceStep)
    )
  );

  return Object.freeze({
    ...plan,
    classification: effectiveClassification(
      plan.classification,
      missingCapabilities.length,
      plan.truncationReasons.includes("MISSING_CAPABILITIES")
    ),
    nativeCapabilities,
    missingCapabilities,
    guidance,
    externalCliRequirements: Object.freeze(resolutions),
  });
}

function effectiveClassification(
  classification: SkillCompatibility,
  remainingMissingCapabilities: number,
  missingCapabilitiesTruncated: boolean
): SkillCompatibility {
  if (classification === "UNSUPPORTED" || classification === "PROVIDER_REQUIRED") return classification;
  if (remainingMissingCapabilities > 0 || missingCapabilitiesTruncated) return "PARTIAL";
  return "NATIVE";
}

function containsSemanticAlias(instructions: string, alias: string): boolean {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-zA-Z0-9])${escaped}([^a-zA-Z0-9]|$)`, "iu").test(instructions);
}

function blockedSemanticsFrom(reasons: readonly string[]): string[] {
  const blocked = new Set<string>();
  for (const reason of reasons) {
    switch (reason) {
      case "CODEX_EXEC_UNSUPPORTED":
        blocked.add("codex.exec");
        break;
      case "CODEX_RUNTIME_UNSUPPORTED":
        blocked.add("codex.runtime");
        break;
      case "SUBAGENT_SESSION_UNSUPPORTED":
        blocked.add("subagent.session");
        break;
      default:
        if (reason.startsWith("DECLARED_UNSUPPORTED:")) {
          const declared = reason.slice("DECLARED_UNSUPPORTED:".length);
          if (declared.length > 0) blocked.add(`declared:${declared}`);
        }
        break;
    }
  }
  return [...blocked];
}

function boundedStrings(values: readonly string[]): BoundedStrings {
  const sorted = sortedUnique(new Set(values));
  return Object.freeze({
    values: Object.freeze(sorted.slice(0, MAX_PLAN_FINDINGS)),
    truncated: sorted.length > MAX_PLAN_FINDINGS
  });
}

function sortedUnique<T extends string>(values: ReadonlySet<T>): T[] {
  return [...values].sort(compareUtf8);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
