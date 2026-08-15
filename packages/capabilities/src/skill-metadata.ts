import { NATIVE_CAPABILITY_IDS, type NativeCapabilityId } from "./contracts.js";

export interface NativeCapabilitySemanticMetadata {
  readonly id: NativeCapabilityId;
  readonly purpose: string;
  readonly semanticAliases: readonly string[];
}

type Registry = Readonly<Record<NativeCapabilityId, NativeCapabilitySemanticMetadata>>;

function entry(
  id: NativeCapabilityId,
  purpose: string,
  semanticAliases: readonly string[]
): NativeCapabilitySemanticMetadata {
  return Object.freeze({
    id,
    purpose,
    semanticAliases: Object.freeze([...semanticAliases])
  });
}

export const NATIVE_CAPABILITY_SEMANTICS: Registry = Object.freeze({
  "workspace.inspect": entry("workspace.inspect", "Summarize repository structure and project metadata.", [
    "inspect workspace",
    "workspace overview",
    "project structure",
    "repository structure"
  ]),
  "code.search": entry("code.search", "Find code paths, text, symbols, definitions, or references.", [
    "search code",
    "find code",
    "find symbol",
    "find reference",
    "find definition"
  ]),
  "file.read": entry("file.read", "Read bounded file content.", [
    "read file",
    "inspect file",
    "view file content"
  ]),
  "file.write": entry("file.write", "Create or replace file content through the native file boundary.", [
    "write file",
    "create file",
    "replace file"
  ]),
  "file.edit": entry("file.edit", "Replace exact text in an existing file.", [
    "edit file",
    "replace exact text",
    "modify file"
  ]),
  "file.patch": entry("file.patch", "Check or apply a bounded structured patch.", [
    "apply patch",
    "check patch",
    "structured patch",
    "unified patch"
  ]),
  "git.status": entry("git.status", "Inspect repository status without mutation.", [
    "git status",
    "repository status",
    "working tree status"
  ]),
  "git.diff": entry("git.diff", "Inspect repository diffs without mutation.", [
    "git diff",
    "review diff",
    "inspect diff"
  ]),
  "git.changes": entry("git.changes", "Summarize bounded repository changes and change identity.", [
    "git changes",
    "review changes",
    "changed files",
    "summarize changes"
  ]),
  "git.stage": entry("git.stage", "Stage bounded workspace-relative paths in trusted local Git.", [
    "git stage",
    "git add",
    "stage changes"
  ]),
  "git.commit": entry("git.commit", "Create a bounded trusted local Git commit.", [
    "git commit",
    "commit changes",
    "local commit"
  ]),
  "git.branchCreate": entry("git.branchCreate", "Create a validated trusted local Git branch.", [
    "create git branch",
    "new branch",
    "git branch create"
  ]),
  "git.branchSwitch": entry("git.branchSwitch", "Switch to a validated trusted local Git branch.", [
    "switch git branch",
    "checkout branch",
    "git switch"
  ]),
  "git.branchDelete": entry("git.branchDelete", "Safely delete a merged validated trusted local Git branch.", [
    "delete git branch",
    "remove branch",
    "safe branch delete"
  ]),
  "git.log": entry("git.log", "List bounded structured local Git commit history.", [
    "git log",
    "commit history",
    "repository history"
  ]),
  "git.show": entry("git.show", "Inspect one bounded historical Git commit.", [
    "git show",
    "inspect commit",
    "commit details"
  ]),
  "git.range": entry("git.range", "Inspect bounded ancestry and commit ranges.", [
    "git range",
    "commit range",
    "merge base",
    "ahead behind"
  ]),
  "git.diffHistory": entry("git.diffHistory", "Inspect a bounded diff between two historical Git revisions.", [
    "historical diff",
    "git history diff",
    "compare commits"
  ]),
  "process.run": entry("process.run", "Run a policy-approved process through native process controls.", [
    "run process",
    "native process",
    "policy-approved process"
  ]),
  "verify.list": entry("verify.list", "Discover deterministic repository verification recipes.", [
    "list verifications",
    "discover verification",
    "discover tests",
    "available checks"
  ]),
  "verify.run": entry("verify.run", "Run a discovered verification recipe through existing process policy.", [
    "run verification",
    "run tests",
    "run typecheck",
    "run build checks"
  ]),
  "context.build": entry("context.build", "Build bounded repository context for a stated intent and target.", [
    "build context",
    "repository context",
    "gather context",
    "project context"
  ])
});

export function getNativeCapabilitySemanticMetadata(
  id: NativeCapabilityId
): NativeCapabilitySemanticMetadata {
  return NATIVE_CAPABILITY_SEMANTICS[id];
}

// Compile-time completeness is enforced by Registry; keep this runtime assertion local to authored source drift.
if (Object.keys(NATIVE_CAPABILITY_SEMANTICS).length !== NATIVE_CAPABILITY_IDS.length) {
  throw new Error("Native capability semantic metadata is incomplete");
}
