export const SKILL_STATE_SCHEMA_VERSION = 1 as const;
export const MAX_SOURCES = 16;
export const MAX_SKILLS_PER_SOURCE = 1_000;
export const MAX_SOURCE_ENTRIES = 20_000;
export const SKILL_DESCRIPTOR_MAX_BYTES = 64 * 1024;
export const SKILL_MD_MAX_BYTES = 256 * 1024;
export const MAX_RESOURCES_PER_SKILL = 256;
export const MAX_LOADED_RESOURCES = 64;
export const RESOURCE_TEXT_MAX_BYTES = 256 * 1024;
export const SKILL_BUNDLE_MAX_BYTES = 1024 * 1024;
export const SKILL_LOAD_MAX_BYTES = 1024 * 1024;
export const MAX_SKILL_NAME_BYTES = 128;
export const MAX_DESCRIPTION_BYTES = 4 * 1024;

export interface PersistedSkillSourceIdentity {
  deviceMajor: number;
  deviceMinor: number;
  inode: string;
}

export interface PersistedSkillSource {
  sourceId: string;
  label: string;
  kind: "agent-skills";
  canonicalRoot: string;
  identity: PersistedSkillSourceIdentity;
}

export interface SkillSourceAdmissionInput {
  label: string;
  kind: "agent-skills";
  canonicalRoot: string;
  identity: PersistedSkillSourceIdentity;
}

export interface SkillBundleFingerprintRecord {
  path: string;
  bytes: number;
  sha256: string;
}

export type SkillDiscoveryTruncationReason =
  | "SOURCE_ENTRY_LIMIT"
  | "SKILL_COUNT_LIMIT"
  | "DESCRIPTOR_SIZE_LIMIT";

export interface LiveSkillDescriptor {
  skillId: string;
  name: string;
  description: string;
  sourceId: string;
  sourceKind: "agent-skills";
  descriptorFingerprint: string;
  nameCollision: boolean;
  unknownMetadataKeys: string[];
}

export interface SkillLiveListResult {
  skills: LiveSkillDescriptor[];
  truncated: boolean;
  truncationReasons: SkillDiscoveryTruncationReason[];
}

export interface SkillValidatedFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  allowedTools?: string[] | string;
  unknownMetadataKeys: string[];
}

export interface SkillResourceInventoryEntry {
  path: string;
  bytes: number;
  sha256: string;
  kind: "text" | "binary";
  textInlineEligible: boolean;
}

export interface SkillLiveInspection {
  descriptor: LiveSkillDescriptor;
  frontmatter: SkillValidatedFrontmatter;
  resources: SkillResourceInventoryEntry[];
  bundleFingerprint: string;
  bundleBytes: number;
}

export interface SkillRawResource {
  path: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface SkillLiveRawLoad {
  descriptor: LiveSkillDescriptor;
  bundleFingerprint: string;
  skillDocument: Uint8Array;
  resources: SkillRawResource[];
}

export interface ParsedSkillDocument {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  allowedTools?: string[] | string;
  unknownMetadataKeys: string[];
  instructions: string;
}

export interface SkillSourceAdmissionResult {
  sourceId: string;
  label: string;
  kind: "agent-skills";
}

export interface SkillSourceRootInspection {
  canonicalRoot: string;
  identity: PersistedSkillSourceIdentity;
}

export type SkillSourceTreeEntryKind = "file" | "directory" | "symlink" | "other";

export interface SkillSourceTreeEntry {
  path: string;
  kind: SkillSourceTreeEntryKind;
  sizeBytes: number;
}

export interface SkillSourceTreeResult {
  entries: SkillSourceTreeEntry[];
  truncated: boolean;
}

export interface SkillSourceReadResult {
  contents: string;
  bytesRead: number;
  eof: boolean;
}

export interface SkillSourceReadBytesResult {
  bytes: Uint8Array;
  bytesRead: number;
  eof: boolean;
}

export interface SkillSourceRuntimeAdapter {
  inspectRoot(path: string): Promise<SkillSourceRootInspection>;
  register(input: {
    rootPath: string;
    expectedIdentity: PersistedSkillSourceIdentity;
  }): Promise<{ sourceCapabilityId: string }>;
  tree(input: {
    sourceCapabilityId: string;
    path: string;
    maxEntries: number;
  }): Promise<SkillSourceTreeResult>;
  read(input: {
    sourceCapabilityId: string;
    path: string;
    offset: number;
    maxBytes: number;
  }): Promise<SkillSourceReadResult>;
  readBytes(input: {
    sourceCapabilityId: string;
    path: string;
    offset: number;
    maxBytes: number;
  }): Promise<SkillSourceReadBytesResult>;
  unregister(sourceCapabilityId: string): Promise<void>;
}
