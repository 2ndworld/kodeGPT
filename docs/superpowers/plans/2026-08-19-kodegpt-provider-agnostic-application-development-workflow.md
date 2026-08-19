# KodeGPT Provider-Agnostic Application Development Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one repository-owned Agent Skill that teaches the host to compose KodeGPT's existing typed capabilities into an adaptive application-development workflow from understanding through PR/CI, without widening KodeGPT's runtime or public MCP surface.

**Architecture:** Keep orchestration entirely in the host. Add `skills/` as a passive repository-owned Agent Skills source root containing one self-contained `SKILL.md`; prove through the existing `SkillCatalog` test seam that the committed skill is a normal discoverable/loadable `NATIVE` skill. Reuse existing surface/security regression tests to prove `runtime 0.1 / protocol 2026-07-28 / surface 0.14 / 76 tools` remains unchanged. No production runtime code changes are planned; a metadata-only capability correction is allowed only if the new inspection test demonstrates a concrete misclassification that prevents the approved skill from remaining normally loadable.

**Tech Stack:** Agent Skills `SKILL.md`, TypeScript 5.9, Node.js 24, Vitest 3.2, existing `@kodegpt/skills` parser/catalog/compatibility machinery, pnpm 10.15.0, existing Rust workspace verification.

**Spec:** `docs/superpowers/specs/2026-08-19-kodegpt-provider-agnostic-application-development-workflow-design.md`

## Global Constraints

- Start from feature HEAD `27a4eb49faca491fa73e2ee2df1b2ee796d2ec9d` on `feat/provider-agnostic-application-development-workflow`; canonical `main == origin/main == a4768e830b0756259ed1bf050699d3c9b268ac21` before implementation.
- Freeze runtime `0.1`, protocol `2026-07-28`, MCP surface `0.14`, and public tool count `76`.
- Do not add `workflow.run`, `skill.run`, a generic orchestration endpoint, workflow state/database, scheduler/queue/supervisor, provider-agent/subagent execution inside KodeGPT, `provider.invoke`, arbitrary HTTP, additional deployment providers, or a generic deployment abstraction.
- Host/ChatGPT owns stage selection, sequencing, evidence interpretation, and conversational workflow state. KodeGPT remains the typed bounded capability/security authority.
- The normal path is `understand → implement → verify → [preview] → [browser evidence] → [visual evidence] → final diff review → commit/push → PR → CI → [evidence-driven fix loop]`.
- Preview is conditional on a previewable/runtime-relevant change; browser evidence is conditional on browser behavior; visual evidence is conditional on visual/UI impact.
- Netlify preview deployment stays outside the normal Phase 5 happy path and must never be auto-configured or auto-invoked by the skill.
- Default to no `NATIVE_CAPABILITY_IDS` or semantic-registry change. Do not add artificial frontmatter capability requirements for preview/browser/visual/GitHub tools. Make a metadata-only correction only if the new inspection test fails because the current advisory registry materially misclassifies the skill.
- All authored behavior changes follow RED → GREEN → REFACTOR. The `SKILL.md` must not be written before its focused failing repository test is observed.
- Keep the skill self-contained: one `SKILL.md`, no executable helper, autonomous agent, provider dependency, or workflow-state file.
- Fresh-host pressure scenarios are acceptance evidence, not a reason to add subagent execution to KodeGPT. Where the current environment cannot spawn an independent fresh host, retain deterministic contract assertions and record the host-pressure check as manual acceptance rather than widening runtime authority.

---

### Task 1: Lock the Repository-Owned Agent Skill Contract with a RED Test

**Files:**
- Modify: `packages/skills/src/catalog.test.ts`
- Future create after RED only: `skills/kodegpt-application-development-workflow/SKILL.md`

**Interfaces:**
- Consumes: the committed `SKILL.md` bytes and the existing `FakeSourceManager`/`SkillCatalog` test seam.
- Produces: deterministic proof that the repository skill parses, is discovered as a direct-child Agent Skill, inspects as `NATIVE`, and loads through the normal catalog path without provider/subagent requirements.

- [ ] **Step 1: Add repository fixture path helpers to the existing catalog test**

Import Node filesystem/path URL helpers only in the test:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORKFLOW_SKILL_NAME = "kodegpt-application-development-workflow";
const WORKFLOW_SKILL_PATH = join(
  REPOSITORY_ROOT,
  "skills",
  WORKFLOW_SKILL_NAME,
  "SKILL.md"
);
```

Do not add a new source manager, parser, packaging subsystem, or filesystem production adapter.

- [ ] **Step 2: Write the focused failing catalog test before the skill exists**

Add one test under `SkillCatalog live discovery` that:

1. reads `WORKFLOW_SKILL_PATH`;
2. inserts those exact bytes into the existing fake Agent Skills source at `${WORKFLOW_SKILL_NAME}/SKILL.md`;
3. calls `catalog.listLive()` and proves the skill is discovered with the expected name and `compatibility.classification === "NATIVE"`;
4. calls `catalog.inspectLive()` and proves there are no missing capabilities, provider requirements, or blocked subagent/Codex semantics;
5. proves the advisory native capability plan recognizes the existing registry-backed primitives that the skill explicitly uses, including `context.build`, `code.search`, `code.impact`, `file.edit`, `verify.run`, `process.run`, `git.diff`, `git.commit`, `git.push`, `ci.status`, `ci.failure`, and `ci.rerun` where represented by current semantic metadata;
6. calls `catalog.loadLiveRaw()` and verifies the loaded instruction body contains the approved conditional-stage and evidence rules plus the newer explicitly callable tool families (`preview.*`, `browser.*`, `visual.*`, `github.pr.*`) without declaring them missing/provider-required;
7. verifies the instructions explicitly keep host orchestration ownership and reject synthetic orchestration/runtime behavior such as `skill.run`, blind retry, automatic Netlify use, and CI rerun without failure evidence.

Keep assertions semantic and representative rather than snapshotting the whole Markdown file.

- [ ] **Step 3: Run the RED test and observe the expected failure**

Run only the focused catalog test first:

```bash
pnpm exec vitest run packages/skills/src/catalog.test.ts --no-file-parallelism
```

Expected: FAIL because `skills/kodegpt-application-development-workflow/SKILL.md` does not exist. If it fails for a different reason, fix the test until the missing skill artifact is the demonstrated failure.

- [ ] **Step 4: Do not touch production/runtime code during RED**

Confirm the only changed implementation-side file is still the test. In particular, do not edit:

- `packages/capabilities/src/contracts.ts` / `NATIVE_CAPABILITY_IDS`;
- `packages/capabilities/src/skill-metadata.ts`;
- `packages/mcp-server/src/tools.ts`;
- `packages/mcp-server/src/surface-version.ts`;
- any runtime/Rust protocol code.

---

### Task 2: Author the Minimal Host-Orchestration Skill and Reach GREEN

**Files:**
- Create: `skills/kodegpt-application-development-workflow/SKILL.md`
- Modify only if the RED/GREEN evidence requires tightening: `packages/skills/src/catalog.test.ts`
- Conditional only on demonstrated metadata misclassification: the smallest advisory metadata file necessary; broad registry refactors remain forbidden.

**Interfaces:**
- Agent Skills frontmatter: exactly normal discovery fields `name` and `description` unless existing parser requirements prove otherwise.
- Body: host guidance only. Loading the skill never grants authority; every action remains a separate ordinary KodeGPT tool call.

- [ ] **Step 1: Write minimal valid Agent Skills frontmatter**

Use a directory/name identity match:

```yaml
---
name: kodegpt-application-development-workflow
description: Use when developing or fixing an application with KodeGPT from repository understanding through verified PR and CI evidence.
---
```

The description is a trigger only; do not summarize the workflow in frontmatter and do not add `metadata.kodegpt.requires` entries merely to advertise newer tools.

- [ ] **Step 2: Encode orchestration ownership and the adaptive workflow**

The skill body must state concisely that:

- the host interprets user intent, chooses applicable stages, sequences explicit tool calls, interprets evidence, and keeps conversational IDs/state;
- KodeGPT validates and authorizes every ordinary typed operation;
- loading the skill is guidance, not execution authority;
- the canonical flow is adaptive, not a fixed pipeline.

Provide a compact stage/condition/tool reference for:

- understand: `context.build`, `workspace.inspect`, `code.search`, `code.impact`, `file.read`, relevant `git.*` history/status tools;
- implement: `file.edit`, `file.patch`, `file.write` with test-first changes;
- verify: `verify.list`, `verify.run`, bounded `process.run` only when no suitable typed/recipe path exists;
- preview: `preview.start`, `preview.inspect`, `preview.stop` only when previewable/runtime-relevant;
- browser: `browser.openPreview`, `browser.inspect`, `browser.console`, `browser.networkFailures`, and targeted interactions/screenshots only when browser behavior matters;
- visual: `visual.captureMatrix` by default for UI/layout impact and `visual.compare` only with an explicit trusted reference artifact;
- publish: final `git.changes`/`git.diff` review, then `git.stage`, `git.commit`, `git.push`, `github.pr.create`/`github.pr.inspect` as appropriate;
- CI: `ci.status`, then `ci.run`/`ci.failure` only when evidence shows failure; repair minimally and republish; `ci.rerun` only for evidence-supported transient/infrastructure failure.

- [ ] **Step 3: Encode the discipline pressure points discovered by the approved spec**

Use explicit decision rules that resist these failure modes:

- non-UI task: do not create preview/browser/visual work merely because tools exist;
- UI task: do not stop after unit tests when preview/browser/visual evidence is relevant;
- failed verification: diagnose the returned evidence and make a targeted change; never blind retry;
- dirty final diff: review exact final changes before commit/push/PR, and rerun verification invalidated by review edits;
- CI failure: inspect run/failure evidence before remediation; do not call `ci.rerun` as a substitute for diagnosis;
- deployment: never auto-configure or auto-invoke Netlify; deployment is a separate explicit workflow outside the normal happy path.

Also state that a failed stage loops back only to the smallest affected earlier stage, rather than restarting the whole workflow.

- [ ] **Step 4: Run GREEN catalog verification**

Run:

```bash
pnpm exec vitest run packages/skills/src/catalog.test.ts --no-file-parallelism
```

Expected: PASS. Inspect the returned test behavior if compatibility is not `NATIVE`.

If the failure is caused solely by the older semantic registry not recognizing preview/browser/visual/GitHub names, first verify that those names are merely absent advisory metadata rather than truly missing public tools. Prefer adjusting skill wording/test expectations so the normal parser/catalog can load the skill. Only if inspection is materially wrong or blocks normal discovery may the smallest metadata-only correction be considered, with a new failing test first.

- [ ] **Step 5: REFACTOR the skill, not the architecture**

Remove redundant prose, keep the body scan-friendly and self-contained, and ensure the trigger description remains only a trigger. Re-run the focused catalog test after every substantive wording change that affects tested behavior.

- [ ] **Step 6: Commit the skill/test implementation**

Stage only the skill and its focused test, then commit with a narrow message such as:

```text
feat(skills): add application development workflow guidance
```

Do not include runtime/surface changes in this commit unless a separately demonstrated TDD metadata correction was strictly necessary.

---

### Task 3: Prove Surface/Security Freeze and Broader Skill Regression

**Files:**
- Verify existing: `packages/mcp-server/src/server.test.ts`
- Verify existing: `tests/security/security-invariants.test.ts`
- Verify existing: `tests/integration/provider-gateway.test.ts`
- Verify existing: `tests/integration/skill-interoperability.test.ts`
- Verify existing: relevant `packages/skills/src/*.test.ts`
- No planned production modifications.

**Interfaces:**
- Existing MCP contract must remain exactly `surface 0.14 / 76 tools`.
- Existing skill interoperability must continue to forbid public execution/source/provider escape hatches.

- [ ] **Step 1: Run the focused skill/orchestration regression set**

Run the smallest set covering parser/catalog/compatibility/capability-plan plus the new repository skill test. Prefer the repository's existing test invocations; one acceptable focused form is:

```bash
pnpm exec vitest run packages/skills/src packages/mcp-server/src/skills.test.ts tests/integration/skill-interoperability.test.ts --no-file-parallelism
```

Expected: PASS.

- [ ] **Step 2: Run explicit surface/security freezes**

Run:

```bash
pnpm exec vitest run packages/mcp-server/src/server.test.ts tests/security/security-invariants.test.ts tests/integration/provider-gateway.test.ts --no-file-parallelism
```

Required evidence:

- `MCP_SURFACE_VERSION === "0.14"`;
- public tools length is exactly `76`;
- forbidden orchestration/provider escape hatches remain absent;
- no new generic provider or deployment surface appears.

- [ ] **Step 3: Run repository verification gates**

Run the applicable existing gates, starting narrow and widening only after focused success:

```text
pnpm typecheck
pnpm build
pnpm verify:forbidden
cargo fmt --all -- --check
cargo check --workspace
cargo build --workspace
```

Use KodeGPT `verify.run` where a matching recipe exists; use bounded `process.run` only for an uncovered focused command. Do not retry a failed command blindly: inspect its output, identify the cause, make the smallest justified change, then rerun the invalidated scope.

- [ ] **Step 4: Review the final diff before publishing**

Use `git.changes`/`git.diff` evidence and verify that the final implementation is limited to:

- the approved spec and committed plan already on the branch;
- one repository-owned `SKILL.md`;
- minimal skill discovery/load/behavior test changes;
- no production/runtime change unless backed by a recorded failing test.

Search the final diff for TODO/TBD/placeholders, accidental public tool additions, version/tool-count drift, provider-agent/subagent execution, workflow state/runtime, automatic Netlify behavior, and broad `NATIVE_CAPABILITY_IDS` expansion.

If review edits the implementation or tests, rerun the smallest verification invalidated by those edits before publication.

---

### Task 4: Host Pressure Acceptance, Publish, PR, and CI Evidence

**Files:**
- No new repository file is required for machine-specific host evidence.
- Existing manual host evidence convention: `tests/host/README.md`.

**Interfaces:**
- Host consumes the skill as guidance.
- KodeGPT operations remain explicit ordinary typed calls.
- Repository publication uses existing typed Git/GitHub/CI authorities only.

- [ ] **Step 1: Exercise representative host pressure scenarios where the host environment permits it**

Use fresh host contexts when available and check these scenarios against the loaded skill:

1. backend/non-UI change skips preview/browser/visual after sufficient verification;
2. UI/layout change proceeds from tests to preview, browser evidence, and visual evidence when relevant;
3. failing local verification is diagnosed instead of blindly rerun;
4. final dirty diff is reviewed before publish;
5. CI failure is inspected with `ci.run`/`ci.failure` before any remediation or rerun;
6. missing Netlify configuration does not trigger automatic provider configuration/deployment.

Baseline-without-skill evidence is desirable for skill-authoring TDD. If the current ChatGPT environment cannot spawn a genuinely fresh independent host without the skill, do not fake that evidence and do not add agent/subagent runtime capability to KodeGPT. Treat deterministic catalog/contract tests as the automated gate and report the fresh-host pressure pass as manual/unobserved until actually run.

- [ ] **Step 2: Reconfirm publication readiness**

Immediately before push, confirm:

- feature branch clean except intentional committed work;
- no unreviewed diff;
- canonical `main` has not been modified locally;
- exact local feature HEAD is recorded;
- focused + surface/security + build/forbidden gates are green.

- [ ] **Step 3: Push and create the Phase 5 PR through existing typed tools**

Use `git.push` for `feat/provider-agnostic-application-development-workflow`, then `github.pr.create` against `main`. The PR description should state that Phase 5 adds host guidance only, keeps `surface 0.14 / 76 tools`, and adds no runtime orchestration endpoint/provider abstraction.

- [ ] **Step 4: Observe exact-head CI without busy polling**

Use `github.pr.inspect` to capture the exact PR head, then `ci.status`/`ci.runs` as needed. If CI is still queued/running, report that state rather than busy-polling.

If CI fails:

1. inspect the exact run with `ci.run`;
2. gather bounded failure evidence with `ci.failure`;
3. identify the smallest code/test/doc cause;
4. write a failing local reproduction where applicable;
5. fix minimally;
6. rerun only invalidated local verification first;
7. review final diff again;
8. commit/push the repair;
9. verify the new exact PR head and observe CI again.

Use `ci.rerun` only when failure evidence supports a transient/infrastructure cause rather than a product/test failure.

- [ ] **Step 5: Stop at evidence, not assumptions**

Do not claim Phase 5 complete until implementation, required deterministic gates, final diff review, PR creation, and the available exact-head CI evidence have been observed. If CI is in progress, report Phase 5 implementation/PR as ready with CI pending rather than inventing completion.
