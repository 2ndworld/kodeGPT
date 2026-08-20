import { Buffer } from "node:buffer";

import {
  MAX_LOADED_RESOURCES,
  MAX_RESOURCES_PER_SKILL,
  MAX_SKILLS_PER_SOURCE,
  RESOURCE_TEXT_MAX_BYTES,
  SKILL_BUNDLE_MAX_BYTES,
  SKILL_MD_MAX_BYTES,
  type LiveSkillDescriptor,
  type ParsedSkillDocument,
  type PersistedSkillSource,
  type SkillCatalogEntry,
  type SkillCatalogInspection,
  type SkillCatalogListResult,
  type SkillCatalogRawLoad,
  type SkillCompatibilityReport,
  type SkillDiscoveryTruncationReason,
  type SkillLiveInspection,
  type SkillLiveListResult,
  type SkillLiveRawLoad,
  type SkillPinnedManifest,
  type SkillPinnedRawLoad,
  type SkillRawResource,
  type SkillResourceInventoryEntry,
  type SkillSourceReadBytesResult,
  type SkillSourceTreeResult,
  type SkillValidatedFrontmatter
} from "./contracts.js";
import { buildSkillCapabilityPlan } from "./capability-plan.js";
import { analyzeSkillCompatibility } from "./compatibility.js";
import { buildSkillRequirementGraph } from "./requirement-graph.js";
import { SkillError } from "./errors.js";
import { fingerprintSkillBundle, fingerprintSkillDescriptor } from "./fingerprint.js";
import { SkillDocumentParseError, parseSkillDocument } from "./parser.js";
import { SkillPinStore } from "./pin-store.js";

type SkillCatalogSource = Pick<PersistedSkillSource, "sourceId" | "label" | "kind">;

interface SkillCatalogSourceManager {
  listSources(workspaceId?: string): Promise<SkillCatalogSource[]>;
  listReadyWorkspaceIds?(): Promise<string[]>;
  tree(input: { workspaceId?: string; sourceId: string; path: string }): Promise<SkillSourceTreeResult>;
  readBytes(input: {
    workspaceId?: string;
    sourceId: string;
    path: string;
    offset: number;
    maxBytes: number;
  }): Promise<SkillSourceReadBytesResult>;
}

export interface SkillCatalogOptions {
  pins?: SkillPinStore;
}

interface DiscoveredSkill {
  descriptor: LiveSkillDescriptor;
  sourceId: string;
  relativeDirectory: string;
  parsed: ParsedSkillDocument;
  skillDocument: Uint8Array;
}

interface DiscoveryResult {
  skills: DiscoveredSkill[];
  truncationReasons: SkillDiscoveryTruncationReason[];
}

interface BundleFile {
  path: string;
  bytes: Uint8Array;
  sha256: string;
}

interface BuiltBundle {
  inspection: SkillLiveInspection;
  parsed: ParsedSkillDocument;
  skillDocument: Uint8Array;
  files: Map<string, BundleFile>;
}

const TRUNCATION_REASON_ORDER: SkillDiscoveryTruncationReason[] = [
  "SOURCE_ENTRY_LIMIT",
  "SKILL_COUNT_LIMIT",
  "DESCRIPTOR_SIZE_LIMIT",
  "SOURCE_UNAVAILABLE"
];

export class SkillCatalog {
  readonly #sources: SkillCatalogSourceManager;
  readonly #pins: SkillPinStore | undefined;

  constructor(sources: SkillCatalogSourceManager, options: SkillCatalogOptions = {}) {
    this.#sources = sources;
    this.#pins = options.pins;
  }

  async list(input: { workspaceId?: string } = {}): Promise<SkillCatalogListResult> {
    const discovery = await this.#discover({
      tolerateUnavailableSources: true,
      workspaceId: input.workspaceId
    });
    const truncationReasons = new Set(discovery.truncationReasons);
    const entries = new Map<string, SkillCatalogEntry>();

    for (const skill of discovery.skills) {
      let bundle: BuiltBundle;
      try {
        bundle = await this.#buildBundle(skill, input.workspaceId);
      } catch (error) {
        if (isUnavailableSourceError(error)) {
          truncationReasons.add("SOURCE_UNAVAILABLE");
          continue;
        }
        throw error;
      }
      const fingerprint = bundle.inspection.bundleFingerprint;
      entries.set(versionKey(skill.descriptor.skillId, fingerprint), {
        skillId: skill.descriptor.skillId,
        name: skill.descriptor.name,
        description: skill.descriptor.description,
        sourceId: skill.descriptor.sourceId,
        sourceKind: skill.descriptor.sourceKind,
        fingerprint,
        descriptorFingerprint: skill.descriptor.descriptorFingerprint,
        nameCollision: skill.descriptor.nameCollision,
        compatibility: cloneCompatibilityReport(skill.descriptor.compatibility),
        availability: "live",
        pinned: false
      });
    }

    if (this.#pins !== undefined) {
      for (const manifest of await this.#pins.list()) {
        const key = versionKey(manifest.skillId, manifest.fingerprint);
        const current = entries.get(key);
        if (current !== undefined) {
          current.availability = "live+pinned";
          current.pinned = true;
          continue;
        }
        const pinned = await this.#pins.load(manifest.skillId, manifest.fingerprint);
        entries.set(key, entryFromPinnedLoad(pinned));
      }
    }

    const orderedTruncationReasons = TRUNCATION_REASON_ORDER.filter((reason) =>
      truncationReasons.has(reason)
    );
    return {
      skills: [...entries.values()].sort(compareCatalogEntries),
      truncated: orderedTruncationReasons.length > 0,
      truncationReasons: orderedTruncationReasons
    };
  }

  async inspect(input: {
    skillId: string;
    fingerprint?: string;
    workspaceId?: string;
  }): Promise<SkillCatalogInspection> {
    const discovery = await this.#discover({
      tolerateUnavailableSources: true,
      workspaceId: input.workspaceId
    });
    const liveSkill = discovery.skills.find((candidate) => candidate.descriptor.skillId === input.skillId);
    let liveUnavailable = discovery.truncationReasons.includes("SOURCE_UNAVAILABLE");

    if (liveSkill !== undefined) {
      try {
        const bundle = await this.#buildBundle(liveSkill, input.workspaceId);
        if (input.fingerprint === undefined || input.fingerprint === bundle.inspection.bundleFingerprint) {
          const pinned = await this.#hasPinned(input.skillId, bundle.inspection.bundleFingerprint);
          return inspectionFromBundle(bundle, pinned);
        }
      } catch (error) {
        if (!isUnavailableSourceError(error)) throw error;
        liveUnavailable = true;
      }
    }

    const pinnedLoad = await this.#loadPinned(input.skillId, input.fingerprint);
    if (pinnedLoad !== undefined) {
      return inspectionFromPinned(pinnedLoad);
    }
    if (liveSkill !== undefined && input.fingerprint !== undefined) {
      throw fingerprintMismatch();
    }
    const scopeError = await this.#workspaceScopeError(input.skillId, input.workspaceId);
    if (scopeError !== undefined) throw scopeError;
    if (liveUnavailable) {
      throw new SkillError("SKILL_SOURCE_UNAVAILABLE", "Skill source operation failed");
    }
    throw new SkillError("SKILL_NOT_FOUND", "Skill was not found");
  }

  async pin(input: {
    skillId: string;
    expectedDescriptorFingerprint?: string;
    expectedBundleFingerprint?: string;
  }): Promise<SkillPinnedManifest> {
    const pins = this.#requirePins();
    const skill = await this.#findLiveSkill(input.skillId);
    requireExpectedFingerprint(
      skill.descriptor.descriptorFingerprint,
      input.expectedDescriptorFingerprint
    );
    const bundle = await this.#buildBundle(skill);
    requireExpectedFingerprint(bundle.inspection.bundleFingerprint, input.expectedBundleFingerprint);
    return pins.pin({
      descriptor: cloneDescriptor(skill.descriptor),
      fingerprint: bundle.inspection.bundleFingerprint,
      sourceRelativePath: skill.relativeDirectory,
      skillDocument: bundle.skillDocument.slice(),
      resources: bundleResources(bundle)
    });
  }

  async unpin(input: { skillId: string; fingerprint: string }): Promise<boolean> {
    return this.#requirePins().unpin(input.skillId, input.fingerprint);
  }

  async loadRaw(input: {
    skillId: string;
    fingerprint?: string;
    resources?: string[];
    workspaceId?: string;
  }): Promise<SkillCatalogRawLoad> {
    const discovery = await this.#discover({
      tolerateUnavailableSources: true,
      workspaceId: input.workspaceId
    });
    const liveSkill = discovery.skills.find((candidate) => candidate.descriptor.skillId === input.skillId);
    let liveUnavailable = discovery.truncationReasons.includes("SOURCE_UNAVAILABLE");
    if (liveSkill !== undefined) {
      try {
        const bundle = await this.#buildBundle(liveSkill, input.workspaceId);
        if (input.fingerprint === undefined || input.fingerprint === bundle.inspection.bundleFingerprint) {
          const pinned = await this.#hasPinned(input.skillId, bundle.inspection.bundleFingerprint);
          const raw = rawLoadFromBundle(bundle, input.resources);
          return {
            ...raw,
            availability: pinned ? "live+pinned" : "live",
            pinned
          };
        }
      } catch (error) {
        if (!isUnavailableSourceError(error)) throw error;
        liveUnavailable = true;
      }
    }

    const pinnedLoad = await this.#loadPinned(input.skillId, input.fingerprint);
    if (pinnedLoad !== undefined) {
      return rawLoadFromPinned(pinnedLoad, input.resources);
    }
    if (liveSkill !== undefined && input.fingerprint !== undefined) {
      throw fingerprintMismatch();
    }
    const scopeError = await this.#workspaceScopeError(input.skillId, input.workspaceId);
    if (scopeError !== undefined) throw scopeError;
    if (liveUnavailable) {
      throw new SkillError("SKILL_SOURCE_UNAVAILABLE", "Skill source operation failed");
    }
    throw new SkillError("SKILL_NOT_FOUND", "Skill was not found");
  }

  async listLive(): Promise<SkillLiveListResult> {
    const discovery = await this.#discover();
    return {
      skills: discovery.skills.map((skill) => cloneDescriptor(skill.descriptor)),
      truncated: discovery.truncationReasons.length > 0,
      truncationReasons: [...discovery.truncationReasons]
    };
  }

  async inspectLive(input: {
    skillId: string;
    expectedDescriptorFingerprint?: string;
  }): Promise<SkillLiveInspection> {
    const skill = await this.#findLiveSkill(input.skillId);
    requireExpectedFingerprint(
      skill.descriptor.descriptorFingerprint,
      input.expectedDescriptorFingerprint
    );
    return (await this.#buildBundle(skill)).inspection;
  }

  async loadLiveRaw(input: {
    skillId: string;
    expectedDescriptorFingerprint?: string;
    expectedBundleFingerprint?: string;
    resources?: string[];
  }): Promise<SkillLiveRawLoad> {
    const skill = await this.#findLiveSkill(input.skillId);
    requireExpectedFingerprint(
      skill.descriptor.descriptorFingerprint,
      input.expectedDescriptorFingerprint
    );
    const bundle = await this.#buildBundle(skill);
    requireExpectedFingerprint(bundle.inspection.bundleFingerprint, input.expectedBundleFingerprint);

    return rawLoadFromBundle(bundle, input.resources);
  }

  async #discover(
    options: { tolerateUnavailableSources?: boolean; workspaceId?: string } = {}
  ): Promise<DiscoveryResult> {
    const truncationReasons = new Set<SkillDiscoveryTruncationReason>();
    const discovered: DiscoveredSkill[] = [];
    const sources = (await this.#sourceCall(() => this.#sources.listSources(options.workspaceId))).sort(
      (left, right) => compareUtf8(left.sourceId, right.sourceId)
    );

    sourceLoop: for (const source of sources) {
      let tree: SkillSourceTreeResult;
      try {
        tree = await this.#sourceCall(() =>
          this.#sources.tree({
            workspaceId: options.workspaceId,
            sourceId: source.sourceId,
            path: "."
          })
        );
      } catch (error) {
        if (options.tolerateUnavailableSources && isUnavailableSourceError(error)) {
          truncationReasons.add("SOURCE_UNAVAILABLE");
          continue;
        }
        throw error;
      }
      if (tree.truncated) {
        truncationReasons.add("SOURCE_ENTRY_LIMIT");
      }

      const entriesByPath = new Map(tree.entries.map((entry) => [entry.path, entry]));
      let candidates = tree.entries
        .filter((entry) => !entry.path.includes("/") && entry.kind === "directory")
        .filter((entry) => entriesByPath.get(`${entry.path}/SKILL.md`)?.kind === "file")
        .map((entry) => entry.path)
        .sort(compareUtf8);
      if (candidates.length > MAX_SKILLS_PER_SOURCE) {
        candidates = candidates.slice(0, MAX_SKILLS_PER_SOURCE);
        truncationReasons.add("SKILL_COUNT_LIMIT");
      }

      for (const relativeDirectory of candidates) {
        const skillEntry = entriesByPath.get(`${relativeDirectory}/SKILL.md`)!;
        if (skillEntry.sizeBytes > SKILL_MD_MAX_BYTES) {
          truncationReasons.add("DESCRIPTOR_SIZE_LIMIT");
          continue;
        }

        let read: SkillSourceReadBytesResult;
        try {
          read = await this.#sourceCall(() =>
            this.#sources.readBytes({
              workspaceId: options.workspaceId,
              sourceId: source.sourceId,
              path: `${relativeDirectory}/SKILL.md`,
              offset: 0,
              maxBytes: SKILL_MD_MAX_BYTES
            })
          );
        } catch (error) {
          if (options.tolerateUnavailableSources && isUnavailableSourceError(error)) {
            truncationReasons.add("SOURCE_UNAVAILABLE");
            continue sourceLoop;
          }
          throw error;
        }
        if (!read.eof) {
          truncationReasons.add("DESCRIPTOR_SIZE_LIMIT");
          continue;
        }

        let parsed: ParsedSkillDocument;
        try {
          parsed = parseSkillDocument(read.bytes, relativeDirectory);
        } catch (error) {
          if (
            error instanceof SkillDocumentParseError &&
            error.reason === "DESCRIPTOR_SIZE_LIMIT"
          ) {
            truncationReasons.add("DESCRIPTOR_SIZE_LIMIT");
          }
          continue;
        }

        const descriptorFingerprint = fingerprintSkillDescriptor(read.bytes);
        discovered.push({
          descriptor: {
            skillId: deriveSkillId(source.sourceId, parsed.name),
            name: parsed.name,
            description: parsed.description,
            sourceId: source.sourceId,
            sourceKind: "agent-skills",
            descriptorFingerprint,
            nameCollision: false,
            compatibility: analyzeSkillCompatibility(parsed),
            unknownMetadataKeys: [...parsed.unknownMetadataKeys]
          },
          sourceId: source.sourceId,
          relativeDirectory,
          parsed,
          skillDocument: read.bytes.slice()
        });
      }
    }

    const nameCounts = new Map<string, number>();
    for (const skill of discovered) {
      nameCounts.set(skill.descriptor.name, (nameCounts.get(skill.descriptor.name) ?? 0) + 1);
    }
    for (const skill of discovered) {
      skill.descriptor.nameCollision = (nameCounts.get(skill.descriptor.name) ?? 0) > 1;
    }
    discovered.sort(compareDiscoveredSkills);

    return {
      skills: discovered,
      truncationReasons: TRUNCATION_REASON_ORDER.filter((reason) => truncationReasons.has(reason))
    };
  }

  async #workspaceScopeError(
    skillId: string,
    requestedWorkspaceId: string | undefined
  ): Promise<SkillError | undefined> {
    const listReady = this.#sources.listReadyWorkspaceIds;
    if (listReady === undefined) return undefined;
    const workspaceIds = await this.#sourceCall(() => listReady.call(this.#sources));
    for (const workspaceId of workspaceIds) {
      if (workspaceId === requestedWorkspaceId) continue;
      const discovery = await this.#discover({
        workspaceId,
        tolerateUnavailableSources: true
      });
      if (!discovery.skills.some((candidate) => candidate.descriptor.skillId === skillId)) continue;
      return requestedWorkspaceId === undefined
        ? new SkillError("SKILL_WORKSPACE_REQUIRED", "Skill requires its READY workspace scope")
        : new SkillError("SKILL_WORKSPACE_MISMATCH", "Skill belongs to a different READY workspace");
    }
    return undefined;
  }

  async #findLiveSkill(skillId: string): Promise<DiscoveredSkill> {
    const discovery = await this.#discover();
    const skill = discovery.skills.find((candidate) => candidate.descriptor.skillId === skillId);
    if (skill === undefined) {
      throw new SkillError("SKILL_NOT_FOUND", "Skill was not found");
    }
    return skill;
  }

  async #buildBundle(skill: DiscoveredSkill, workspaceId?: string): Promise<BuiltBundle> {
    const tree = await this.#sourceCall(() =>
      this.#sources.tree({ workspaceId, sourceId: skill.sourceId, path: skill.relativeDirectory })
    );
    if (tree.truncated) {
      throw loadLimit();
    }

    const prefix = `${skill.relativeDirectory}/`;
    const files = tree.entries
      .map((entry) => {
        if (!entry.path.startsWith(prefix)) {
          throw bundleInvalid();
        }
        return {
          entry,
          relativePath: entry.path.slice(prefix.length)
        };
      })
      .filter(({ relativePath }) => relativePath.length > 0);

    for (const { entry } of files) {
      if (entry.kind === "symlink" || entry.kind === "other") {
        throw resourceUnsupported();
      }
    }

    const regularFiles = files
      .filter(({ entry }) => entry.kind === "file")
      .sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
    const skillDocumentEntry = regularFiles.find(({ relativePath }) => relativePath === "SKILL.md");
    if (skillDocumentEntry === undefined) {
      throw bundleInvalid();
    }
    const resourceCount = regularFiles.filter(({ relativePath }) => relativePath !== "SKILL.md").length;
    if (resourceCount > MAX_RESOURCES_PER_SKILL) {
      throw loadLimit();
    }

    const declaredBundleBytes = regularFiles.reduce((total, { entry }) => {
      if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
        throw bundleInvalid();
      }
      return total + entry.sizeBytes;
    }, 0);
    if (!Number.isSafeInteger(declaredBundleBytes) || declaredBundleBytes > SKILL_BUNDLE_MAX_BYTES) {
      throw loadLimit();
    }

    const loadedFiles = new Map<string, BundleFile>();
    let actualBundleBytes = 0;
    for (const { entry, relativePath } of regularFiles) {
      const read = await this.#sourceCall(() =>
        this.#sources.readBytes({
          workspaceId,
          sourceId: skill.sourceId,
          path: entry.path,
          offset: 0,
          maxBytes: Math.max(1, entry.sizeBytes)
        })
      );
      if (!read.eof || read.bytesRead !== entry.sizeBytes || read.bytes.byteLength !== entry.sizeBytes) {
        throw bundleInvalid();
      }
      actualBundleBytes += read.bytes.byteLength;
      if (actualBundleBytes > SKILL_BUNDLE_MAX_BYTES) {
        throw loadLimit();
      }
      loadedFiles.set(relativePath, {
        path: relativePath,
        bytes: read.bytes.slice(),
        sha256: fingerprintSkillDescriptor(read.bytes)
      });
    }

    const skillDocument = loadedFiles.get("SKILL.md");
    if (skillDocument === undefined) {
      throw bundleInvalid();
    }
    if (skillDocument.sha256 !== skill.descriptor.descriptorFingerprint) {
      throw fingerprintMismatch();
    }

    const fingerprintRecords = [...loadedFiles.values()].map((file) => ({
      path: file.path,
      bytes: file.bytes.byteLength,
      sha256: file.sha256
    }));
    const resources = [...loadedFiles.values()]
      .filter((file) => file.path !== "SKILL.md")
      .sort((left, right) => compareUtf8(left.path, right.path))
      .map(resourceInventoryEntry);
    const inspection: SkillLiveInspection = {
      descriptor: cloneDescriptor(skill.descriptor),
      frontmatter: frontmatterFrom(skill.parsed),
      resources,
      bundleFingerprint: fingerprintSkillBundle(fingerprintRecords),
      bundleBytes: actualBundleBytes
    };

    return {
      inspection,
      parsed: skill.parsed,
      skillDocument: skillDocument.bytes.slice(),
      files: loadedFiles
    };
  }

  #requirePins(): SkillPinStore {
    if (this.#pins === undefined) {
      throw new SkillError("SKILL_PIN_INVALID", "Pinned skill storage is unavailable");
    }
    return this.#pins;
  }

  async #hasPinned(skillId: string, fingerprint: string): Promise<boolean> {
    if (this.#pins === undefined) return false;
    return (await this.#pins.list()).some(
      (manifest) => manifest.skillId === skillId && manifest.fingerprint === fingerprint
    );
  }

  async #loadPinned(
    skillId: string,
    fingerprint: string | undefined
  ): Promise<SkillPinnedRawLoad | undefined> {
    if (this.#pins === undefined) return undefined;
    if (fingerprint !== undefined) {
      try {
        return await this.#pins.load(skillId, fingerprint);
      } catch (error) {
        if (error instanceof SkillError && error.code === "SKILL_NOT_FOUND") return undefined;
        throw error;
      }
    }

    const manifests = (await this.#pins.list())
      .filter((manifest) => manifest.skillId === skillId)
      .sort((left, right) =>
        compareUtf8(right.provenance.pinnedAt, left.provenance.pinnedAt) ||
        compareUtf8(left.fingerprint, right.fingerprint)
      );
    const selected = manifests[0];
    if (selected === undefined) return undefined;
    return this.#pins.load(selected.skillId, selected.fingerprint);
  }

  async #sourceCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SkillError) {
        throw error;
      }
      throw new SkillError("SKILL_SOURCE_UNAVAILABLE", "Skill source operation failed");
    }
  }
}

function versionKey(skillId: string, fingerprint: string): string {
  return `${skillId}\0${fingerprint}`;
}

function inspectionFromBundle(bundle: BuiltBundle, pinned: boolean): SkillCatalogInspection {
  const descriptor = bundle.inspection.descriptor;
  return {
    skill: {
      skillId: descriptor.skillId,
      name: descriptor.name,
      description: descriptor.description,
      sourceId: descriptor.sourceId,
      sourceKind: descriptor.sourceKind,
      fingerprint: bundle.inspection.bundleFingerprint,
      descriptorFingerprint: descriptor.descriptorFingerprint,
      nameCollision: descriptor.nameCollision,
      compatibility: cloneCompatibilityReport(descriptor.compatibility),
      availability: pinned ? "live+pinned" : "live",
      pinned
    },
    capabilityPlan: buildSkillCapabilityPlan(bundle.parsed, descriptor.compatibility),
    requirementGraph: buildSkillRequirementGraph(bundle.parsed, descriptor.compatibility),
    frontmatter: frontmatterFrom(bundle.parsed),
    resources: bundle.inspection.resources.map((resource) => ({ ...resource })),
    instructionBytes: Buffer.byteLength(bundle.parsed.instructions, "utf8"),
    bundleBytes: bundle.inspection.bundleBytes
  };
}

function inspectionFromPinned(pinned: SkillPinnedRawLoad): SkillCatalogInspection {
  const parsed = parsePinnedSkillDocument(pinned);
  const skill = entryFromPinnedLoad(pinned);
  const resources = pinned.resources
    .map((resource) =>
      resourceInventoryEntry({
        path: resource.path,
        bytes: resource.bytes,
        sha256: resource.sha256
      })
    )
    .sort((left, right) => compareUtf8(left.path, right.path));
  return {
    skill,
    capabilityPlan: buildSkillCapabilityPlan(parsed, skill.compatibility),
    requirementGraph: buildSkillRequirementGraph(parsed, skill.compatibility),
    frontmatter: frontmatterFrom(parsed),
    resources,
    instructionBytes: Buffer.byteLength(parsed.instructions, "utf8"),
    bundleBytes: pinned.manifest.files.reduce((total, file) => total + file.bytes, 0)
  };
}

function parsePinnedSkillDocument(pinned: SkillPinnedRawLoad): ParsedSkillDocument {
  let parsed: ParsedSkillDocument;
  try {
    parsed = parseSkillDocument(pinned.skillDocument, pinned.manifest.name);
  } catch {
    throw bundleInvalid();
  }
  if (parsed.description !== pinned.manifest.description) throw bundleInvalid();
  return parsed;
}

function entryFromPinnedLoad(pinned: SkillPinnedRawLoad): SkillCatalogEntry {
  const skillDocument = pinned.manifest.files.find((file) => file.path === "SKILL.md");
  if (skillDocument === undefined) throw bundleInvalid();
  const parsed = parsePinnedSkillDocument(pinned);
  return {
    skillId: pinned.manifest.skillId,
    name: pinned.manifest.name,
    description: pinned.manifest.description,
    sourceId: pinned.manifest.provenance.sourceId,
    sourceKind: pinned.manifest.provenance.sourceKind,
    fingerprint: pinned.manifest.fingerprint,
    descriptorFingerprint: skillDocument.sha256,
    nameCollision: false,
    compatibility: analyzeSkillCompatibility(parsed),
    availability: "pinned",
    pinned: true
  };
}

function compareCatalogEntries(left: SkillCatalogEntry, right: SkillCatalogEntry): number {
  return (
    compareUtf8(left.name, right.name) ||
    compareUtf8(left.sourceId, right.sourceId) ||
    compareUtf8(left.skillId, right.skillId) ||
    compareUtf8(left.fingerprint, right.fingerprint)
  );
}

function bundleResources(bundle: BuiltBundle): SkillRawResource[] {
  return [...bundle.files.values()]
    .filter((file) => file.path !== "SKILL.md")
    .sort((left, right) => compareUtf8(left.path, right.path))
    .map((file) => ({
      path: file.path,
      bytes: file.bytes.slice(),
      sha256: file.sha256
    }));
}

function rawLoadFromBundle(bundle: BuiltBundle, requestedPaths: string[] | undefined): SkillLiveRawLoad {
  const requested = validateRequestedResources(
    requestedPaths,
    bundle.inspection.resources.map((resource) => resource.path)
  );
  return {
    descriptor: cloneDescriptor(bundle.inspection.descriptor),
    bundleFingerprint: bundle.inspection.bundleFingerprint,
    skillDocument: bundle.skillDocument.slice(),
    resources: requested.map((path) => {
      const file = bundle.files.get(path);
      if (file === undefined) throw resourceUnsupported();
      return { path, bytes: file.bytes.slice(), sha256: file.sha256 };
    })
  };
}

function rawLoadFromPinned(
  pinned: SkillPinnedRawLoad,
  requestedPaths: string[] | undefined
): SkillCatalogRawLoad {
  const requested = validateRequestedResources(
    requestedPaths,
    pinned.resources.map((resource) => resource.path)
  );
  const resourcesByPath = new Map(pinned.resources.map((resource) => [resource.path, resource]));
  const skillDocument = pinned.manifest.files.find((file) => file.path === "SKILL.md");
  if (skillDocument === undefined) throw bundleInvalid();
  const parsed = parsePinnedSkillDocument(pinned);
  return {
    descriptor: {
      skillId: pinned.manifest.skillId,
      name: pinned.manifest.name,
      description: pinned.manifest.description,
      sourceId: pinned.manifest.provenance.sourceId,
      sourceKind: pinned.manifest.provenance.sourceKind,
      descriptorFingerprint: skillDocument.sha256,
      nameCollision: false,
      compatibility: analyzeSkillCompatibility(parsed),
      unknownMetadataKeys: [...parsed.unknownMetadataKeys]
    },
    bundleFingerprint: pinned.manifest.fingerprint,
    skillDocument: pinned.skillDocument.slice(),
    resources: requested.map((path) => {
      const resource = resourcesByPath.get(path);
      if (resource === undefined) throw resourceUnsupported();
      return { path, bytes: resource.bytes.slice(), sha256: resource.sha256 };
    }),
    availability: "pinned",
    pinned: true
  };
}

function validateRequestedResources(
  requestedPaths: string[] | undefined,
  availablePaths: string[]
): string[] {
  const requested = requestedPaths ?? [];
  if (requested.length > MAX_LOADED_RESOURCES) throw loadLimit();
  if (new Set(requested).size !== requested.length) throw resourceUnsupported();
  const available = new Set(availablePaths);
  for (const path of requested) {
    if (!available.has(path)) throw resourceUnsupported();
  }
  return [...requested].sort(compareUtf8);
}

function resourceInventoryEntry(file: BundleFile): SkillResourceInventoryEntry {
  const text = isStrictText(file.bytes);
  return {
    path: file.path,
    bytes: file.bytes.byteLength,
    sha256: file.sha256,
    kind: text ? "text" : "binary",
    textInlineEligible: text && file.bytes.byteLength <= RESOURCE_TEXT_MAX_BYTES
  };
}

function isStrictText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) {
    return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function frontmatterFrom(parsed: ParsedSkillDocument): SkillValidatedFrontmatter {
  const result: SkillValidatedFrontmatter = {
    name: parsed.name,
    description: parsed.description,
    unknownMetadataKeys: [...parsed.unknownMetadataKeys]
  };
  if (parsed.license !== undefined) result.license = parsed.license;
  if (parsed.compatibility !== undefined) result.compatibility = parsed.compatibility;
  if (parsed.metadata !== undefined) result.metadata = cloneRecord(parsed.metadata);
  if (parsed.allowedTools !== undefined) {
    result.allowedTools = Array.isArray(parsed.allowedTools)
      ? [...parsed.allowedTools]
      : parsed.allowedTools;
  }
  return result;
}

function cloneDescriptor(descriptor: LiveSkillDescriptor): LiveSkillDescriptor {
  return {
    ...descriptor,
    compatibility: cloneCompatibilityReport(descriptor.compatibility),
    unknownMetadataKeys: [...descriptor.unknownMetadataKeys]
  };
}

function cloneCompatibilityReport(report: SkillCompatibilityReport): SkillCompatibilityReport {
  return {
    ...report,
    requiredCapabilities: [...report.requiredCapabilities],
    missingCapabilities: [...report.missingCapabilities],
    requiredProviders: [...report.requiredProviders],
    reasons: [...report.reasons]
  };
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneValue(nested)]));
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isRecord(value)) return cloneRecord(value);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deriveSkillId(sourceId: string, name: string): string {
  return `sk_${fingerprintSkillDescriptor(Buffer.from(`${sourceId}\0${name}`, "utf8"))}`;
}

function requireExpectedFingerprint(actual: string, expected: string | undefined): void {
  if (expected !== undefined && actual !== expected) {
    throw fingerprintMismatch();
  }
}

function compareDiscoveredSkills(left: DiscoveredSkill, right: DiscoveredSkill): number {
  return (
    compareUtf8(left.descriptor.name, right.descriptor.name) ||
    compareUtf8(left.descriptor.sourceId, right.descriptor.sourceId) ||
    compareUtf8(left.descriptor.skillId, right.descriptor.skillId)
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function fingerprintMismatch(): SkillError {
  return new SkillError("SKILL_FINGERPRINT_MISMATCH", "Skill fingerprint does not match");
}

function isUnavailableSourceError(error: unknown): boolean {
  return error instanceof SkillError && error.code === "SKILL_SOURCE_UNAVAILABLE";
}

function resourceUnsupported(): SkillError {
  return new SkillError("SKILL_RESOURCE_UNSUPPORTED", "Skill resource is unsupported");
}

function loadLimit(): SkillError {
  return new SkillError("SKILL_LOAD_LIMIT_EXCEEDED", "Skill load limit exceeded");
}

function bundleInvalid(): SkillError {
  return new SkillError("SKILL_BUNDLE_INVALID", "Skill bundle is invalid");
}
