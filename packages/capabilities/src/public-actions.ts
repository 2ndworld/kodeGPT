import { Buffer } from "node:buffer";

export type PublicActionRole =
  | "primitive"
  | "composite"
  | "lifecycle"
  | "integration"
  | "introspection";

export type PublicActionScope = "global" | "workspace" | "repository" | "preview";

export const PUBLIC_ACTION_IDS = Object.freeze([
  "artifact.read",
  "browser.openPreview",
  "browser.inspect",
  "browser.click",
  "browser.type",
  "browser.screenshot",
  "browser.console",
  "browser.networkFailures",
  "visual.captureMatrix",
  "visual.compare",
  "ci.failure",
  "ci.rerun",
  "ci.cancel",
  "ci.dispatch",
  "ci.repository",
  "ci.run",
  "ci.runs",
  "ci.status",
  "code.impact",
  "code.search",
  "console.state",
  "context.build",
  "file.edit",
  "file.read",
  "file.patch",
  "file.tree",
  "file.write",
  "git.branchCreate",
  "git.branchDelete",
  "git.branchSwitch",
  "git.worktreeCreate",
  "git.worktreeRemove",
  "git.changes",
  "git.commit",
  "git.diff",
  "git.diffHistory",
  "git.fetch",
  "git.log",
  "git.pull",
  "git.push",
  "git.range",
  "git.show",
  "git.stage",
  "git.status",
  "github.issue.inspect",
  "github.issue.list",
  "github.pr.create",
  "github.pr.inspect",
  "github.pr.list",
  "github.pr.merge",
  "github.repository.inspect",
  "process.cancel",
  "process.run",
  "process.status",
  "preview.inspect",
  "preview.start",
  "preview.stop",
  "profile.current",
  "profile.inspect",
  "skill.list",
  "skill.inspect",
  "skill.load",
  "system.capabilities",
  "system.health",
  "trust.list",
  "verify.list",
  "verify.run",
  "workspace.close",
  "workspace.checkpoint",
  "workspace.info",
  "workspace.inspect",
  "workspace.list",
  "workspace.open",
  "workspace.trust",
  "workspace.untrust"
] as const);

export type PublicActionId = (typeof PUBLIC_ACTION_IDS)[number];

export interface PublicActionDescriptor {
  readonly id: PublicActionId;
  readonly family: string;
  readonly purpose: string;
  readonly aliases: readonly string[];
  readonly tags: readonly string[];
  readonly role: PublicActionRole;
  readonly scope: PublicActionScope;
  readonly requiredInputs: readonly string[];
}

type PublicActionDefinition = Omit<PublicActionDescriptor, "id" | "family">;

function define(
  purpose: string,
  aliases: readonly string[],
  tags: readonly string[],
  role: PublicActionRole,
  scope: PublicActionScope,
  requiredInputs: readonly string[]
): PublicActionDefinition {
  return Object.freeze({
    purpose,
    aliases: freezeSortedUnique(aliases),
    tags: freezeSortedUnique(tags),
    role,
    scope,
    requiredInputs: Object.freeze([...requiredInputs])
  });
}

const DEFINITIONS: Readonly<Record<PublicActionId, PublicActionDefinition>> = Object.freeze({
  "artifact.read": define(
    "Read bounded artifact content by KodeGPT artifact URI.",
    ["read artifact", "inspect artifact", "artifact content"],
    ["artifact", "evidence", "read"],
    "introspection",
    "global",
    ["uri"]
  ),
  "browser.openPreview": define(
    "Open a live KodeGPT-owned preview in the bounded browser session.",
    ["open preview in browser", "browser preview", "view local preview"],
    ["browser", "preview", "ui"],
    "lifecycle",
    "preview",
    ["workspaceId", "previewId"]
  ),
  "browser.inspect": define(
    "Inspect bounded DOM and page evidence from a live preview browser session.",
    ["inspect browser", "inspect preview page", "inspect dom"],
    ["browser", "dom", "inspect", "preview"],
    "introspection",
    "preview",
    ["workspaceId", "previewId"]
  ),
  "browser.click": define(
    "Click a bounded target inside a live preview browser session.",
    ["click browser target", "click preview", "interact with preview"],
    ["browser", "interaction", "preview", "ui"],
    "primitive",
    "preview",
    ["workspaceId", "previewId", "target"]
  ),
  "browser.type": define(
    "Type text into a bounded target inside a live preview browser session.",
    ["type in browser", "fill preview input", "enter text in preview"],
    ["browser", "input", "interaction", "preview"],
    "primitive",
    "preview",
    ["workspaceId", "previewId", "target", "text"]
  ),
  "browser.screenshot": define(
    "Capture bounded screenshot evidence from a live preview browser session.",
    ["browser screenshot", "capture preview screenshot", "screenshot page"],
    ["browser", "evidence", "preview", "screenshot", "ui"],
    "introspection",
    "preview",
    ["workspaceId", "previewId"]
  ),
  "browser.console": define(
    "Read bounded browser console evidence from a live preview session.",
    ["browser console", "console errors", "inspect browser errors"],
    ["browser", "console", "debug", "errors", "preview"],
    "introspection",
    "preview",
    ["workspaceId", "previewId"]
  ),
  "browser.networkFailures": define(
    "Read bounded failed-network-request evidence from a live preview browser session.",
    ["browser network failures", "failed requests", "inspect network errors"],
    ["browser", "debug", "network", "preview"],
    "introspection",
    "preview",
    ["workspaceId", "previewId"]
  ),
  "visual.captureMatrix": define(
    "Capture bounded responsive screenshot evidence across configured viewport sizes.",
    ["capture viewport matrix", "responsive screenshots", "visual regression evidence"],
    ["browser", "responsive", "screenshot", "ui", "visual", "verification"],
    "composite",
    "preview",
    ["workspaceId", "previewId"]
  ),
  "visual.compare": define(
    "Compare current bounded visual evidence with an explicit reference artifact.",
    ["compare screenshots", "compare visual evidence", "visual diff"],
    ["comparison", "regression", "ui", "visual", "verification"],
    "composite",
    "preview",
    ["workspaceId", "previewId", "referenceArtifact"]
  ),
  "ci.failure": define(
    "Inspect bounded redacted read-only failure evidence from one Remote-CI workflow run.",
    ["ci failure", "github actions failure", "why ci failed"],
    ["ci", "debug", "failure", "github-actions"],
    "integration",
    "repository",
    ["runId"]
  ),
  "ci.rerun": define(
    "Re-run one GitHub Actions workflow run through bounded CI mutation authority.",
    ["rerun ci", "rerun failed jobs", "rerun workflow"],
    ["ci", "github-actions", "mutation", "workflow"],
    "integration",
    "repository",
    ["runId"]
  ),
  "ci.cancel": define(
    "Cancel one GitHub Actions workflow run through bounded CI mutation authority.",
    ["cancel ci", "cancel workflow", "stop workflow run"],
    ["ci", "github-actions", "mutation", "workflow"],
    "integration",
    "repository",
    ["runId"]
  ),
  "ci.dispatch": define(
    "Dispatch one configured GitHub Actions workflow through bounded CI mutation authority.",
    ["ci workflow dispatch", "dispatch workflow", "run workflow"],
    ["ci", "github-actions", "mutation", "workflow"],
    "integration",
    "repository",
    ["workflow", "ref"]
  ),
  "ci.repository": define(
    "Resolve bounded read-only Remote-CI repository context from a trusted workspace.",
    ["ci repository", "github ci context", "remote ci repository"],
    ["ci", "github-actions", "repository"],
    "integration",
    "repository",
    []
  ),
  "ci.run": define(
    "Inspect one bounded read-only Remote-CI workflow run.",
    ["ci run", "github actions run", "workflow run details"],
    ["ci", "github-actions", "workflow"],
    "integration",
    "repository",
    ["runId"]
  ),
  "ci.runs": define(
    "List bounded recent read-only Remote-CI workflow runs.",
    ["ci runs", "github actions runs", "workflow runs"],
    ["ci", "github-actions", "list", "workflow"],
    "integration",
    "repository",
    []
  ),
  "ci.status": define(
    "Summarize bounded read-only Remote-CI status for a trusted workspace revision.",
    ["check ci", "ci status", "github actions status"],
    ["ci", "github-actions", "status"],
    "integration",
    "repository",
    []
  ),
  "code.impact": define(
    "Find bounded dependents, references, tests, and affected repository areas.",
    ["affected areas", "affected tests", "dependency impact", "find dependents", "impact analysis"],
    ["code", "dependencies", "impact", "tests"],
    "composite",
    "workspace",
    ["workspaceId", "target"]
  ),
  "code.search": define(
    "Find code paths, text, symbols, definitions, or references.",
    ["find code", "find definition", "find reference", "find symbol", "search code"],
    ["code", "definition", "reference", "search", "symbol"],
    "composite",
    "workspace",
    ["workspaceId", "query"]
  ),
  "console.state": define(
    "Return normalized KodeGPT Dev Console state without synchronously refreshing Git.",
    ["dev console state", "console state", "kodegpt console"],
    ["console", "state", "status"],
    "introspection",
    "global",
    []
  ),
  "context.build": define(
    "Build bounded repository context for a stated intent and target.",
    ["build context", "gather context", "project context", "repository context"],
    ["context", "repository", "understand"],
    "composite",
    "workspace",
    ["workspaceId", "intent"]
  ),
  "file.edit": define(
    "Replace exact text in an existing file.",
    ["edit file", "modify file", "replace exact text"],
    ["edit", "file", "mutation"],
    "primitive",
    "workspace",
    ["workspaceId", "path", "oldText", "newText", "expectedReplacements"]
  ),
  "file.read": define(
    "Read bounded file content.",
    ["inspect file", "read file", "view file content"],
    ["file", "read"],
    "introspection",
    "workspace",
    ["workspaceId", "path"]
  ),
  "file.patch": define(
    "Check or apply a bounded structured patch.",
    ["apply patch", "check patch", "structured patch", "unified patch"],
    ["edit", "file", "patch"],
    "primitive",
    "workspace",
    ["workspaceId", "patch"]
  ),
  "file.tree": define(
    "List a bounded workspace-relative file tree.",
    ["file tree", "list files", "show project files"],
    ["file", "repository", "tree"],
    "introspection",
    "workspace",
    ["workspaceId"]
  ),
  "file.write": define(
    "Create or replace file content through the native file boundary.",
    ["create file", "replace file", "write file"],
    ["file", "mutation", "write"],
    "primitive",
    "workspace",
    ["workspaceId", "path", "content"]
  ),
  "git.branchCreate": define(
    "Create a validated trusted local Git branch.",
    ["create git branch", "git branch create", "new branch"],
    ["branch", "git", "lifecycle"],
    "lifecycle",
    "workspace",
    ["workspaceId", "name"]
  ),
  "git.branchDelete": define(
    "Safely delete a merged validated trusted local Git branch.",
    ["delete git branch", "remove branch", "safe branch delete"],
    ["branch", "git", "lifecycle"],
    "lifecycle",
    "workspace",
    ["workspaceId", "name"]
  ),
  "git.branchSwitch": define(
    "Switch to a validated trusted local Git branch.",
    ["checkout branch", "git switch", "switch git branch"],
    ["branch", "git", "lifecycle"],
    "lifecycle",
    "workspace",
    ["workspaceId", "name"]
  ),
  "git.worktreeCreate": define(
    "Create a bounded linked worktree at .worktrees/<name> for an existing local branch.",
    ["create git worktree", "linked worktree", "worktree create"],
    ["git", "isolation", "worktree"],
    "lifecycle",
    "workspace",
    ["workspaceId", "name", "branch"]
  ),
  "git.worktreeRemove": define(
    "Remove a clean bounded linked worktree from .worktrees/<name> without deleting its branch.",
    ["delete linked worktree", "remove git worktree", "worktree remove"],
    ["git", "isolation", "worktree"],
    "lifecycle",
    "workspace",
    ["workspaceId", "name"]
  ),
  "git.changes": define(
    "Summarize bounded repository changes and change identity.",
    ["changed files", "git changes", "review changes", "summarize changes"],
    ["changes", "diff", "git", "review"],
    "composite",
    "workspace",
    ["workspaceId"]
  ),
  "git.commit": define(
    "Create a bounded trusted local Git commit.",
    ["commit changes", "git commit", "local commit"],
    ["commit", "git", "mutation"],
    "primitive",
    "workspace",
    ["workspaceId", "message"]
  ),
  "git.diff": define(
    "Inspect repository diffs without mutation.",
    ["git diff", "inspect diff", "review diff"],
    ["diff", "git", "review"],
    "introspection",
    "workspace",
    ["workspaceId"]
  ),
  "git.diffHistory": define(
    "Inspect a bounded diff between two historical Git revisions.",
    ["compare commits", "git history diff", "historical diff"],
    ["diff", "git", "history"],
    "introspection",
    "workspace",
    ["workspaceId", "baseRevision", "headRevision"]
  ),
  "git.fetch": define(
    "Fetch a validated branch from a named remote in a trusted workspace.",
    ["fetch remote branch", "git fetch", "update remote tracking branch"],
    ["git", "network", "remote"],
    "integration",
    "workspace",
    ["workspaceId", "ref"]
  ),
  "git.log": define(
    "List bounded structured local Git commit history.",
    ["commit history", "git log", "repository history"],
    ["git", "history", "log"],
    "introspection",
    "workspace",
    ["workspaceId"]
  ),
  "git.pull": define(
    "Fast-forward a trusted workspace from a validated remote branch.",
    ["fast-forward pull", "git pull", "update from remote"],
    ["git", "network", "remote"],
    "integration",
    "workspace",
    ["workspaceId", "ref"]
  ),
  "git.push": define(
    "Push a validated local branch to the same branch on a named remote.",
    ["git push", "publish branch", "push branch"],
    ["git", "network", "remote"],
    "integration",
    "workspace",
    ["workspaceId", "ref"]
  ),
  "git.range": define(
    "Inspect bounded ancestry and commit ranges.",
    ["ahead behind", "commit range", "git range", "merge base"],
    ["git", "history", "range"],
    "introspection",
    "workspace",
    ["workspaceId", "baseRevision", "headRevision"]
  ),
  "git.show": define(
    "Inspect one bounded historical Git commit.",
    ["commit details", "git show", "inspect commit"],
    ["commit", "git", "history"],
    "introspection",
    "workspace",
    ["workspaceId"]
  ),
  "git.stage": define(
    "Stage bounded workspace-relative paths in trusted local Git.",
    ["git add", "git stage", "stage changes"],
    ["git", "mutation", "stage"],
    "primitive",
    "workspace",
    ["workspaceId", "paths"]
  ),
  "git.status": define(
    "Inspect repository status without mutation.",
    ["git status", "repository status", "working tree status"],
    ["git", "status", "working-tree"],
    "introspection",
    "workspace",
    ["workspaceId"]
  ),
  "github.issue.inspect": define(
    "Inspect one bounded GitHub issue through the typed GitHub read surface.",
    ["inspect github issue", "github issue details", "read issue"],
    ["github", "issue", "remote"],
    "integration",
    "repository",
    ["repository", "number"]
  ),
  "github.issue.list": define(
    "List bounded GitHub issues through the typed GitHub read surface.",
    ["list github issues", "github issues", "find issues"],
    ["github", "issue", "list", "remote"],
    "integration",
    "repository",
    ["repository"]
  ),
  "github.pr.create": define(
    "Create one bounded GitHub pull request through typed GitHub write authority.",
    ["create pull request", "create pr", "open github pr"],
    ["github", "pull-request", "remote", "review"],
    "integration",
    "repository",
    ["repository", "title", "headBranch", "baseBranch"]
  ),
  "github.pr.inspect": define(
    "Inspect one bounded GitHub pull request through the typed GitHub read surface.",
    ["inspect pull request", "github pr details", "read pr"],
    ["github", "pull-request", "remote", "review"],
    "integration",
    "repository",
    ["repository", "number"]
  ),
  "github.pr.list": define(
    "List bounded GitHub pull requests through the typed GitHub read surface.",
    ["list pull requests", "github prs", "find pull requests"],
    ["github", "list", "pull-request", "remote"],
    "integration",
    "repository",
    ["repository"]
  ),
  "github.pr.merge": define(
    "Merge one GitHub pull request with an exact expected-head guard.",
    ["merge pull request", "merge github pr", "guarded pr merge"],
    ["github", "merge", "pull-request", "remote"],
    "integration",
    "repository",
    ["repository", "number", "expectedHeadOid"]
  ),
  "github.repository.inspect": define(
    "Inspect bounded GitHub repository metadata through the typed GitHub read surface.",
    ["inspect github repository", "github repository info", "repository metadata"],
    ["github", "remote", "repository"],
    "integration",
    "repository",
    ["repository"]
  ),
  "process.cancel": define(
    "Cancel a running bounded KodeGPT process operation.",
    ["cancel process", "stop running command", "terminate process operation"],
    ["cancel", "process", "runtime"],
    "lifecycle",
    "workspace",
    ["workspaceId", "operationId"]
  ),
  "process.run": define(
    "Run a policy-approved process through native process controls.",
    ["native process", "policy-approved process", "run process"],
    ["command", "process", "runtime", "shell"],
    "primitive",
    "workspace",
    ["workspaceId", "logicalExecutable", "argv"]
  ),
  "process.status": define(
    "Inspect bounded status and progress for a process operation.",
    ["process status", "check running command", "wait for process"],
    ["process", "progress", "status"],
    "introspection",
    "workspace",
    ["workspaceId", "operationId"]
  ),
  "preview.inspect": define(
    "Inspect readiness and bounded state for a KodeGPT-owned local preview.",
    ["check preview", "preview status", "preview readiness"],
    ["preview", "readiness", "status", "ui"],
    "introspection",
    "preview",
    ["workspaceId", "previewId"]
  ),
  "preview.start": define(
    "Start a bounded local preview backed by an approved background process.",
    ["start preview", "run dev preview", "launch local preview"],
    ["development", "preview", "ui"],
    "lifecycle",
    "preview",
    ["workspaceId", "logicalExecutable", "argv", "port"]
  ),
  "preview.stop": define(
    "Stop a bounded KodeGPT-owned local preview.",
    ["stop preview", "close local preview", "terminate preview"],
    ["preview", "stop", "ui"],
    "lifecycle",
    "preview",
    ["workspaceId", "previewId"]
  ),
  "profile.current": define(
    "Inspect the effective execution profile for an open workspace.",
    ["current profile", "workspace profile", "effective policy"],
    ["policy", "profile", "workspace"],
    "introspection",
    "workspace",
    ["workspaceId"]
  ),
  "profile.inspect": define(
    "Inspect one built-in KodeGPT profile preset.",
    ["inspect profile", "profile policy", "profile settings"],
    ["policy", "profile", "settings"],
    "introspection",
    "global",
    ["name"]
  ),
  "skill.list": define(
    "List bounded Agent Skills from admitted sources and optional workspace-local discovery.",
    ["list skills", "available skills", "discover agent skills"],
    ["extension", "skill", "workflow"],
    "introspection",
    "global",
    []
  ),
  "skill.inspect": define(
    "Inspect bounded Agent Skill metadata, compatibility, resources, and capability guidance.",
    ["inspect skill", "skill compatibility", "skill metadata"],
    ["compatibility", "extension", "skill"],
    "introspection",
    "global",
    ["skillId"]
  ),
  "skill.load": define(
    "Load bounded Agent Skill instructions and explicitly requested text resources.",
    ["load skill", "read skill instructions", "skill contents"],
    ["extension", "instructions", "skill"],
    "introspection",
    "global",
    ["skillId"]
  ),
  "system.capabilities": define(
    "Describe the current KodeGPT runtime, execution features, protocol surface, and public tools.",
    ["available tools", "kodegpt capabilities", "what can kodegpt do"],
    ["capabilities", "discovery", "system", "tools"],
    "introspection",
    "global",
    []
  ),
  "system.health": define(
    "Report KodeGPT runtime health and bounded recent diagnostic evidence.",
    ["check service health", "kodegpt health", "system health"],
    ["diagnostics", "health", "system"],
    "introspection",
    "global",
    []
  ),
  "trust.list": define(
    "List trusted workspace registrations and profile ceilings.",
    ["list trusted workspaces", "workspace trust list", "trusted repositories"],
    ["trust", "workspace", "security"],
    "introspection",
    "global",
    []
  ),
  "verify.list": define(
    "Discover deterministic repository verification recipes.",
    ["available checks", "discover tests", "discover verification", "list verifications"],
    ["build", "test", "verification"],
    "composite",
    "workspace",
    ["workspaceId"]
  ),
  "verify.run": define(
    "Run a discovered verification recipe through existing process policy.",
    ["run build checks", "run tests", "run typecheck", "run verification"],
    ["build", "test", "verification"],
    "composite",
    "workspace",
    ["workspaceId", "recipeId"]
  ),
  "workspace.close": define(
    "Close an open KodeGPT workspace binding without removing durable trust.",
    ["close workspace", "release workspace", "close repository"],
    ["lifecycle", "workspace"],
    "lifecycle",
    "workspace",
    ["workspaceId"]
  ),
  "workspace.checkpoint": define(
    "Create, replace, or clear bounded CAS-backed workspace continuity state.",
    ["update workspace checkpoint", "save development state", "continuity checkpoint"],
    ["checkpoint", "continuity", "resume", "workspace"],
    "lifecycle",
    "workspace",
    ["workspaceId", "operation"]
  ),
  "workspace.info": define(
    "Read current open-workspace policy and bounded continuity checkpoint state.",
    ["current workspace", "resume workspace", "workspace state"],
    ["continuity", "resume", "state", "workspace"],
    "introspection",
    "workspace",
    ["workspaceId"]
  ),
  "workspace.inspect": define(
    "Summarize repository structure and project metadata.",
    ["inspect workspace", "project structure", "repository structure", "workspace overview"],
    ["repository", "structure", "workspace"],
    "composite",
    "workspace",
    ["workspaceId"]
  ),
  "workspace.list": define(
    "List currently open KodeGPT workspaces.",
    ["list workspaces", "open workspaces", "workspace sessions"],
    ["list", "workspace"],
    "introspection",
    "global",
    []
  ),
  "workspace.open": define(
    "Open a previously trusted workspace and resolve its effective profile.",
    ["open workspace", "open repository", "activate workspace"],
    ["lifecycle", "repository", "workspace"],
    "lifecycle",
    "global",
    ["rootPath"]
  ),
  "workspace.trust": define(
    "Create or update a bounded trusted-workspace registration.",
    ["trust workspace", "trust repository", "register workspace trust"],
    ["security", "trust", "workspace"],
    "lifecycle",
    "global",
    ["rootPath"]
  ),
  "workspace.untrust": define(
    "Remove a trusted-workspace registration and its bounded continuity state.",
    ["untrust workspace", "remove workspace trust", "forget trusted repository"],
    ["security", "trust", "workspace"],
    "lifecycle",
    "global",
    ["trustId"]
  )
});

if (new Set(PUBLIC_ACTION_IDS).size !== PUBLIC_ACTION_IDS.length) {
  throw new Error("Public action catalog contains duplicate action ids");
}

export const PUBLIC_ACTIONS: Readonly<Record<PublicActionId, PublicActionDescriptor>> = Object.freeze(
  Object.fromEntries(
    PUBLIC_ACTION_IDS.map((id) => {
      const definition = DEFINITIONS[id];
      const familyEnd = id.indexOf(".");
      if (familyEnd <= 0 || definition.purpose.length === 0 || definition.aliases.length === 0 || definition.tags.length === 0) {
        throw new Error(`Public action descriptor is incomplete: ${id}`);
      }
      return [
        id,
        Object.freeze({
          id,
          family: id.slice(0, familyEnd),
          ...definition
        })
      ];
    })
  ) as Record<PublicActionId, PublicActionDescriptor>
);

const PUBLIC_ACTION_LIST = Object.freeze(PUBLIC_ACTION_IDS.map((id) => PUBLIC_ACTIONS[id]));

export function getPublicActionDescriptor(id: PublicActionId): PublicActionDescriptor {
  return PUBLIC_ACTIONS[id];
}

export function listPublicActionDescriptors(): readonly PublicActionDescriptor[] {
  return PUBLIC_ACTION_LIST;
}

function freezeSortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareUtf8));
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
