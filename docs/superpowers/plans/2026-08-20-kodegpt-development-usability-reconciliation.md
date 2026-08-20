# KodeGPT Development Usability Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make KodeGPT easier to map correctly and more efficient in real development by improving capability self-description, fixing proven skill-parser false positives, enforcing fair target-context budgeting, activating the existing repository workflow skill, and adding lightweight resume guidance without new orchestration infrastructure.

**Architecture:** Reuse existing authorities instead of adding new ones. Public MCP inventory comes from `listSurfaceTools()`, workspace-aware skill readiness stays in the already-implemented `resolveSkillCapabilityPlan()`, context fairness changes only per-file read ceilings, repository skill activation uses the existing operator source registry, and continuation remains host-owned through the existing workflow skill plus `.ai-bridge`.

**Tech Stack:** TypeScript, Vitest, existing KodeGPT MCP/CLI packages, Rust runtime unchanged, existing `systemd --user` service lifecycle and zrok exposure.

**Spec:** `docs/superpowers/specs/2026-08-20-kodegpt-development-usability-reconciliation-design.md`

## Global Constraints

- Canonical repo: `/home/sauron/dev/kodegpt`.
- Implementation baseline: `main == origin/main == 7419b42e06dee52c6509e4e14242ed264fe85449` unless fresh preflight proves a newer intentional baseline.
- Runtime remains exactly `0.1`.
- MCP protocol remains exactly `2026-07-28`.
- MCP semantic surface remains exactly `0.16`.
- Public MCP tool count remains exactly `75`.
- Do not add `workflow.run`, `skill.run`, `system.inventory`, `capability.list`, `feature.list`, generic `shell.run`, generic `command.run`, generic `provider.invoke`, autonomous sessions, multi-agent scheduling, arbitrary browser navigation, computer-use, generic deployment, persistent context indexing/cache, or automatic skill marketplace sync.
- Do not reimplement `resolveSkillCapabilityPlan()` or introduce a second runtime/executable resolver.
- Do not auto-inject `.ai-bridge` files into `context.build`.
- Do not add a new skill-source type or MCP skill-source mutation.
- Keep trusted process semantics, retained-root/Bubblewrap boundaries, controlled PATH/environment, audit, cancellation, and Rust final OS authority unchanged.
- Prefer typed KodeGPT Git/GitHub/CI tools during execution; use shell only for verification/build/operator CLI commands that do not have a better typed equivalent.
- Every behavioral change follows TDD: focused RED, minimal GREEN, adjacent regression, then task commit.

---

## Execution Preflight

Before Task 1, use `superpowers:using-git-worktrees` to create an isolated implementation worktree from the fresh canonical `main`. Recommended branch/worktree:

```text
branch: feat/development-usability-reconciliation
worktree: .worktrees/development-usability-reconciliation
```

Preflight checks:

```bash
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
git worktree list --porcelain
```

Expected: canonical `main` clean; implementation worktree clean; implementation base equals current intended `origin/main`. If `main` intentionally advanced after this plan was written, re-read the spec and inspect the touched files for already-implemented behavior before continuing; do not replay any task whose acceptance criteria are already satisfied.

Record the fresh baseline in `.ai-bridge/agent-status.md`, but do not overwrite the implementation plan.

---

### Task 1: Make Public Capabilities Self-Describing

**Files:**
- Modify: `apps/cli/src/commands/start.ts:38-46,631-638`
- Modify: `packages/mcp-server/src/tools.ts:1268-1321`
- Modify: `packages/mcp-server/src/skills.test.ts:149-163`
- Modify: `tests/integration/full-stack.test.ts:17,240-255`
- Modify: `docs/architecture/README.md:1-8`

**Interfaces:**
- Consumes: `listSurfaceTools(): Array<{ name: string; required: string[] }>` from `@kodegpt/mcp-server`.
- Produces: additive `system.capabilities.publicTools` with exact shape `{ count: number; families: Record<string, string[]> }`.
- Produces: tool descriptions that distinguish static skill compatibility from workspace-effective capability planning.
- Preserves: `MCP_SURFACE_VERSION === "0.16"` and exactly 75 `SURFACE_TOOLS` entries.

- [ ] **Step 1: Add a failing full-stack assertion for machine-readable public inventory**

Change the MCP import in `tests/integration/full-stack.test.ts` to include `listSurfaceTools`:

```ts
import { MCP_SURFACE_VERSION, listSurfaceTools } from "../../packages/mcp-server/src/index.js";
```

Immediately after the existing `system.capabilities` version/boundary assertion, add:

```ts
const publicTools = capabilities.publicTools as {
  count: number;
  families: Record<string, string[]>;
};
const expectedToolNames = listSurfaceTools()
  .map(({ name }) => name)
  .sort();

expect(publicTools.count).toBe(expectedToolNames.length);
expect(Object.values(publicTools.families).flat().sort()).toEqual(expectedToolNames);
expect(publicTools.families.skill).toEqual(["skill.inspect", "skill.list", "skill.load"]);
expect(publicTools.families.process).toEqual([
  "process.cancel",
  "process.run",
  "process.status"
]);
```

- [ ] **Step 2: Run the full-stack test and prove RED**

Run:

```bash
pnpm exec vitest run tests/integration/full-stack.test.ts --no-file-parallelism
```

Expected: FAIL because `system.capabilities.publicTools` is absent. Do not accept a failure caused by runtime/build setup; fix the test environment until the missing field is the demonstrated failure.

- [ ] **Step 3: Add failing skill-tool description assertions**

In `packages/mcp-server/src/skills.test.ts`, extend the registration metadata test with:

```ts
expect(required(tools, "skill.list").config.description?.toLowerCase()).toContain("static");
expect(required(tools, "skill.inspect").config.description?.toLowerCase()).toContain("workspace-aware");
expect(required(tools, "skill.inspect").config.description?.toLowerCase()).toContain("without executing");
```

The existing `capture()` helper registers the full tool set, so assert `system.capabilities` in the same test:

```ts
expect(required(tools, "system.capabilities").config.description?.toLowerCase()).toContain("public mcp");
```

- [ ] **Step 4: Run the MCP metadata test and prove RED**

Run:

```bash
pnpm exec vitest run packages/mcp-server/src/skills.test.ts --no-file-parallelism
```

Expected: the new wording assertions FAIL while existing registrations remain green.

- [ ] **Step 5: Implement derived public tool inventory with no second registry**

In `apps/cli/src/commands/start.ts`, import `listSurfaceTools` alongside existing MCP imports:

```ts
import {
  MCP_SURFACE_VERSION,
  createKodegptNodeHandler,
  createKodegptToolContext,
  listSurfaceTools,
  type BearerAuthenticator,
  type ExtensionRegistryToolAdapter,
  type KodegptToolContext,
  type WorkspaceManagerToolAdapter
} from "@kodegpt/mcp-server";
```

Add this private helper next to `systemCapabilities`:

```ts
function publicToolInventory(): {
  count: number;
  families: Record<string, string[]>;
} {
  const names = listSurfaceTools()
    .map(({ name }) => name)
    .sort();
  const families: Record<string, string[]> = {};

  for (const name of names) {
    const family = name.slice(0, name.indexOf("."));
    (families[family] ??= []).push(name);
  }

  return { count: names.length, families };
}
```

Extend `systemCapabilities` only additively:

```ts
function systemCapabilities(hello: KernelHello): Record<string, unknown> {
  return {
    runtimeVersion: hello.runtimeVersion,
    filesystemBoundaryAvailable: hello.filesystemBoundaryAvailable,
    mcpProtocolVersion: MCP_PROTOCOL_VERSION,
    mcpSurfaceVersion: MCP_SURFACE_VERSION,
    publicTools: publicToolInventory()
  };
}
```

Do not hard-code `75` or tool-family arrays in production code.

- [ ] **Step 6: Clarify discovery semantics in existing tool descriptions**

In `packages/mcp-server/src/tools.ts`, use concise descriptions equivalent to:

```ts
"skill.list":
  "List bounded live and pinned skill metadata with static/source compatibility; use skill.inspect with workspaceId for workspace-aware effective CLI readiness."

"skill.inspect":
  "Inspect bounded skill metadata/resources and an advisory capability plan; with workspaceId, resolve workspace-aware external-CLI readiness against effective policy/executable/sandbox state without executing commands."

"system.capabilities":
  "Report KodeGPT runtime/boundary state and derived public MCP tool-family inventory; operator-only CLI and private internals are not enumerated."
```

Keep schemas, annotations, names, required fields, and handlers unchanged.

- [ ] **Step 7: Add the current capability map to the architecture index**

At the top of `docs/architecture/README.md`, after the opening paragraph and before the historical/current-authority table, add one concise table with exactly these conceptual layers:

```markdown
## Current capability map

| Layer | Current behavior |
| --- | --- |
| Public MCP | Workspace/context/code, bounded file/process/verify, Git/GitHub/CI, preview/browser/visual, skills, profiles, artifacts, health/capabilities. Exact names come from `listSurfaceTools()` / `system.capabilities.publicTools`. |
| Trusted escape hatch | Existing sandboxed `process.run`; trusted profile additionally admits `bash`/`sh` with controlled PATH/environment and existing write/network authority. |
| Operator CLI | Workspace trust, provider admission/inspection, skill source/pin lifecycle, local service lifecycle, managed exposure. These are not public MCP actions. |
| Private internals | Provider Gateway, credential bridge, retained lexical search, runtime source/root authorities, and other implementation-only helpers. |
| Deliberately absent | `workflow.run`, `skill.run`, generic provider invocation, autonomous scheduler/session runtime, arbitrary browser navigation/computer-use, generic deployment abstraction. |
```

Do not copy all 75 tool names into documentation.

- [ ] **Step 8: Run focused GREEN verification**

Run:

```bash
pnpm exec vitest run packages/mcp-server/src/skills.test.ts packages/mcp-server/src/server.test.ts tests/integration/full-stack.test.ts --no-file-parallelism
pnpm run typecheck
```

Expected: PASS. Confirm `packages/mcp-server/src/surface-version.ts` remains `0.16` and `listSurfaceTools()` still has exactly 75 entries.

- [ ] **Step 9: Commit Task 1**

```bash
git add apps/cli/src/commands/start.ts packages/mcp-server/src/tools.ts packages/mcp-server/src/skills.test.ts tests/integration/full-stack.test.ts docs/architecture/README.md
git commit -m "feat: improve capability discoverability"
```

---

### Task 2: Fix False External-CLI Detection in Skills

**Files:**
- Modify: `packages/skills/src/compatibility.ts:8-15,76-121,150-190`
- Modify: `packages/skills/src/compatibility.test.ts:20-90`

**Interfaces:**
- Consumes: existing static `ParsedSkillDocument` and compatibility classifications.
- Produces: external CLI findings only from explicit command-context inline code or shell command fences.
- Preserves: explicit Codex command/subagent detection and existing `resolveSkillCapabilityPlan()` workspace-aware behavior.

- [ ] **Step 1: Write regressions for the two observed false positives**

Add to `packages/skills/src/compatibility.test.ts`:

```ts
it("does not treat inline prose or template examples as external CLIs", () => {
  const report = analyzeSkillCompatibility(
    skill({
      instructions:
        "Finish with `Lean already. Ship.` and render `Total users: ${users.length}` in the example."
    })
  );

  expect(report.classification).toBe("NATIVE");
  expect(report.missingCapabilities).toEqual([]);
  expect(report.reasons).toEqual(["NATIVE_REQUIREMENTS_SATISFIED"]);
});
```

Add a positive inline-command regression so precision is not obtained by dropping all inline command detection:

```ts
it("keeps explicit inline external command requirements partial", () => {
  const report = analyzeSkillCompatibility(
    skill({ instructions: "Inspect the project, then run `terraform plan` and review the output." })
  );

  expect(report.classification).toBe("PARTIAL");
  expect(report.missingCapabilities).toEqual(["external-cli:terraform"]);
  expect(report.reasons).toContain("EXTERNAL_CLI_REQUIRED:terraform");
});
```

If that positive case already exists verbatim, keep the existing test and add only the false-positive regression.

- [ ] **Step 2: Run the compatibility test and prove RED**

Run:

```bash
pnpm exec vitest run packages/skills/src/compatibility.test.ts --no-file-parallelism
```

Expected: false-positive regression FAILS with `external-cli:lean` and/or `external-cli:total`; existing Terraform and shell-fence cases remain passing.

- [ ] **Step 3: Narrow external CLI extraction to explicit command context**

Keep `INLINE_CODE_PATTERN`, but add:

```ts
const INLINE_COMMAND_PREFIX_PATTERN =
  /(?:\b(?:run|execute|invoke|launch)\s*|\b(?:command|cli)\s*:\s*)$/i;
```

Add a helper that reuses the existing inline-code regex while looking only at same-line preceding prose:

```ts
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
```

Preserve explicit Codex handling across all inline-code snippets, then restrict generic external CLI detection:

```ts
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
```

Remove the old loop that applied `externalCliName()` to every arbitrary inline-code span. Do not add word blacklists.

- [ ] **Step 4: Run focused GREEN and resolver regressions**

Run:

```bash
pnpm exec vitest run packages/skills/src/compatibility.test.ts packages/skills/src/capability-plan.test.ts packages/mcp-server/src/skills.test.ts --no-file-parallelism
```

Expected: PASS, including existing workspace-aware external CLI resolution tests.

- [ ] **Step 5: Commit Task 2**

```bash
git add packages/skills/src/compatibility.ts packages/skills/src/compatibility.test.ts
git commit -m "fix: classify skill command requirements precisely"
```

---

### Task 3: Prevent One Large File from Monopolizing Target Context

**Files:**
- Modify: `packages/capabilities/src/context-build.ts:120-169`
- Modify: `packages/capabilities/src/context-build.test.ts:16-128,473-497`

**Interfaces:**
- Consumes: existing ordered `Candidate` list and `ContextBuildInput.maxBytes`.
- Produces: target-scoped per-read ceilings only; result schema and candidate ordering are unchanged.
- Preserves: no-target builds use the existing whole-remaining-budget behavior.

- [ ] **Step 1: Add a failing fairness regression with three large evidence classes**

Extend the test fixture only as much as needed to expose read limits, e.g. add `readRequests` alongside existing `readCalls`:

```ts
const readRequests: Array<{ path: string; maxBytes: number }> = [];
```

Inside `readFile`:

```ts
const maxBytes = readOptions?.maxBytes ?? DEFAULT_CONTEXT_MAX_BYTES;
readRequests.push({ path, maxBytes });
```

Return `readRequests` from `sources()` without changing existing `readCalls` consumers.

Add:

```ts
it("reserves target-scoped budget for later high-priority evidence", async () => {
  const relatedTest = "packages/core/src/workspace-manager.test.ts";
  const dependency = "packages/core/src/helper.ts";
  const fixture = sources(
    {
      [TARGET]: "t".repeat(40),
      [relatedTest]: "r".repeat(40),
      [dependency]: "d".repeat(40),
      "package.json": "manifest",
      "packages/core/package.json": "core"
    },
    {
      relationships: [
        { from: relatedTest, to: TARGET, kind: "tests" },
        { from: TARGET, to: dependency, kind: "imports" }
      ]
    }
  );

  const result = await buildContext(fixture.adapter, {
    workspaceId: "ws_1",
    intent: "implement",
    target: TARGET,
    maxBytes: 24
  });

  expect(result.selectedFiles.map(({ path }) => path)).toEqual([
    TARGET,
    relatedTest,
    dependency
  ]);
  expect(result.selectedFiles.map(({ content }) => content?.length)).toEqual([12, 6, 6]);
  expect(result.totalBytes).toBe(24);
  expect(result.truncated).toBe(true);
});
```

- [ ] **Step 2: Add a no-target regression that locks existing behavior**

Add:

```ts
it("preserves whole-remaining-budget reads when no target is supplied", async () => {
  const fixture = sources({
    "packages/core/src/helper.ts": "h".repeat(40),
    "packages/other/src/unrelated.ts": "u".repeat(40),
    "package.json": "manifest"
  });

  const result = await buildContext(fixture.adapter, {
    workspaceId: "ws_1",
    intent: "review",
    maxBytes: 20
  });

  expect(result.selectedFiles[0]).toMatchObject({
    path: "packages/core/src/helper.ts",
    content: "h".repeat(20),
    truncated: true
  });
  expect(result.totalBytes).toBe(20);
});
```

- [ ] **Step 3: Run context tests and prove RED**

Run:

```bash
pnpm exec vitest run packages/capabilities/src/context-build.test.ts --no-file-parallelism
```

Expected: fairness regression FAILS because the target currently consumes all 24 bytes; no-target regression passes with old behavior.

- [ ] **Step 4: Implement minimal target-scoped per-file ceilings**

In `packages/capabilities/src/context-build.ts`, add:

```ts
const TARGET_FILE_BUDGET_SHARE = 0.5;
const NON_TARGET_FILE_BUDGET_SHARE = 0.25;
```

Add:

```ts
function candidateReadLimit(
  candidate: Candidate,
  maxBytes: number,
  remaining: number,
  targetScoped: boolean
): number {
  if (!targetScoped) return remaining;
  const share = candidate.kind === "target" ? TARGET_FILE_BUDGET_SHARE : NON_TARGET_FILE_BUDGET_SHARE;
  return Math.min(remaining, Math.max(1, Math.floor(maxBytes * share)));
}
```

Change only the read ceiling in the candidate loop:

```ts
const read = await adapter.readFile(input.workspaceId, candidate.path, {
  offset: 0,
  maxBytes: candidateReadLimit(candidate, maxBytes, remaining, input.target !== undefined)
});
```

Keep actual-byte accounting, warnings, `truncated`, candidate ranking, and output fields unchanged.

- [ ] **Step 5: Update the existing 20-byte deterministic-budget expectation**

The existing test `never exceeds the byte budget and omits later candidates deterministically` must now assert fairness rather than the old first-two-files monopoly. With the existing fixture and `maxBytes: 20`, expected selected paths become:

```ts
expect(result.selectedFiles.map((file) => file.path)).toEqual([
  TARGET,
  "packages/core/src/helper.ts",
  "package.json"
]);
expect(result.selectedFiles.map((file) => file.content?.length)).toEqual([10, 5, 5]);
expect(result.totalBytes).toBe(20);
```

Keep deterministic ordering and truncation assertions.

- [ ] **Step 6: Run focused GREEN and typecheck**

Run:

```bash
pnpm exec vitest run packages/capabilities/src/context-build.test.ts --no-file-parallelism
pnpm --filter @kodegpt/capabilities run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add packages/capabilities/src/context-build.ts packages/capabilities/src/context-build.test.ts
git commit -m "fix: balance target context evidence"
```

---

### Task 4: Add Lightweight Resume Guidance to the Existing Workflow Skill

**Files:**
- Modify: `skills/kodegpt-application-development-workflow/SKILL.md:8-18`
- Modify: `packages/skills/src/catalog.test.ts:202-223`

**Interfaces:**
- Consumes: existing host-owned workflow skill and existing `.ai-bridge` files.
- Produces: instruction-only resume convention; no runtime state, new tool, or context schema.

- [ ] **Step 1: Add failing workflow-content assertions**

In the existing workflow-skill catalog test, add these required markers to the `behavior` list:

```ts
"Resume / continuation",
".ai-bridge/current-plan.md",
".ai-bridge/agent-status.md",
"do not invent a new phase",
"before `context.build`"
```

- [ ] **Step 2: Run the workflow catalog test and prove RED**

Run:

```bash
pnpm exec vitest run packages/skills/src/catalog.test.ts --no-file-parallelism
```

Expected: FAIL on the missing resume markers while existing workflow compatibility remains `NATIVE`.

- [ ] **Step 3: Add the minimal resume section to the skill**

Insert before `## Adaptive flow`:

```markdown
## Resume / continuation

When the user asks to continue, resume, or lanjutkan prior work, recover coordination state before rebuilding repository context. Inspect current Git state first. If `.ai-bridge/current-plan.md` exists, read it; consult `.ai-bridge/agent-status.md`, `decisions.md`, or `open-questions.md` only when they are relevant to the active plan. Treat an explicit `CLOSED`, `RECONCILED`, `CLEAN`, or equivalent terminal state as terminal and do not invent a new phase merely to keep working. Resolve the active objective and target before `context.build`; `.ai-bridge` remains host coordination state and is not automatically part of semantic context.
```

Do not add state-writing automation, session IDs, agent delegation, or scheduler semantics.

- [ ] **Step 4: Run GREEN verification**

Run:

```bash
pnpm exec vitest run packages/skills/src/catalog.test.ts packages/skills/src/compatibility.test.ts --no-file-parallelism
```

Expected: PASS and workflow skill remains static `NATIVE`.

- [ ] **Step 5: Commit Task 4**

```bash
git add skills/kodegpt-application-development-workflow/SKILL.md packages/skills/src/catalog.test.ts
git commit -m "docs(skill): add bounded resume guidance"
```

---

### Task 5: Activate the Existing Repository Skill Source and Run Candidate Verification

**Files:**
- No product source file required for skill-source activation.
- Update during execution evidence only: `.ai-bridge/agent-status.md`.

**Interfaces:**
- Consumes: existing local CLI `skill source list/add` and persistent source registry.
- Produces: repository workflow skill becomes visible to live `skill.list` without a new source type.

- [ ] **Step 1: Check the local source registry before mutation**

Run with the exact candidate-built CLI or the exact current packaged CLI known to match the candidate command contract:

```bash
node apps/cli/bin/kodegpt.mjs skill source list
```

If `/home/sauron/dev/kodegpt/skills` is already present, record its `ss_...` ID and skip the add command. Do not remove/re-add it merely for reproducibility.

- [ ] **Step 2: Register the canonical repository skill root only when absent**

Run:

```bash
node apps/cli/bin/kodegpt.mjs skill source add /home/sauron/dev/kodegpt/skills --kind agent-skills
```

Then:

```bash
node apps/cli/bin/kodegpt.mjs skill source list
```

Expected: exactly one source entry for `/home/sauron/dev/kodegpt/skills`, plus the existing `/home/sauron/.agents/skills` source. No MCP source mutation is introduced.

- [ ] **Step 3: Run the full deterministic candidate suite**

Run from the implementation worktree:

```bash
pnpm install --frozen-lockfile
cargo fmt --all -- --check
pnpm run typecheck
pnpm test
cargo test --workspace
pnpm verify:forbidden
pnpm verify:package
pnpm --filter kodegpt build
```

`pnpm test` is the workspace-wide Vitest gate and already covers protocol/integration/security/isolation/acceptance test files; do not rerun those same suites separately unless the full test output exposes a concrete subset failure that needs focused diagnosis.

Expected: all PASS. If a failure appears, diagnose it; do not blind retry. Use `superpowers:systematic-debugging` for unexpected behavior and TDD for any fix.

- [ ] **Step 4: Audit the candidate diff for forbidden scope growth**

Confirm the diff contains no:

```text
workflow.run
skill.run
system.inventory
capability.list
feature.list
shell.run
command.run
provider.invoke
agent scheduler/session runtime
auto skill source discovery
context index/cache/vector/LSP subsystem
```

Confirm:

```text
MCP_SURFACE_VERSION == 0.16
listSurfaceTools().length == 75
runtime/protocol remain 0.1 / 2026-07-28
```

- [ ] **Step 5: Run code review before publication**

Use `superpowers:requesting-code-review`. Address only findings that are technically valid and in scope; use `superpowers:receiving-code-review` before applying non-trivial feedback.

- [ ] **Step 6: Push exact feature head and create PR**

Use typed KodeGPT Git/GitHub operations where available:

```text
git.push(feature branch)
github.pr.create(base=main, head=feat/development-usability-reconciliation)
```

Do not force-push.

- [ ] **Step 7: Require exact-head CI success**

Use `ci.status`, `ci.runs`, and `ci.run` as needed. If CI fails, use `ci.failure` before changing code. Never blind-rerun; use `ci.rerun` only when evidence supports an infrastructure/transient cause.

Expected: exact PR head `COMPLETED / SUCCESS`.

---

### Task 6: Merge, Cut Over Once, and Dogfood the Real Host

**Files:**
- Modify at final closure: `.ai-bridge/current-plan.md`
- Modify at final closure: `.ai-bridge/agent-status.md`
- No additional release document unless a concrete operational issue requires one.

**Interfaces:**
- Consumes: exact-head CI-green PR, existing service release lifecycle, registered skill sources.
- Produces: canonical merged `main`, one merged-main service cutover, live host evidence for discoverability/skills/context/resume.

- [ ] **Step 1: Merge only the reviewed exact head**

Use guarded `github.pr.merge` with `expectedHeadOid` from the verified PR head. Then fast-forward canonical local `main` to `origin/main` through normal typed Git or safe fast-forward-only Git.

Confirm canonical `main` is clean.

- [ ] **Step 2: Require merged-main CI success**

Use `ci.status` / `ci.run` for the merged main revision.

Expected: merged-main `COMPLETED / SUCCESS` before deployment claims.

- [ ] **Step 3: Build/install from exact merged main and perform one explicit cutover**

From canonical merged `main`:

```bash
pnpm install --frozen-lockfile
pnpm --filter kodegpt build
node apps/cli/bin/kodegpt.mjs service install --name public:kodegpt-dev --port 43121
node apps/cli/bin/kodegpt.mjs service status --json
```

Use the exact CLI bundle built from merged `main`; do not rely on whatever `kodegpt` binary happens to resolve from the ordinary shell PATH. Before restart, verify install staged a new immutable release without changing the active release.

Then perform one explicit cutover with the same exact CLI bundle:

```bash
node apps/cli/bin/kodegpt.mjs service restart
node apps/cli/bin/kodegpt.mjs service status --json
```

Require:

```text
state=running
enabled=true
listenerReady=true
managedExposure=true
runtimeVersion=0.1
protocolVersion=2026-07-28
surfaceVersion=0.16
```

Keep the previous immutable release as rollback. Do not do a pre-merge candidate cutover; this plan intentionally uses one post-merge cutover to avoid redundant service churn.

- [ ] **Step 4: Dogfood capability self-description through live KodeGPT**

Call live `system.capabilities`.

Require:

```text
publicTools.count == 75
```

Flatten `publicTools.families`; it must equal the 75 currently exposed public actions with no duplicate or missing name. Confirm representative families include `workspace`, `context`, `code`, `file`, `process`, `verify`, `git`, `github`, `ci`, `preview`, `browser`, `visual`, `skill`, `profile`, `artifact`, and `system`.

This is the primary acceptance for the discoverability defect: source-code archaeology must not be needed to enumerate public capabilities.

- [ ] **Step 5: Dogfood static versus effective skill compatibility**

Call live `skill.list` and confirm the repository workflow skill is visible after source registration.

For current personal skills, require absence of the proven false positives:

```text
ponytail-audit  -> no external-cli:lean
ponytail-review -> no external-cli:lean
refactor        -> no external-cli:total
```

Inspect `find-skills` with the canonical READY trusted `workspaceId`:

```text
skill.inspect(skillId=<find-skills>, workspaceId=<canonical workspace>)
```

Require:

```text
skill.compatibility.classification == PARTIAL   # static source evidence may stay partial
capabilityPlan.externalCliRequirements contains npx with status=available
capabilityPlan.nativeCapabilities contains process.run
capabilityPlan.missingCapabilities does not contain external-cli:npx
capabilityPlan.classification == NATIVE
```

Do not change static compatibility merely to make the two classifications look identical.

- [ ] **Step 6: Dogfood context budget fairness through live KodeGPT**

Call:

```text
context.build(
  workspaceId=<canonical workspace>,
  intent="review",
  target="packages/skills/src/compatibility.ts",
  maxBytes=24000
)
```

Require:

- `exact-target` present;
- no exact-target content exceeds 12,000 bytes;
- no non-target selected content exceeds 6,000 bytes;
- multiple evidence candidates are selected when available instead of one dependency consuming the entire budget;
- `totalBytes <= 24000`;
- truncation/warnings remain truthful.

If repository-analysis warnings remain but the selected evidence is practically sufficient, close this phase. Do not create target-focused repository analysis solely to remove warning strings.

- [ ] **Step 7: Dogfood resume guidance**

Load `kodegpt-application-development-workflow` through live `skill.load` and confirm the instruction body contains the resume convention and `.ai-bridge/current-plan.md` reference.

In a fresh/refreshed ChatGPT action inventory, confirm `skill.list` description communicates static compatibility and `skill.inspect` communicates workspace-aware resolution. If the host caches old action metadata, refresh/rescan the connector/action snapshot; this is a host-cache operation, not a reason to bump MCP surface version.

- [ ] **Step 8: Final verification-before-completion**

Use `superpowers:verification-before-completion` and re-check:

```text
main == origin/main
working tree clean
merged-main CI SUCCESS
live service healthy
runtime 0.1
protocol 2026-07-28
surface 0.16
75 public tools
repository workflow skill visible
find-skills effectively NATIVE through npx/process.run
known skill false positives absent
context fairness live dogfood PASS
```

- [ ] **Step 9: Reconcile `.ai-bridge` and stop**

Replace `.ai-bridge/current-plan.md` with a concise closure record containing:

```text
Status: RECONCILED / CLEAN
canonical merged main
PR number and merge commit
merged-main CI run/result
active and rollback release IDs
runtime/protocol/surface/tool count
implemented: discoverability, skill false-positive fix, context budget fairness, workflow source activation, resume guidance
remaining deliberate non-goals
```

Update `.ai-bridge/agent-status.md` with the exact checks and live dogfood results.

Do **not** create another phase just because some score is below 10. New work requires a concrete dogfooding failure or user need.

---

## Expected Outcome

After this plan:

- public capability discovery is self-describing enough that an auditor/host can map KodeGPT without opening source;
- static versus workspace-effective skill readiness is obvious from tool descriptions and behavior;
- the existing runtime-aware skill resolver is reused rather than duplicated;
- known `lean` / `total` false CLI findings are eliminated at the parser root cause;
- target context returns a broader evidence mix within the same byte budget;
- repository workflow skill is actually available through the existing skill source registry;
- cross-chat continuation uses the already-existing `.ai-bridge` convention rather than a session engine;
- editing/execution and flexibility gain no redundant primitive because trusted `process.run` already supplies the needed escape hatch;
- public surface remains `0.16 / 75 tools`.

## Explicit Stop Conditions

Stop and redesign instead of continuing if implementation proves any of the following:

1. `system.capabilities.publicTools` cannot be derived from the existing registry without introducing a second authority.
2. Precise inline-command detection would require a general Markdown/shell parser dependency merely to solve the observed false positives.
3. Context fairness requires changing candidate semantics/result schemas rather than only read ceilings.
4. Repository workflow skill cannot be activated through the existing source registry without modifying trust/runtime authority.
5. Resume guidance requires runtime persistence rather than host instructions for the actual user workflow.

None of these conditions is currently expected from the audited source.
