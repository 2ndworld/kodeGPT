export const SKILL_STATE_SCHEMA_VERSION = 1 as const;
export const MAX_SOURCES = 16;
export const MAX_SKILLS_PER_SOURCE = 1_000;
export const MAX_SOURCE_ENTRIES = 20_000;
export const SKILL_DESCRIPTOR_MAX_BYTES = 64 * 1024;
export const SKILL_MD_MAX_BYTES = 256 * 1024;
export const MAX_RESOURCES_PER_SKILL = 256;
export const RESOURCE_TEXT_MAX_BYTES = 256 * 1024;
export const SKILL_BUNDLE_MAX_BYTES = 1024 * 1024;
export const SKILL_LOAD_MAX_BYTES = 1024 * 1024;

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
