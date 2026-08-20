import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  MAX_SOURCE_ENTRIES,
  SKILL_LOAD_MAX_BYTES,
  type SkillSourceReadBytesResult,
  type SkillSourceTreeEntry,
  type SkillSourceTreeResult,
  type WorkspaceSkillSourceAuthority,
  type WorkspaceSkillSourceDescriptor
} from "./contracts.js";
import { SkillError } from "./errors.js";

const CONVENTIONAL_ROOTS = ["skills", ".agents/skills", ".codex/skills"] as const;

interface WorkspaceSourceBinding {
  workspaceId: string;
  root: string;
}

export class WorkspaceSkillSourceProvider {
  readonly #authority: WorkspaceSkillSourceAuthority;
  readonly #bindings = new Map<string, WorkspaceSourceBinding>();

  constructor(authority: WorkspaceSkillSourceAuthority) {
    this.#authority = authority;
  }

  async listReadyWorkspaceIds(): Promise<string[]> {
    const ready = await this.#authority.listReady();
    return [...new Set(ready.map((entry) => entry.workspaceId))].sort(compareText);
  }

  async listSources(workspaceId: string): Promise<WorkspaceSkillSourceDescriptor[]> {
    const ready = (await this.#authority.listReady()).find((entry) => entry.workspaceId === workspaceId);
    if (ready === undefined) throw workspaceMismatch();

    for (const [sourceId, binding] of [...this.#bindings]) {
      if (binding.workspaceId === workspaceId) this.#bindings.delete(sourceId);
    }

    const sources: WorkspaceSkillSourceDescriptor[] = [];
    for (const root of CONVENTIONAL_ROOTS) {
      const identity = await this.#authority.pathIdentity(workspaceId, root);
      if (!identity.exists || identity.kind !== "directory") continue;
      const sourceId = deterministicSourceId(ready.trustId, root);
      this.#bindings.set(sourceId, { workspaceId, root });
      sources.push({
        sourceId,
        label: `Workspace skills: ${root}`,
        kind: "agent-skills"
      });
    }
    return sources;
  }

  async tree(input: {
    workspaceId: string;
    sourceId: string;
    path: string;
  }): Promise<SkillSourceTreeResult> {
    if (!isCanonicalRelativePath(input.path, true)) throw boundaryViolation();
    const binding = await this.#binding(input.workspaceId, input.sourceId);
    const workspacePath = input.path === "." ? binding.root : `${binding.root}/${input.path}`;
    const tree = await this.#authority.tree(input.workspaceId, workspacePath, MAX_SOURCE_ENTRIES);
    if (tree.entries.length > MAX_SOURCE_ENTRIES) {
      throw new SkillError("SKILL_SOURCE_LIMIT_EXCEEDED", "Workspace skill source tree exceeded bounds");
    }

    const seen = new Set<string>();
    const entries: SkillSourceTreeEntry[] = [];
    for (const entry of tree.entries) {
      const relative = stripSourceRoot(binding.root, entry.path);
      if (relative === undefined) throw boundaryViolation();
      if (relative.length === 0) continue;
      if (!isCanonicalRelativePath(relative, false) || seen.has(relative)) throw boundaryViolation();
      seen.add(relative);
      entries.push({ ...entry, path: relative });
    }
    return { entries, truncated: tree.truncated };
  }

  async readBytes(input: {
    workspaceId: string;
    sourceId: string;
    path: string;
    offset: number;
    maxBytes: number;
  }): Promise<SkillSourceReadBytesResult> {
    validateRead(input.path, input.offset, input.maxBytes);
    const binding = await this.#binding(input.workspaceId, input.sourceId);
    return this.#authority.readBytes(
      input.workspaceId,
      `${binding.root}/${input.path}`,
      input.offset,
      input.maxBytes
    );
  }

  async #binding(workspaceId: string, sourceId: string): Promise<WorkspaceSourceBinding> {
    let binding = this.#bindings.get(sourceId);
    if (binding === undefined || binding.workspaceId !== workspaceId) {
      await this.listSources(workspaceId);
      binding = this.#bindings.get(sourceId);
    }
    if (binding === undefined || binding.workspaceId !== workspaceId) throw workspaceMismatch();
    return binding;
  }
}

function deterministicSourceId(trustId: string, root: string): string {
  const digest = createHash("sha256").update(`${trustId}\0${root}`, "utf8").digest("hex");
  return `ss_${digest.slice(0, 32)}`;
}

function stripSourceRoot(root: string, path: string): string | undefined {
  if (path === root) return "";
  const prefix = `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

function validateRead(path: string, offset: number, maxBytes: number): void {
  if (
    !isCanonicalRelativePath(path, false) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > SKILL_LOAD_MAX_BYTES
  ) {
    throw boundaryViolation();
  }
}

function isCanonicalRelativePath(value: string, allowRootDot: boolean): boolean {
  if (value.includes("\0") || isAbsolute(value)) return false;
  if (value === ".") return allowRootDot;
  return value
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== "..");
}

function workspaceMismatch(): SkillError {
  return new SkillError("SKILL_WORKSPACE_MISMATCH", "Skill source does not belong to this READY workspace");
}

function boundaryViolation(): SkillError {
  return new SkillError(
    "SKILL_SOURCE_BOUNDARY_VIOLATION",
    "Workspace skill source path must remain canonical and relative"
  );
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
