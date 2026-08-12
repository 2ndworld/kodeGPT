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
export const SKILL_TOOL_LIST_MAX = 500;
export const SKILL_TOOL_LOAD_RESOURCE_MAX = 32;
export const SKILL_TOOL_LOAD_MAX_BYTES = 512 * 1024;

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
  | "DESCRIPTOR_SIZE_LIMIT"
  | "SOURCE_UNAVAILABLE";

export interface LiveSkillDescriptor {
  skillId: string;
  name: string;
  description: string;
  sourceId: string;
  sourceKind: "agent-skills";
  descriptorFingerprint: string;
  nameCollision: boolean;
  compatibility: SkillCompatibilityReport;
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

export interface SkillPinnedFileRecord {
  path: string;
  bytes: number;
  sha256: string;
}

export interface SkillPinnedManifest {
  schemaVersion: typeof SKILL_STATE_SCHEMA_VERSION;
  skillId: string;
  name: string;
  description: string;
  fingerprint: string;
  provenance: {
    sourceId: string;
    sourceKind: "agent-skills";
    sourceRelativePath: string;
    pinnedAt: string;
  };
  files: SkillPinnedFileRecord[];
}

export interface SkillPinInput {
  descriptor: LiveSkillDescriptor;
  fingerprint: string;
  sourceRelativePath: string;
  skillDocument: Uint8Array;
  resources: SkillRawResource[];
}

export interface SkillPinnedRawLoad {
  manifest: SkillPinnedManifest;
  skillDocument: Uint8Array;
  resources: SkillRawResource[];
}

export type SkillAvailability = "live" | "pinned" | "live+pinned";

export interface SkillCatalogEntry {
  skillId: string;
  name: string;
  description: string;
  sourceId: string;
  sourceKind: "agent-skills";
  fingerprint: string;
  descriptorFingerprint: string;
  nameCollision: boolean;
  compatibility: SkillCompatibilityReport;
  availability: SkillAvailability;
  pinned: boolean;
}

export interface SkillCatalogListResult {
  skills: SkillCatalogEntry[];
  truncated: boolean;
  truncationReasons: SkillDiscoveryTruncationReason[];
}

export interface SkillCatalogRawLoad extends SkillLiveRawLoad {
  availability: SkillAvailability;
  pinned: boolean;
}

export interface SkillCatalogInspection {
  skill: SkillCatalogEntry;
  frontmatter: SkillValidatedFrontmatter;
  resources: SkillResourceInventoryEntry[];
  instructionBytes: number;
  bundleBytes: number;
}

export type SkillListTruncationReason = SkillDiscoveryTruncationReason | "RESULT_LIMIT";

export interface SkillListResult {
  schemaVersion: typeof SKILL_STATE_SCHEMA_VERSION;
  skills: SkillCatalogEntry[];
  truncated: boolean;
  truncationReasons: SkillListTruncationReason[];
}

export interface SkillInspectFrontmatter {
  license?: string;
  compatibility?: string;
  allowedTools?: string[] | string;
  unknownMetadataKeys: string[];
}

export interface SkillInspectResult {
  schemaVersion: typeof SKILL_STATE_SCHEMA_VERSION;
  skill: SkillCatalogEntry;
  frontmatter: SkillInspectFrontmatter;
  resources: SkillResourceInventoryEntry[];
  instructionBytes: number;
  bundleBytes: number;
}

export interface SkillLoadTextResource {
  path: string;
  contents: string;
  bytes: number;
  sha256: string;
}

export interface SkillLoadResult {
  schemaVersion: typeof SKILL_STATE_SCHEMA_VERSION;
  skillId: string;
  name: string;
  description: string;
  sourceId: string;
  sourceKind: "agent-skills";
  fingerprint: string;
  availability: SkillAvailability;
  pinned: boolean;
  compatibility: SkillCompatibilityReport;
  instructions: string;
  resources: SkillLoadTextResource[];
  totalBytes: number;
}

export interface SkillCatalogToolAdapter {
  list(input: {
    limit?: number;
    sourceId?: string;
    compatibility?: SkillCompatibility;
    pinned?: boolean;
  }): Promise<SkillListResult>;
  inspect(input: { skillId: string; fingerprint?: string }): Promise<SkillInspectResult>;
  load(input: {
    skillId: string;
    fingerprint?: string;
    resources?: string[];
    maxBytes?: number;
  }): Promise<SkillLoadResult>;
}

export type SkillCompatibility = "NATIVE" | "PARTIAL" | "PROVIDER_REQUIRED" | "UNSUPPORTED";
export type SkillCompatibilityAnalysisBasis = "declared" | "static" | "declared+static";

export interface SkillCompatibilityReport {
  classification: SkillCompatibility;
  requiredCapabilities: string[];
  missingCapabilities: string[];
  requiredProviders: string[];
  reasons: string[];
  analysisBasis: SkillCompatibilityAnalysisBasis;
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
