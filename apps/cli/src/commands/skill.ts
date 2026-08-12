import { basename, isAbsolute } from "node:path";

import type {
  SkillCatalog,
  SkillPinStore,
  SkillSourceManager,
  SkillSourceStore
} from "@kodegpt/skills";

const SOURCE_ID_PATTERN = /^ss_[a-f0-9]{32}$/;
const SKILL_ID_PATTERN = /^sk_[a-f0-9]{64}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

export interface SkillCommandDependencies {
  sourceStore: Pick<SkillSourceStore, "list" | "remove">;
  sourceManager: Pick<SkillSourceManager, "addSource">;
  catalog: Pick<SkillCatalog, "pin">;
  pinStore: Pick<SkillPinStore, "list" | "unpin">;
}

export async function runSkillCommand(
  args: string[],
  dependencies: SkillCommandDependencies
): Promise<string> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "source":
      return runSourceCommand(rest, dependencies);
    case "pin":
      return pinSkill(rest, dependencies.catalog);
    case "unpin":
      return unpinSkill(rest, dependencies.pinStore);
    default:
      throw new Error("skill command must be one of: source, pin, unpin");
  }
}

async function runSourceCommand(
  args: string[],
  dependencies: SkillCommandDependencies
): Promise<string> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "list":
      return listSources(rest, dependencies.sourceStore);
    case "add":
      return addSource(rest, dependencies.sourceManager);
    case "remove":
      return removeSource(rest, dependencies.sourceStore);
    default:
      throw new Error("skill source command must be one of: list, add, remove");
  }
}

async function listSources(
  args: string[],
  store: Pick<SkillSourceStore, "list">
): Promise<string> {
  if (args.length !== 0) throw new Error("skill source list accepts no arguments");
  const sources = await store.list();
  if (sources.length === 0) return "no skill sources";
  return [...sources]
    .sort((left, right) => compareAscii(left.sourceId, right.sourceId))
    .map((source) => `${source.sourceId}\t${source.kind}\t${source.canonicalRoot}\t${source.label}`)
    .join("\n");
}

async function addSource(
  args: string[],
  manager: Pick<SkillSourceManager, "addSource">
): Promise<string> {
  const path = args[0];
  if (path === undefined || !isAbsolute(path)) {
    throw new Error("skill source add requires an absolute path");
  }

  let kind = "agent-skills";
  let kindSeen = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--kind" || kindSeen) {
      throw new Error("skill source add accepts only --kind agent-skills");
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--kind requires agent-skills");
    }
    kind = value;
    kindSeen = true;
    index += 1;
  }
  if (kind !== "agent-skills") {
    throw new Error("skill source kind must be agent-skills");
  }

  const label = basename(path) || path;
  const source = await manager.addSource(path, label);
  return `added ${source.sourceId} ${source.kind} ${path}`;
}

async function removeSource(
  args: string[],
  store: Pick<SkillSourceStore, "remove">
): Promise<string> {
  if (args.length !== 1 || args[0] === undefined || !SOURCE_ID_PATTERN.test(args[0])) {
    throw new Error("skill source remove requires exactly one valid source id");
  }
  const sourceId = args[0];
  if (!(await store.remove(sourceId))) {
    throw new Error(`skill source not found: ${sourceId}`);
  }
  return `removed ${sourceId}`;
}

async function pinSkill(
  args: string[],
  catalog: Pick<SkillCatalog, "pin">
): Promise<string> {
  const { skillId, fingerprint } = parseSkillAndFingerprint(args, "pin");
  const pinned = await catalog.pin({
    skillId,
    expectedBundleFingerprint: fingerprint
  });
  return `pinned ${pinned.skillId} ${pinned.fingerprint}`;
}

async function unpinSkill(
  args: string[],
  pinStore: Pick<SkillPinStore, "list" | "unpin">
): Promise<string> {
  const parsed = parseSkillAndFingerprint(args, "unpin");
  let fingerprint = parsed.fingerprint;
  if (fingerprint === undefined) {
    const matches = (await pinStore.list()).filter((pin) => pin.skillId === parsed.skillId);
    if (matches.length === 0) {
      throw new Error(`pinned skill not found: ${parsed.skillId}`);
    }
    if (matches.length !== 1) {
      throw new Error("skill unpin requires --fingerprint when multiple pinned versions exist");
    }
    fingerprint = matches[0]!.fingerprint;
  }

  if (!(await pinStore.unpin(parsed.skillId, fingerprint))) {
    throw new Error(`pinned skill not found: ${parsed.skillId} ${fingerprint}`);
  }
  return `unpinned ${parsed.skillId} ${fingerprint}`;
}

function parseSkillAndFingerprint(
  args: string[],
  command: "pin" | "unpin"
): { skillId: string; fingerprint?: string } {
  const skillId = args[0];
  if (skillId === undefined || !SKILL_ID_PATTERN.test(skillId)) {
    throw new Error(`skill ${command} requires a valid skill id`);
  }

  let fingerprint: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--fingerprint" || fingerprint !== undefined) {
      throw new Error(`skill ${command} accepts only --fingerprint <sha256>`);
    }
    const value = args[index + 1];
    if (value === undefined || !FINGERPRINT_PATTERN.test(value)) {
      throw new Error("--fingerprint requires 64 lowercase hex characters");
    }
    fingerprint = value;
    index += 1;
  }

  return fingerprint === undefined ? { skillId } : { skillId, fingerprint };
}

function compareAscii(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
