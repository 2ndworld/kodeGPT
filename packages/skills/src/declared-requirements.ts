import { Buffer } from "node:buffer";

const MAX_DECLARED_REQUIREMENTS = 64;
const MAX_REQUIREMENT_BYTES = 256;
const MAX_CORE_ACTIONS = 32;
const MAX_STAGES = 16;
const MAX_STAGE_ACTIONS = 32;
const MAX_STAGE_CAPABILITIES = 16;
const MAX_STAGE_PROVIDERS = 8;
const MAX_STAGE_ID_BYTES = 64;
const MAX_STAGE_DESCRIPTION_BYTES = 1024;
const STAGE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface KodegptDeclaredStage {
  readonly id: string;
  readonly description?: string;
  readonly actions: readonly string[];
  readonly capabilities: readonly string[];
  readonly providers: readonly string[];
}

export interface KodegptDeclaredRequirements {
  readonly present: boolean;
  readonly valid: boolean;
  readonly actions: readonly string[];
  readonly capabilities: readonly string[];
  readonly providers: readonly string[];
  readonly unsupported: readonly string[];
  readonly stages: readonly KodegptDeclaredStage[];
}

const EMPTY = Object.freeze({
  present: false,
  valid: true,
  actions: Object.freeze([]),
  capabilities: Object.freeze([]),
  providers: Object.freeze([]),
  unsupported: Object.freeze([]),
  stages: Object.freeze([])
}) satisfies KodegptDeclaredRequirements;

export function readKodegptDeclaredRequirements(
  metadata: Record<string, unknown> | undefined
): KodegptDeclaredRequirements {
  if (metadata === undefined || !Object.hasOwn(metadata, "kodegpt")) return EMPTY;
  if (!isRecord(metadata.kodegpt)) return invalidResult();

  const kodegpt = metadata.kodegpt;
  let valid = true;
  let actions: string[] = [];
  let capabilities: string[] = [];
  let providers: string[] = [];
  let unsupported: string[] = [];
  let stages: KodegptDeclaredStage[] = [];

  if (kodegpt.requires !== undefined) {
    if (!isRecord(kodegpt.requires)) {
      valid = false;
    } else {
      const parsedActions = stringArray(kodegpt.requires.actions, MAX_CORE_ACTIONS);
      const parsedCapabilities = stringArray(kodegpt.requires.capabilities, MAX_DECLARED_REQUIREMENTS);
      const parsedProviders = stringArray(kodegpt.requires.providers, MAX_DECLARED_REQUIREMENTS);
      if (kodegpt.requires.actions !== undefined && parsedActions === undefined) valid = false;
      if (kodegpt.requires.capabilities !== undefined && parsedCapabilities === undefined) valid = false;
      if (kodegpt.requires.providers !== undefined && parsedProviders === undefined) valid = false;
      actions = parsedActions ?? [];
      capabilities = parsedCapabilities ?? [];
      providers = parsedProviders ?? [];
    }
  }

  if (kodegpt.providers !== undefined) {
    const legacyProviders = stringArray(kodegpt.providers, MAX_DECLARED_REQUIREMENTS);
    if (legacyProviders === undefined) valid = false;
    else providers.push(...legacyProviders);
  }

  if (kodegpt.unsupported !== undefined) {
    const parsedUnsupported = stringArray(kodegpt.unsupported, MAX_DECLARED_REQUIREMENTS);
    if (parsedUnsupported === undefined) valid = false;
    else unsupported = parsedUnsupported;
  }

  if (kodegpt.stages !== undefined) {
    const parsedStages = stageArray(kodegpt.stages);
    if (parsedStages === undefined) valid = false;
    else stages = parsedStages;
  }

  return freezeResult({
    present: true,
    valid,
    actions: uniqueStrings(actions),
    capabilities: uniqueStrings(capabilities),
    providers: uniqueStrings(providers),
    unsupported: uniqueStrings(unsupported),
    stages
  });
}

function stageArray(value: unknown): KodegptDeclaredStage[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_STAGES) return undefined;
  const result: KodegptDeclaredStage[] = [];
  const ids = new Set<string>();

  for (const raw of value) {
    if (!isRecord(raw) || !validStageId(raw.id) || ids.has(raw.id)) return undefined;
    const actions = optionalStringArray(raw.actions, MAX_STAGE_ACTIONS);
    const capabilities = optionalStringArray(raw.capabilities, MAX_STAGE_CAPABILITIES);
    const providers = optionalStringArray(raw.providers, MAX_STAGE_PROVIDERS);
    if (actions === undefined || capabilities === undefined || providers === undefined) return undefined;
    if (
      raw.description !== undefined &&
      (typeof raw.description !== "string" ||
        raw.description.length === 0 ||
        Buffer.byteLength(raw.description, "utf8") > MAX_STAGE_DESCRIPTION_BYTES)
    ) {
      return undefined;
    }

    ids.add(raw.id);
    result.push(
      Object.freeze({
        id: raw.id,
        ...(typeof raw.description === "string" ? { description: raw.description } : {}),
        actions: Object.freeze(uniqueStrings(actions)),
        capabilities: Object.freeze(uniqueStrings(capabilities)),
        providers: Object.freeze(uniqueStrings(providers))
      })
    );
  }

  return result;
}

function optionalStringArray(value: unknown, maxItems: number): string[] | undefined {
  if (value === undefined) return [];
  return stringArray(value, maxItems);
}

function stringArray(value: unknown, maxItems: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const result: string[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      Buffer.byteLength(item, "utf8") > MAX_REQUIREMENT_BYTES
    ) {
      return undefined;
    }
    result.push(item);
  }
  return result;
}

function validStageId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_STAGE_ID_BYTES &&
    STAGE_ID_PATTERN.test(value)
  );
}

function invalidResult(): KodegptDeclaredRequirements {
  return freezeResult({
    present: true,
    valid: false,
    actions: [],
    capabilities: [],
    providers: [],
    unsupported: [],
    stages: []
  });
}

function freezeResult(input: {
  present: boolean;
  valid: boolean;
  actions: readonly string[];
  capabilities: readonly string[];
  providers: readonly string[];
  unsupported: readonly string[];
  stages: readonly KodegptDeclaredStage[];
}): KodegptDeclaredRequirements {
  return Object.freeze({
    present: input.present,
    valid: input.valid,
    actions: Object.freeze([...input.actions]),
    capabilities: Object.freeze([...input.capabilities]),
    providers: Object.freeze([...input.providers]),
    unsupported: Object.freeze([...input.unsupported]),
    stages: Object.freeze([...input.stages])
  });
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareUtf8);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
