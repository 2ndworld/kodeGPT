import { Buffer } from "node:buffer";

import { NATIVE_CAPABILITY_IDS } from "@kodegpt/capabilities";

import type {
  ParsedSkillDocument,
  SkillCompatibility,
  SkillCompatibilityAnalysisBasis,
  SkillCompatibilityReport
} from "./contracts.js";

const MAX_DECLARED_REQUIREMENTS = 64;
const MAX_REQUIREMENT_BYTES = 256;
const NATIVE_CAPABILITIES = new Set<string>(NATIVE_CAPABILITY_IDS);
const INLINE_CODE_PATTERN = /`([^`\r\n]{1,512})`/g;
const INLINE_COMMAND_PREFIX_PATTERN = /(?:\b(?:run|execute|invoke|launch)\s*|\b(?:command|cli)\s*:\s*)$/i;
const SHELL_FENCE_PATTERN = /```(?:bash|sh|shell|zsh|console|terminal)[ \t]*\r?\n([\s\S]*?)```/gi;
const CODEX_EXEC_PATTERN = /\bcodex\s+exec\b/i;
const CODEX_COMMAND_PATTERN = /^codex(?:\s|$)/i;
const CODEX_PROSE_COMMAND_PATTERN = /\b(?:run|use|invoke|execute|call)\s+codex(?!\s+exec\b)(?=\s|[.,;:!?)]|$)/i;
const SUBAGENT_SESSION_PATTERN = /\bsub[- ]?agent\b[^\n.]{0,80}\bsession\b|\bsession\b[^\n.]{0,80}\bsub[- ]?agent\b/i;
const SUBAGENT_REQUIREMENT_PATTERN = /\b(?:use|spawn|create|start)\s+(?:an?\s+)?sub[- ]?agent\b|\bdelegate\b[^\n.]{0,80}\bto\s+(?:an?\s+)?sub[- ]?agent\b/i;

interface DeclaredRequirements {
  present: boolean;
  valid: boolean;
  capabilities: string[];
  providers: string[];
  unsupported: string[];
}

export function analyzeSkillCompatibility(skill: ParsedSkillDocument): SkillCompatibilityReport {
  const requiredCapabilities = new Set<string>();
  const missingCapabilities = new Set<string>();
  const requiredProviders = new Set<string>();
  const reasons = new Set<string>();
  const declared = readDeclaredRequirements(skill.metadata);
  let hasStaticFinding = false;
  let unsupported = false;
  let partial = false;

  if (declared.present) {
    if (!declared.valid) {
      partial = true;
      missingCapabilities.add("declared.requirements");
      reasons.add("DECLARED_REQUIREMENTS_INVALID");
    }
    for (const capability of declared.capabilities) {
      requiredCapabilities.add(capability);
      if (!NATIVE_CAPABILITIES.has(capability)) {
        partial = true;
        missingCapabilities.add(capability);
        reasons.add(`MISSING_CAPABILITY:${capability}`);
      }
    }
    for (const provider of declared.providers) {
      requiredProviders.add(provider);
      reasons.add(`PROVIDER_REQUIRED:${provider}`);
    }
    for (const requirement of declared.unsupported) {
      unsupported = true;
      missingCapabilities.add(`unsupported:${requirement}`);
      reasons.add(`DECLARED_UNSUPPORTED:${requirement}`);
    }
  }

  for (const capability of NATIVE_CAPABILITY_IDS) {
    if (containsCapabilityReference(skill.instructions, capability)) {
      requiredCapabilities.add(capability);
      hasStaticFinding = true;
    }
  }

  if (CODEX_EXEC_PATTERN.test(skill.instructions)) {
    unsupported = true;
    hasStaticFinding = true;
    missingCapabilities.add("codex.exec");
    reasons.add("CODEX_EXEC_UNSUPPORTED");
  }
  if (CODEX_PROSE_COMMAND_PATTERN.test(skill.instructions)) {
    unsupported = true;
    hasStaticFinding = true;
    missingCapabilities.add("codex.runtime");
    reasons.add("CODEX_RUNTIME_UNSUPPORTED");
  }
  if (
    SUBAGENT_SESSION_PATTERN.test(skill.instructions) ||
    SUBAGENT_REQUIREMENT_PATTERN.test(skill.instructions)
  ) {
    unsupported = true;
    hasStaticFinding = true;
    missingCapabilities.add("subagent.session");
    reasons.add("SUBAGENT_SESSION_UNSUPPORTED");
  }

  for (const snippet of inlineCodeSnippets(skill.instructions)) {
    if (CODEX_EXEC_PATTERN.test(snippet)) continue;
    if (CODEX_COMMAND_PATTERN.test(snippet)) {
      unsupported = true;
      hasStaticFinding = true;
      missingCapabilities.add("codex.runtime");
      reasons.add("CODEX_RUNTIME_UNSUPPORTED");
    }
  }

  for (const snippet of [
    ...inlineCommandSnippets(skill.instructions),
    ...shellCommandSnippets(skill.instructions)
  ]) {
    const nativeCommand = nativeCapabilityForCommand(snippet);
    if (nativeCommand !== undefined) {
      requiredCapabilities.add(nativeCommand);
      hasStaticFinding = true;
      continue;
    }
    if (CODEX_EXEC_PATTERN.test(snippet) || CODEX_COMMAND_PATTERN.test(snippet)) continue;

    const externalCli = externalCliName(snippet);
    if (externalCli !== undefined) {
      partial = true;
      hasStaticFinding = true;
      const missing = `external-cli:${externalCli}`;
      missingCapabilities.add(missing);
      reasons.add(`EXTERNAL_CLI_REQUIRED:${externalCli}`);
    }
  }

  const classification: SkillCompatibility = unsupported
    ? "UNSUPPORTED"
    : requiredProviders.size > 0
      ? "PROVIDER_REQUIRED"
      : partial
        ? "PARTIAL"
        : "NATIVE";

  if (classification === "NATIVE" && reasons.size === 0) {
    reasons.add("NATIVE_REQUIREMENTS_SATISFIED");
  }

  return {
    classification,
    requiredCapabilities: sortedUnique(requiredCapabilities),
    missingCapabilities: sortedUnique(missingCapabilities),
    requiredProviders: sortedUnique(requiredProviders),
    reasons: sortedUnique(reasons),
    analysisBasis: analysisBasis(declared.present, hasStaticFinding)
  };
}

function readDeclaredRequirements(metadata: Record<string, unknown> | undefined): DeclaredRequirements {
  if (metadata === undefined || !Object.hasOwn(metadata, "kodegpt")) {
    return { present: false, valid: true, capabilities: [], providers: [], unsupported: [] };
  }
  if (!isRecord(metadata.kodegpt)) {
    return { present: true, valid: false, capabilities: [], providers: [], unsupported: [] };
  }

  const kodegpt = metadata.kodegpt;
  let valid = true;
  let capabilities: string[] = [];
  let providers: string[] = [];
  let unsupported: string[] = [];

  if (kodegpt.requires !== undefined) {
    if (!isRecord(kodegpt.requires)) {
      valid = false;
    } else {
      const parsedCapabilities = stringArray(kodegpt.requires.capabilities);
      const parsedProviders = stringArray(kodegpt.requires.providers);
      if (kodegpt.requires.capabilities !== undefined && parsedCapabilities === undefined) valid = false;
      if (kodegpt.requires.providers !== undefined && parsedProviders === undefined) valid = false;
      capabilities = parsedCapabilities ?? [];
      providers = parsedProviders ?? [];
    }
  }

  if (kodegpt.providers !== undefined) {
    const legacyProviders = stringArray(kodegpt.providers);
    if (legacyProviders === undefined) {
      valid = false;
    } else {
      providers.push(...legacyProviders);
    }
  }
  if (kodegpt.unsupported !== undefined) {
    const parsedUnsupported = stringArray(kodegpt.unsupported);
    if (parsedUnsupported === undefined) {
      valid = false;
    } else {
      unsupported = parsedUnsupported;
    }
  }

  return {
    present: true,
    valid,
    capabilities: uniqueStrings(capabilities),
    providers: uniqueStrings(providers),
    unsupported: uniqueStrings(unsupported)
  };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_DECLARED_REQUIREMENTS) return undefined;
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

function containsCapabilityReference(instructions: string, capability: string): boolean {
  const escaped = capability.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-zA-Z0-9_.-])${escaped}([^a-zA-Z0-9_.-]|$)`, "u").test(instructions);
}

function inlineCodeSnippets(instructions: string): string[] {
  const snippets: string[] = [];
  INLINE_CODE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_CODE_PATTERN.exec(instructions)) !== null) {
    const snippet = match[1]?.trim();
    if (snippet !== undefined && snippet.length > 0) snippets.push(snippet);
  }
  return snippets;
}

function inlineCommandSnippets(instructions: string): string[] {
  const snippets: string[] = [];
  INLINE_CODE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_CODE_PATTERN.exec(instructions)) !== null) {
    const snippet = match[1]?.trim();
    if (snippet === undefined || snippet.length === 0) continue;
    const lineStart = instructions.lastIndexOf("\n", Math.max(0, match.index - 1)) + 1;
    const prefix = instructions.slice(lineStart, match.index);
    if (INLINE_COMMAND_PREFIX_PATTERN.test(prefix)) snippets.push(snippet);
  }
  return snippets;
}

function shellCommandSnippets(instructions: string): string[] {
  const snippets: string[] = [];
  SHELL_FENCE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SHELL_FENCE_PATTERN.exec(instructions)) !== null) {
    for (const line of (match[1] ?? "").split(/\r?\n/u)) {
      const snippet = line.trim().replace(/^\$\s+/, "");
      if (snippet.length > 0 && !snippet.startsWith("#")) snippets.push(snippet);
    }
  }
  return snippets;
}

function nativeCapabilityForCommand(snippet: string): string | undefined {
  if (NATIVE_CAPABILITIES.has(snippet)) return snippet;
  const normalized = snippet.trim().replace(/\s+/g, " ");
  if (normalized === "git status") return "git.status";
  if (normalized === "git diff") return "git.diff";
  return undefined;
}

function externalCliName(snippet: string): string | undefined {
  const normalized = snippet.trim();
  const match = /^([a-zA-Z0-9][a-zA-Z0-9._+-]{0,63})\s+\S/.exec(normalized);
  if (match === null || match[1] === undefined) return undefined;
  const executable = match[1].toLowerCase();
  if (executable === "git" && /^(git\s+(status|diff))(?:\s|$)/i.test(normalized)) return undefined;
  return executable;
}

function analysisBasis(declared: boolean, staticFinding: boolean): SkillCompatibilityAnalysisBasis {
  if (declared && staticFinding) return "declared+static";
  if (declared) return "declared";
  return "static";
}

function uniqueStrings(values: string[]): string[] {
  return sortedUnique(new Set(values));
}

function sortedUnique(values: Set<string>): string[] {
  return [...values].sort(compareUtf8);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
