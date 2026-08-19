# KodeGPT Provider-Agnostic Application Development Workflow Design

Date: 2026-08-19
Status: written-spec review gate for Phase 5; implementation plan is not authorized until this spec is approved
Baseline: `main == origin/main == a4768e830b0756259ed1bf050699d3c9b268ac21`
Target: `runtime 0.1 / protocol 2026-07-28 / surface 0.14 / 76 tools`

## Problem

KodeGPT already exposes the bounded primitives needed for normal application development: repository understanding, code search and impact analysis, file mutation, process and verification execution, local previews, preview-scoped browser evidence, visual evidence, Git mutation, GitHub pull requests, and CI inspection/remediation.

The remaining usability gap is orchestration. Today the host must manually remember how to compose those primitives, when a stage is relevant, what evidence should gate the next action, and when not to invoke optional capabilities. Solving that gap inside KodeGPT with a workflow engine would duplicate the reasoning role of the host, create new state and lifecycle concerns, and weaken the existing authority model.

## Goal

Add one reusable **host-driven Agent Skill** for end-to-end application development with KodeGPT.

The skill teaches the host to explicitly compose existing KodeGPT tools through an adaptive workflow:

```text
understand
  -> implement
  -> verify
  -> [preview]
  -> [browser evidence]
  -> [visual evidence]
  -> final diff review
  -> commit/push
  -> PR
  -> CI
  -> [evidence-driven fix loop]
```

Square-bracketed stages are conditional. The workflow is not a fixed pipeline and must not execute stages merely because the corresponding tools exist.

Phase 5 adds no public MCP tools and does not change the existing runtime, protocol, or public surface target.

Here, **provider-agnostic** means the workflow is not implemented by, or coupled to, a provider-agent or deployment provider. It may use existing typed `github.*` and `ci.*` capabilities when their already-established provider admission is available, but it never falls back to generic provider invocation and it never makes deployment-provider availability a prerequisite for normal development.

## Architectural decision

Use a repository-owned Agent Skill as **host orchestration guidance**, not as a KodeGPT execution endpoint.

```text
             user intent
                 |
                 v
        ChatGPT / host reasoning
                 |
          loads Agent Skill
                 |
       chooses the next explicit
          KodeGPT tool call
                 |
                 v
      existing typed MCP capability
                 |
                 v
 TypeScript capability/service boundary
                 |
                 v
 Rust policy / sandbox / audit authority
```

The host remains the orchestration actor. The skill may guide sequencing, conditional stage selection, evidence interpretation, and repair decisions, but it never executes KodeGPT tools on the host's behalf.

KodeGPT remains:

- the typed capability server;
- the bounded read/mutation authority;
- the workspace trust and effective-policy boundary;
- the Rust-backed security, sandbox, retained-root, and audit authority;
- the provider-admission boundary for provider-backed tools that already exist.

No new workflow authority exists inside KodeGPT.

## Surface and version freeze

Phase 5 must preserve exactly:

- runtime version: `0.1`;
- protocol identifier: `2026-07-28`;
- MCP semantic surface: `0.14`;
- public MCP tool count: `76`.

Phase 5 must not add or register:

- `workflow.run`;
- `skill.run`;
- a generic orchestration MCP endpoint;
- a workflow/session execution API;
- generic `provider.invoke`;
- any additional deployment-provider tool;
- any generic deployment abstraction.

Existing exact tool schemas and authority boundaries remain authoritative.

## Skill artifact

Phase 5 v1 should add one concise Agent Skill in a repository-owned skill source, using the existing Agent Skills `SKILL.md` format. The implementation plan may choose the final repository path according to existing source/packaging conventions, but the skill itself must be independently loadable as a normal Agent Skill and must not require a new runtime subsystem.

The skill should be self-contained in v1 unless testing demonstrates that one small text reference materially improves correctness. It should not ship executable helper scripts, an autonomous agent, a provider dependency, or a workflow-state file.

The skill frontmatter should keep normal Agent Skills discovery fields (`name` and `description`) minimal. It should not declare artificial `kodegpt.requires.capabilities` entries solely to make newer preview/browser/visual tool names appear in the older semantic capability registry.

### Semantic metadata policy

`NATIVE_CAPABILITY_IDS` and the existing skill semantic registry predate some preview/browser/visual tool families. That does not make those public MCP tools unavailable: the host can call them explicitly through their normal typed schemas.

Phase 5 therefore uses this rule:

1. **Default: no `NATIVE_CAPABILITY_IDS` change and no broad capability-registry refactor.**
2. Write the skill so it can be inspected and loaded without falsely declaring newer tool families as missing requirements.
3. Only if a failing skill-inspection/host test proves that existing semantic guidance materially misclassifies or prevents correct discovery may implementation make the smallest metadata-only correction necessary.
4. Such a correction must not create a new public tool, permission, execution path, or authority and must keep `surface 0.14 / 76 tools` unchanged.

A metadata registry remains advisory, never a permission table.

## Orchestration ownership

The skill must make ownership explicit.

### Host owns

- understanding user intent and acceptance criteria;
- deciding which workflow stages apply;
- selecting the next explicit KodeGPT tool call;
- interpreting repository, test, browser, visual, Git, PR, and CI evidence;
- deciding whether a failure requires a code change, test change, configuration change, or no action;
- maintaining conversational workflow context such as current evidence, preview ID, PR number, or CI run ID;
- deciding when the task is complete enough to present to the user.

### KodeGPT owns

- schema validation for every tool call;
- workspace readiness/trust and effective policy;
- filesystem and Git boundaries;
- process sandboxing and executable policy;
- preview lifecycle and exact loopback origin authority;
- preview-scoped browser authority;
- bounded screenshot/artifact evidence;
- provider admission, credential and network authority for existing provider-backed tools;
- GitHub mutation guards;
- CI mutation/read guards;
- Rust final OS/security authority;
- audit ordering and durable audit evidence.

The host must never infer that loading the skill grants authority. Every operation still requires a separate ordinary KodeGPT tool call and its normal policy checks.

## Adaptive workflow

### 1. Understand

Start by building enough evidence to identify the smallest correct change.

Preferred primitives include:

- `context.build` with an intent appropriate to the task;
- `workspace.inspect` when a repository map is useful;
- `code.search` for definitions/references/text/path evidence;
- `code.impact` before changing a file or symbol with non-obvious dependents;
- `file.read` for exact source/config/test context;
- `git.status`, `git.changes`, `git.log`, `git.show`, `git.range`, or historical diff tools when repository state/history matters.

The host should not read the entire repository by default. Context gathering stops when there is enough evidence to define the intended change, affected area, and first verification target.

### 2. Implement

Make the smallest coherent change through normal bounded file tools:

- `file.edit` for exact replacements;
- `file.patch` for controlled multi-hunk edits;
- `file.write` for a genuinely new or deliberately replaced text file.

For behavior changes, implementation must be test-first where practical: create or adjust the smallest test that demonstrates the intended behavior, observe the expected failure, then make the minimal production change.

Do not use `process.run` as a substitute for typed file, Git, GitHub, preview, browser, visual, or CI tools.

### 3. Verify from smallest to broader scope

Verification starts with the narrowest meaningful check.

Typical order:

1. one affected test or focused verification recipe;
2. the affected package/module suite;
3. broader typecheck/build/security/package gates when justified by the changed area;
4. the full repository suite only when the change scope or repository release gate requires it.

Use `verify.list` to discover admitted repository recipes and `verify.run` where a suitable recipe exists. Use policy-approved `process.run` only for a bounded project command that is not already represented by a typed capability or verification recipe.

A failed verification is evidence. The host must inspect the actual failure, identify the cause, change only what the evidence supports, and rerun the smallest check capable of proving the repair. Blind retry loops are forbidden.

### 4. Preview only when the application is previewable

Use `preview.start` only when runtime behavior is materially relevant and the repository exposes a bounded local preview/dev command that can be run under existing process policy.

Skip preview for changes such as:

- documentation-only edits;
- non-UI libraries where tests/typecheck are sufficient;
- build tooling or static configuration whose acceptance does not require a running app;
- backend changes that are fully covered by direct automated verification and do not require browser behavior.

When a preview is started, use `preview.inspect` to require running/reachable readiness before browser work. Always stop a KodeGPT-owned preview when it is no longer needed.

### 5. Browser evidence only when browser behavior is relevant

Browser work requires an existing live KodeGPT preview.

Use `browser.openPreview`, then choose only the evidence/actions needed for the task:

- `browser.inspect` for bounded page/accessibility/body evidence;
- `browser.console` for runtime console failures;
- `browser.networkFailures` for failed-request evidence;
- `browser.click` and `browser.type` to reproduce or validate a concrete interaction;
- `browser.screenshot` when a single render capture is useful.

Do not invoke browser tools for non-browser work. Do not invent arbitrary navigation or external URLs; browser authority remains bound to the preview's exact stored origin.

### 6. Visual evidence only for visual/UI-impacting work

Use visual verification when the change can alter layout, responsive behavior, or rendered appearance.

- `visual.captureMatrix` is the default responsive evidence for a meaningful UI change.
- `visual.compare` is used only when an explicit trustworthy reference artifact already exists and pixel comparison answers a real acceptance question.

Absence of a reference artifact is not an error and must not trigger baseline creation, automatic acceptance, or a persistent baseline store.

KodeGPT supplies deterministic visual evidence; the host interprets whether a difference is expected and acceptable.

### 7. Final diff review before publish

Before any commit or push, review the complete pending change with `git.changes` and/or `git.diff`, supported by `context.build(intent:"review")` or focused reads when useful.

The final review must verify:

- only intended files changed;
- no debug/temporary artifacts were introduced;
- no unrelated formatting/refactor noise expanded scope;
- tests/config/docs match the implemented behavior;
- generated or security-sensitive material is not accidentally included;
- verification evidence corresponds to the final diff, not an earlier version.

If final review changes the implementation, rerun the smallest verification invalidated by that edit before publishing.

### 8. Commit, push, and PR

Publish only after final diff review and relevant verification pass.

Use typed Git operations:

- `git.stage` only intended paths;
- `git.commit` with a bounded meaningful message;
- `git.push` the feature branch without force;
- `github.pr.create` to open the pull request against the intended base branch;
- `github.pr.inspect` when exact PR/head evidence is needed.

Do not publish unrelated dirty state. Do not bypass exact-head guards or use generic provider/shell mechanisms for GitHub mutation.

### 9. CI evidence and repair loop

After PR creation, inspect CI using `ci.status`, `ci.runs`, and `ci.run` as needed.

The skill must not busy-poll CI. If CI is queued or still running, report that evidence and re-check only through a later explicit host action/user continuation.

If CI succeeds, no remediation is performed.

If CI fails:

1. inspect the failed run/job with `ci.run` and `ci.failure`;
2. identify the smallest evidence-supported cause;
3. update local code/tests/config only when the failure justifies it;
4. rerun the smallest relevant local verification;
5. perform final diff review again;
6. commit and push the repair;
7. inspect CI for the new exact head.

`ci.rerun` is not a default repair action. Use it only when evidence supports an infrastructure/transient failure and no source change is required. Never repeatedly rerun a failing job without new evidence.

## Evidence-driven repair rules

The skill must use a consistent repair discipline across local verification, preview/browser evidence, visual evidence, and CI:

1. capture the failing evidence;
2. localize the likely cause;
3. gather one additional focused piece of evidence if the cause is ambiguous;
4. make the smallest supported change;
5. rerun the narrowest proof invalidated by the change;
6. widen verification only after the narrow proof passes.

The host must not respond to failure by blindly rerunning the same command, restarting every stage, or broadening scope without evidence.

## Stage-selection examples

| Change type | Verify | Preview | Browser | Visual |
|---|---|---|---|---|
| Documentation only | targeted docs/package checks if present | skip | skip | skip |
| Pure library/internal refactor | focused tests/typecheck | usually skip | skip | skip |
| Backend/API behavior | focused tests; broader gates as needed | only if runtime acceptance needs it | only if a browser flow consumes it | usually skip |
| UI logic/interaction | focused tests/typecheck | use | use | when rendered behavior can change |
| CSS/layout/responsive change | focused tests/typecheck | use | use | use matrix; compare only with real reference |
| CI-only remediation | reproduce locally when possible | only if relevant to failure | only if relevant | only if relevant |

These are defaults, not a second hard-coded pipeline. User acceptance criteria and repository evidence may justify skipping or adding a stage.

## Workflow state

Phase 5 creates no persistent workflow state.

The host may keep a short conversational evidence ledger containing values such as:

- workspace identity and baseline branch/head;
- intended change and affected files;
- latest focused verification result;
- active preview ID while a preview exists;
- relevant browser/visual artifact references;
- final reviewed Git diff/head;
- PR number/head OID;
- CI run/job evidence.

This ledger lives in host conversation/reasoning state only. It is not a KodeGPT database, session record, queue item, supervisor record, hidden workspace file, or provider-side workflow object.

## Deployment policy

Typed Preview Deployment from Phase 4 remains intact but is **outside the normal Phase 5 workflow**.

The Agent Skill must not call `deploy.preview.create` or `deploy.preview.inspect` merely because application development reached PR or CI.

Rules:

- no Netlify provider is required for Phase 5 acceptance;
- absence of admitted `netlify.deploy.v1` must not degrade or block the normal workflow;
- do not configure or admit Netlify solely to test Phase 5;
- do not add Vercel, Cloudflare, or another deployment provider;
- do not introduce a generic deployment abstraction;
- deployment may be used only through the existing typed Phase 4 tools when the user explicitly asks for that separate deployment action and the existing provider admission already permits it.

Netlify remains a bounded reference implementation for typed deployment, not the architecture of the development workflow.

## Extension manifest policy

The current extension manifest system remains metadata/profile-restriction oriented. Phase 5 must not repurpose it into an execution, workflow, scheduling, or provider-agent layer.

The Agent Skill is host guidance. Extension manifests do not execute its stages and do not hold workflow state.

## Security and authority invariants

Phase 5 must preserve all existing security properties and explicitly add no bypass around them:

- every real operation is a separate existing typed KodeGPT call;
- loading/inspecting the Agent Skill grants no authority;
- no `skill.run`, workflow engine, task session, scheduler, queue, or supervisor;
- no provider-agent/subagent process execution;
- no generic provider invocation or arbitrary HTTP surface;
- no direct host filesystem mutation that bypasses KodeGPT for application work governed by this workflow;
- no shell use to bypass typed Git/GitHub/CI/preview/browser/visual capabilities;
- `process.run` remains bounded by normal workspace/process policy and is not a generic escape hatch;
- no credential forwarding or exposure;
- no hidden workflow persistence;
- no automatic mutation retry;
- no automatic visual baseline acceptance;
- no authority is derived from semantic metadata;
- Rust remains final OS/security authority;
- existing audit decision-before-OS-action ordering remains unchanged.

## Error handling

The skill does not invent a parallel error vocabulary. It consumes existing structured KodeGPT errors and evidence.

Host behavior on error:

- policy/authority denial: report the denial; do not search for a bypass;
- missing verification/preview capability: skip or use an already-admitted bounded alternative only when repository evidence supports it;
- preview not ready: inspect preview evidence before browser work; do not open arbitrary URLs;
- browser/visual failure: inspect relevant console/network/render evidence before changing code;
- Git mutation failure: inspect Git state and resolve the exact local cause;
- provider not admitted: treat optional provider-backed behavior as unavailable rather than configuring a provider automatically;
- CI failure: inspect `ci.failure` before editing or rerunning;
- ambiguous remote mutation outcome: preserve the existing reconciliation/fail-closed behavior and never blind-retry.

## Testing strategy for Phase 5 implementation

Implementation must follow test-first skill authoring and keep the test scope proportional to a host-guidance feature.

### 1. Agent Skill behavior tests

Before finalizing the skill text, run baseline pressure scenarios in fresh host-side test contexts without the new skill and record the failure modes the skill must correct. These are skill-authoring tests outside KodeGPT runtime authority; the production skill itself must not require, spawn, or delegate to subagents/provider agents. Representative scenarios must include:

- a non-UI change where an agent is tempted to run preview/browser/visual stages unnecessarily;
- a UI change where an agent is tempted to stop after unit tests without browser/visual evidence;
- a failing test where an agent is tempted to rerun blindly instead of diagnosing evidence;
- a dirty/unrelated final diff where an agent is tempted to publish anyway;
- a CI failure where an agent is tempted to rerun without `ci.failure` evidence;
- missing Netlify admission where an agent is tempted to configure deployment even though deployment was not requested.

Then run equivalent scenarios with the skill loaded and verify the host follows the adaptive/evidence-driven rules.

### 2. Existing skill parser/inspection coverage

Add only the minimal repository fixture/test needed to prove the new `SKILL.md`:

- parses successfully;
- is discoverable/loadable through existing skill machinery when registered as a normal source;
- does not become `PROVIDER_REQUIRED` or `UNSUPPORTED` merely because it describes the normal host-driven workflow;
- does not require `skill.run` or provider-agent execution;
- does not require semantic-registry expansion unless a failing test proves a concrete classification defect.

### 3. Surface regression

Existing MCP/security tests must continue to prove:

- exactly 76 public tools;
- semantic surface `0.14`;
- runtime `0.1` and protocol `2026-07-28` unchanged;
- no `workflow.run`, `skill.run`, generic provider invocation, or extra deployment tools.

If implementation touches only skill/docs/test assets, no production runtime change is justified. Any proposed change to MCP registration, core managers, provider gateway authority, Rust runtime/protocol, workflow persistence, or public tool contracts is scope expansion and requires a new explicit design approval before implementation continues.

## Acceptance criteria

Phase 5 v1 is complete when all of the following are true:

1. one normal Agent Skill captures the approved adaptive application-development workflow;
2. the host, not KodeGPT, owns orchestration and evidence interpretation;
3. the skill explicitly composes existing tools rather than introducing an execution endpoint;
4. non-applicable preview/browser/visual stages are skipped;
5. UI-impacting work can reach preview, browser, and visual evidence through existing tools;
6. failures trigger evidence-based diagnosis and the smallest repair loop, not blind retries;
7. final diff review occurs before publish;
8. commit/push/PR use existing typed Git/GitHub authority;
9. CI remediation happens only after CI reports a failure and failure evidence is inspected;
10. Netlify deployment remains dormant and optional outside the normal happy path;
11. no workflow DB, scheduler, queue, supervisor, provider agent, generic provider invocation, or generic deployment abstraction exists;
12. `runtime 0.1 / protocol 2026-07-28 / surface 0.14 / 76 tools` remains unchanged;
13. focused skill tests and existing surface/security regression gates pass;
14. host acceptance demonstrates at least one adaptive path that skips irrelevant stages and one UI path that uses the relevant evidence stages without authority bypass.

## Non-goals

Phase 5 v1 does not implement:

- a KodeGPT workflow engine;
- `workflow.run` or `skill.run`;
- autonomous/background development sessions;
- persistent workflow state or checkpoint databases;
- schedulers, queues, polling workers, or supervisors;
- provider-agent or subagent execution;
- generic `provider.invoke` or arbitrary HTTP;
- additional deployment providers;
- a generic deployment abstraction;
- automatic Netlify configuration/admission;
- deployment as part of the normal development happy path;
- automatic mutation retry;
- automatic CI rerun loops;
- automatic visual baseline creation or acceptance;
- arbitrary browser navigation;
- a broad rewrite of `NATIVE_CAPABILITY_IDS` or skill semantic metadata;
- new filesystem, Git, process, preview, browser, visual, GitHub, or CI primitives that already exist.

## Design summary

Phase 5 is intentionally an orchestration **skill**, not an orchestration **service**. The host reasons about the task, chooses applicable stages, calls existing KodeGPT tools one at a time, interprets bounded evidence, and repairs from evidence. KodeGPT continues to provide typed capabilities and enforce the authority boundary for each individual operation.

This preserves the architecture already established by native skill orchestration while turning the current collection of application-development primitives into one practical end-to-end development workflow without increasing the public MCP surface or coupling normal development to a deployment provider.
