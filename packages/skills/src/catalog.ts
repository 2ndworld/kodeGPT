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
  type SkillDiscoveryTruncationReason,
  type SkillLiveInspection,
  type SkillLiveListResult,
  type SkillLiveRawLoad,
  type SkillRawResource,
  type SkillResourceInventoryEntry,
  type SkillSourceReadBytesResult,
  type SkillSourceTreeResult,
  type SkillValidatedFrontmatter
} from "./contracts.js";
import { SkillError } from "./errors.js";
import { fingerprintSkillBundle, fingerprintSkillDescriptor } from "./fingerprint.js";
import { SkillDocumentParseError, parseSkillDocument } from "./parser.js";

interface SkillCatalogSourceManager {
  listSources(): Promise<PersistedSkillSource[]>;
  tree(input: { sourceId: string; path: string }): Promise<SkillSourceTreeResult>;
  readBytes(input: {
    sourceId: string;
    path: string;
    offset: number;
    maxBytes: number;
  }): Promise<SkillSourceReadBytesResult>;
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
  skillDocument: Uint8Array;
  files: Map<string, BundleFile>;
}

const TRUNCATION_REASON_ORDER: SkillDiscoveryTruncationReason[] = [
  "SOURCE_ENTRY_LIMIT",
  "SKILL_COUNT_LIMIT",
  "DESCRIPTOR_SIZE_LIMIT"
];

export class SkillCatalog {
  readonly #sources: SkillCatalogSourceManager;

  constructor(sources: SkillCatalogSourceManager) {
    this.#sources = sources;
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

    const requested = input.resources ?? [];
    if (requested.length > MAX_LOADED_RESOURCES) {
      throw loadLimit();
    }
    if (new Set(requested).size !== requested.length) {
      throw resourceUnsupported();
    }
    const inventoryPaths = new Set(bundle.inspection.resources.map((resource) => resource.path));
    for (const path of requested) {
      if (!inventoryPaths.has(path)) {
        throw resourceUnsupported();
      }
    }

    const resources: SkillRawResource[] = [...requested]
      .sort(compareUtf8)
      .map((path) => {
        const file = bundle.files.get(path);
        if (file === undefined) {
          throw resourceUnsupported();
        }
        return {
          path,
          bytes: file.bytes.slice(),
          sha256: file.sha256
        };
      });

    return {
      descriptor: cloneDescriptor(bundle.inspection.descriptor),
      bundleFingerprint: bundle.inspection.bundleFingerprint,
      skillDocument: bundle.skillDocument.slice(),
      resources
    };
  }

  async #discover(): Promise<DiscoveryResult> {
    const truncationReasons = new Set<SkillDiscoveryTruncationReason>();
    const discovered: DiscoveredSkill[] = [];
    const sources = (await this.#sourceCall(() => this.#sources.listSources())).sort((left, right) =>
      compareUtf8(left.sourceId, right.sourceId)
    );

    for (const source of sources) {
      const tree = await this.#sourceCall(() =>
        this.#sources.tree({ sourceId: source.sourceId, path: "." })
      );
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

        const read = await this.#sourceCall(() =>
          this.#sources.readBytes({
            sourceId: source.sourceId,
            path: `${relativeDirectory}/SKILL.md`,
            offset: 0,
            maxBytes: SKILL_MD_MAX_BYTES
          })
        );
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

  async #findLiveSkill(skillId: string): Promise<DiscoveredSkill> {
    const discovery = await this.#discover();
    const skill = discovery.skills.find((candidate) => candidate.descriptor.skillId === skillId);
    if (skill === undefined) {
      throw new SkillError("SKILL_NOT_FOUND", "Skill was not found");
    }
    return skill;
  }

  async #buildBundle(skill: DiscoveredSkill): Promise<BuiltBundle> {
    const tree = await this.#sourceCall(() =>
      this.#sources.tree({ sourceId: skill.sourceId, path: skill.relativeDirectory })
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
      skillDocument: skillDocument.bytes.slice(),
      files: loadedFiles
    };
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
    unknownMetadataKeys: [...descriptor.unknownMetadataKeys]
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

function resourceUnsupported(): SkillError {
  return new SkillError("SKILL_RESOURCE_UNSUPPORTED", "Skill resource is unsupported");
}

function loadLimit(): SkillError {
  return new SkillError("SKILL_LOAD_LIMIT_EXCEEDED", "Skill load limit exceeded");
}

function bundleInvalid(): SkillError {
  return new SkillError("SKILL_BUNDLE_INVALID", "Skill bundle is invalid");
}
