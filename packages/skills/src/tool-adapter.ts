import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

import type { SkillCatalog } from "./catalog.js";
import {
  SKILL_STATE_SCHEMA_VERSION,
  SKILL_TOOL_LIST_MAX,
  SKILL_TOOL_LOAD_MAX_BYTES,
  SKILL_TOOL_LOAD_RESOURCE_MAX,
  type SkillCatalogEntry,
  type SkillCatalogInspection,
  type SkillCatalogToolAdapter,
  type SkillInspectFrontmatter,
  type SkillInspectResult,
  type SkillListResult,
  type SkillListTruncationReason,
  type SkillLoadResult,
  type SkillRequirementGraph,
  type SkillLoadTextResource
} from "./contracts.js";
import { SkillError } from "./errors.js";
import { SkillDocumentParseError, parseSkillDocument } from "./parser.js";
import { rankSkillsForQuery } from "./skill-search.js";

export type SkillCatalogToolSource = Pick<SkillCatalog, "list" | "inspect" | "loadRaw">;

export function createSkillCatalogToolAdapter(source: SkillCatalogToolSource): SkillCatalogToolAdapter {
  return {
    list: async ({ limit, sourceId, compatibility, pinned, workspaceId, query }) => {
      const boundedLimit = requireListLimit(limit);
      const boundedQuery = requireListQuery(query);
      const catalog = await source.list(workspaceId === undefined ? {} : { workspaceId });
      const filtered = catalog.skills.filter((skill) => {
        if (sourceId !== undefined && skill.sourceId !== sourceId) return false;
        if (compatibility !== undefined && skill.compatibility.classification !== compatibility) return false;
        if (pinned !== undefined && skill.pinned !== pinned) return false;
        return true;
      });
      const ranked = boundedQuery === undefined
        ? filtered
        : rankSkillsForQuery(filtered, boundedQuery, {
            workspaceSourceIds: new Set(catalog.workspaceSourceIds ?? [])
          }).map((match) => match.skill);
      const resultLimited = ranked.length > boundedLimit;
      const reasons = new Set<SkillListTruncationReason>(catalog.truncationReasons);
      if (resultLimited) reasons.add("RESULT_LIMIT");
      return {
        schemaVersion: SKILL_STATE_SCHEMA_VERSION,
        skills: ranked.slice(0, boundedLimit).map(cloneCatalogEntry),
        truncated: catalog.truncated || resultLimited,
        truncationReasons: orderListTruncationReasons(reasons)
      } satisfies SkillListResult;
    },
    inspect: async (input) => publicInspection(await source.inspect(input)),
    load: async ({ skillId, fingerprint, resources, maxBytes, workspaceId }) => {
      const requestedResources = requireRequestedResources(resources);
      const boundedMaxBytes = requireLoadMaxBytes(maxBytes);
      const raw = await source.loadRaw({
        skillId,
        fingerprint,
        resources: requestedResources,
        ...(workspaceId === undefined ? {} : { workspaceId })
      });
      if (raw.descriptor.skillId !== skillId) throw bundleInvalid();
      if (fingerprint !== undefined && raw.bundleFingerprint !== fingerprint) {
        throw new SkillError("SKILL_FINGERPRINT_MISMATCH", "Skill fingerprint does not match");
      }
      requireReturnedResources(raw.resources.map((resource) => resource.path), requestedResources);
      const parsed = parseReturnedSkillDocument(raw.skillDocument, raw.descriptor.name);
      if (parsed.description !== raw.descriptor.description) throw bundleInvalid();
      const instructionBytes = Buffer.byteLength(parsed.instructions, "utf8");
      let totalBytes = instructionBytes;
      if (totalBytes > boundedMaxBytes) throw loadLimit();

      const textResources: SkillLoadTextResource[] = [];
      for (const resource of raw.resources) {
        const contents = decodeUtf8(resource.bytes);
        totalBytes += resource.bytes.byteLength;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > boundedMaxBytes) throw loadLimit();
        textResources.push({
          path: resource.path,
          contents,
          bytes: resource.bytes.byteLength,
          sha256: resource.sha256
        });
      }

      return {
        schemaVersion: SKILL_STATE_SCHEMA_VERSION,
        skillId: raw.descriptor.skillId,
        name: raw.descriptor.name,
        description: raw.descriptor.description,
        sourceId: raw.descriptor.sourceId,
        sourceKind: raw.descriptor.sourceKind,
        fingerprint: raw.bundleFingerprint,
        availability: raw.availability,
        pinned: raw.pinned,
        compatibility: cloneCompatibility(raw.descriptor.compatibility),
        instructions: parsed.instructions,
        resources: textResources,
        totalBytes
      } satisfies SkillLoadResult;
    }
  };
}

function publicInspection(inspection: SkillCatalogInspection): SkillInspectResult {
  return {
    schemaVersion: SKILL_STATE_SCHEMA_VERSION,
    skill: cloneCatalogEntry(inspection.skill),
    capabilityPlan: {
      ...inspection.capabilityPlan,
      nativeCapabilities: [...inspection.capabilityPlan.nativeCapabilities],
      missingCapabilities: [...inspection.capabilityPlan.missingCapabilities],
      externalRequirements: [...inspection.capabilityPlan.externalRequirements],
      blockedSemantics: [...inspection.capabilityPlan.blockedSemantics],
      guidance: inspection.capabilityPlan.guidance.map((step) => ({ ...step })),
      truncationReasons: [...inspection.capabilityPlan.truncationReasons]
    },
    requirementGraph: cloneRequirementGraph(inspection.requirementGraph),
    frontmatter: publicFrontmatter(inspection.frontmatter),
    resources: inspection.resources.map((resource) => ({ ...resource })),
    instructionBytes: inspection.instructionBytes,
    bundleBytes: inspection.bundleBytes
  };
}

function cloneRequirementGraph(graph: SkillRequirementGraph): SkillRequirementGraph {
  return {
    ...graph,
    core: {
      ...graph.core,
      actions: graph.core.actions.map((action) => ({ ...action })),
      inferredActions: [...graph.core.inferredActions],
      missingActions: [...graph.core.missingActions]
    },
    stages: graph.stages.map((stage) => ({
      ...stage,
      actions: stage.actions.map((action) => ({ ...action })),
      missingActions: [...stage.missingActions],
      requiredCapabilities: [...stage.requiredCapabilities],
      requiredProviders: [...stage.requiredProviders]
    })),
    truncationReasons: [...graph.truncationReasons]
  };
}

function publicFrontmatter(frontmatter: SkillCatalogInspection["frontmatter"]): SkillInspectFrontmatter {
  const result: SkillInspectFrontmatter = {
    unknownMetadataKeys: [...frontmatter.unknownMetadataKeys]
  };
  if (frontmatter.license !== undefined) result.license = frontmatter.license;
  if (frontmatter.compatibility !== undefined) result.compatibility = frontmatter.compatibility;
  if (frontmatter.allowedTools !== undefined) {
    result.allowedTools = Array.isArray(frontmatter.allowedTools)
      ? [...frontmatter.allowedTools]
      : frontmatter.allowedTools;
  }
  return result;
}

function cloneCatalogEntry(entry: SkillCatalogEntry): SkillCatalogEntry {
  return {
    ...entry,
    compatibility: cloneCompatibility(entry.compatibility)
  };
}

function cloneCompatibility(report: SkillCatalogEntry["compatibility"]): SkillCatalogEntry["compatibility"] {
  return {
    ...report,
    requiredCapabilities: [...report.requiredCapabilities],
    missingCapabilities: [...report.missingCapabilities],
    requiredProviders: [...report.requiredProviders],
    reasons: [...report.reasons]
  };
}

function parseReturnedSkillDocument(bytes: Uint8Array, expectedName: string) {
  try {
    return parseSkillDocument(bytes, expectedName);
  } catch (error) {
    if (error instanceof SkillDocumentParseError) {
      throw new SkillError("SKILL_BUNDLE_INVALID", "Skill bundle is invalid");
    }
    throw error;
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SkillError("SKILL_RESOURCE_UNSUPPORTED", "Skill resource is unsupported");
  }
}

function requireListQuery(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > 512) {
    throw new SkillError("SKILL_LOAD_LIMIT_EXCEEDED", "Skill query limit exceeded");
  }
  return normalized;
}

function requireListLimit(value: number | undefined): number {
  const limit = value ?? SKILL_TOOL_LIST_MAX;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > SKILL_TOOL_LIST_MAX) {
    throw new SkillError("SKILL_LOAD_LIMIT_EXCEEDED", "Skill result limit exceeded");
  }
  return limit;
}

function requireRequestedResources(resources: string[] | undefined): string[] {
  const requested = resources ?? [];
  if (requested.length > SKILL_TOOL_LOAD_RESOURCE_MAX) throw loadLimit();
  if (new Set(requested).size !== requested.length) {
    throw new SkillError("SKILL_RESOURCE_UNSUPPORTED", "Skill resource is unsupported");
  }
  return [...requested];
}

function requireLoadMaxBytes(value: number | undefined): number {
  const maxBytes = value ?? SKILL_TOOL_LOAD_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > SKILL_TOOL_LOAD_MAX_BYTES) {
    throw loadLimit();
  }
  return maxBytes;
}

function requireReturnedResources(returnedPaths: string[], requestedPaths: string[]): void {
  if (returnedPaths.length !== requestedPaths.length) throw bundleInvalid();
  const returned = new Set(returnedPaths);
  if (returned.size !== returnedPaths.length) throw bundleInvalid();
  for (const path of requestedPaths) {
    if (!returned.has(path)) throw bundleInvalid();
  }
}

function bundleInvalid(): SkillError {
  return new SkillError("SKILL_BUNDLE_INVALID", "Skill bundle is invalid");
}

function loadLimit(): SkillError {
  return new SkillError("SKILL_LOAD_LIMIT_EXCEEDED", "Skill load limit exceeded");
}

function orderListTruncationReasons(reasons: Set<SkillListTruncationReason>): SkillListTruncationReason[] {
  const order: SkillListTruncationReason[] = [
    "SOURCE_ENTRY_LIMIT",
    "SKILL_COUNT_LIMIT",
    "DESCRIPTOR_SIZE_LIMIT",
    "SOURCE_UNAVAILABLE",
    "RESULT_LIMIT"
  ];
  return order.filter((reason) => reasons.has(reason));
}
