# KodeGPT Personal Trusted Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ChatGPT the everyday trust control plane for KodeGPT and make `trusted` suitable for normal end-to-end personal development without granular permission choreography.

**Architecture:** Reuse the existing workspace trust store, workspace manager, profile model, hardened runtime, and audit pipeline. Add only three trust-facing MCP semantics, then fix the actual trusted runtime blocker from evidence, add typed local Git mutation, add typed remote Git workflow, and close the surface through the existing package/service/host acceptance lifecycle. No new granular grants or Personal Admin Mode state is introduced.

**Tech Stack:** TypeScript, Zod, Vitest, Rust, Cargo, existing KodeGPT runtime protocol, MCP server, durable JSON state/audit, retained-root sandbox.

## Global Constraints

- Baseline is canonical `main` with MCP surface `0.4`; adding public tools requires an explicit surface bump.
- `trusted means trusted` for routine workspace-scoped development.
- Public trust surface is intentionally small: `trust.list`, `workspace.trust`, `workspace.untrust`.
- Re-trusting an existing canonical root with another profile is the profile-update path; do not add separate policy/grant tools in this phase.
- Callers never provide filesystem identity; KodeGPT derives it locally.
- Repository-controlled content cannot directly mutate trust state.
- `trusted` remains workspace-scoped; no implicit whole-home/host filesystem authority.
- Durable audit is mandatory for trust/profile and Git mutation.
- Public Git mutation is typed; no raw Git argv or generic shell interface.
- Force push, hard reset, aggressive rebase, provider interoperability, credential disclosure, and root/system administration are out of scope.
- Use TDD for every behavior change and keep commits task-scoped.

---

### Task 1: ChatGPT Workspace Trust

**Files:**
- Modify: `packages/trust/src/workspace-trust-store.ts`
- Test: `packages/trust/src/workspace-trust-store.test.ts`
- Modify: `packages/core/src/workspace-manager.ts`
- Test: `packages/core/src/workspace-manager.test.ts`
- Modify: `packages/mcp-server/src/tool-context.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Test: adjacent MCP schema/structured-result tests.
- Modify only the minimal capability/protocol adapter files found by symbol tracing.

**Interfaces:**
- `trust.list` returns safe durable trust metadata.
- `workspace.trust({ rootPath, profile? })` canonicalizes and inspects locally, derives persistent identity, and creates or updates the trust record.
- Calling `workspace.trust` again for the same canonical root with another profile updates `profileCeiling` while preserving one trust identity record.
- `workspace.untrust` removes trust and revokes active workspace authority using existing lifecycle mechanisms where supported.

- [ ] **Step 1: Write RED trust-store tests for create/update semantics**

Cover one canonical record per root, profile update on re-trust, persistent identity validation, atomic persistence, invalid profile rejection, and fail-closed unsupported/corrupt state.

- [ ] **Step 2: Run trust package tests and verify RED**

Run: `pnpm --filter @kodegpt/trust test`
Expected: new assertions fail while existing tests remain green.

- [ ] **Step 3: Implement only the missing trust-store behavior**

Reuse `TrustedWorkspaceEntry`, `profileCeiling`, and schema version 1 if current representation already supports the required behavior. Do not introduce grants or a second policy database.

- [ ] **Step 4: Run trust tests to GREEN**

Run: `pnpm --filter @kodegpt/trust test`
Expected: PASS.

- [ ] **Step 5: Write RED workspace-manager tests**

Cover trust-by-path canonicalization, local persistent identity derivation, nonexistent/non-directory rejection, profile update by re-trust, and untrust behavior for closed and already-open workspaces.

Include a regression proving that merely reading/parsing/loading repository content does not call trust mutation code.

- [ ] **Step 6: Run core tests and verify RED**

Run: `pnpm --filter @kodegpt/core test`
Expected: missing manager methods/behavior fail deterministically.

- [ ] **Step 7: Implement manager trust/list/untrust operations**

Reuse current root inspection, trust resolver/store, workspace registry, close/cancel lifecycle, and audit paths. Do not add a separate prompt-injection subsystem or new supervisor.

- [ ] **Step 8: Run core tests to GREEN**

Run: `pnpm --filter @kodegpt/core test`
Expected: PASS.

- [ ] **Step 9: Write RED MCP tests for exactly three public trust semantics**

Assert `trust.list`, `workspace.trust`, and `workspace.untrust` schemas, annotations, structured results, and safe error behavior. No caller-supplied device/inode fields. No `policy.*`, `profile.set`, or grant tools.

- [ ] **Step 10: Implement MCP/context wiring**

Expose only the three intended semantics. Return safe trust metadata and effective profile state without exposing trust-store host paths.

- [ ] **Step 11: Run MCP + core + trust suites to GREEN**

Expected: PASS.

- [ ] **Step 12: Add audit assertions for trust/profile/untrust mutations**

Use existing audit conventions and verify operation, target trust/workspace identity, previous/resulting profile where relevant, outcome, and timestamp/provenance without conversation-body logging.

- [ ] **Step 13: Commit Task 1**

Commit message: `feat(trust): manage workspace trust from chatgpt`

---

### Task 2: Trusted Runtime Ergonomics

**Files:**
- Inspect first: `packages/profiles/src/presets.ts`, verification/process capability code, executable resolution, sandbox/runtime policy.
- Modify only the layer proven defective by RED reproduction.
- Test the same layer plus profile regression tests.

**Interfaces:**
- Existing `trusted` profile remains the high-agency profile.
- `observe` and `develop` stay unchanged unless separate defect evidence appears.
- Normal discovered verification recipes should be executable in `trusted` when the underlying executable is genuinely available.

- [ ] **Step 1: Reproduce the current trusted verification/process behavior**

Create/use a trusted fixture and inspect `verify.list` plus the relevant process execution path for representative `pnpm` and Cargo recipes.

Expected: either reproduce a deterministic blocker or prove the current trusted path already works.

- [ ] **Step 2: Identify the actual blocking layer before changing code**

Distinguish among profile resolution, executable allowlist, executable discovery/PATH, installed runtime environment, sandbox visibility, or verification adapter logic.

Do not modify `presets.ts` merely because it is nearby; current evidence already shows trusted includes common Node/Rust package tooling.

- [ ] **Step 3: Write one focused RED test at the proven defective layer**

The test must reproduce the exact blocker from Step 1 and keep observe/develop behavior explicit.

- [ ] **Step 4: Implement the narrowest fix**

Change only the responsible layer. Do not introduce wildcard executable authority or broaden `develop` as a side effect.

- [ ] **Step 5: Run focused tests to GREEN**

Expected: trusted verification/process path succeeds where the executable is available; observe/develop regressions remain green.

- [ ] **Step 6: Run package-level verification/process/profile regression suites**

Expected: PASS.

- [ ] **Step 7: Commit Task 2 only if code changed**

Commit message: `fix(runtime): unblock trusted development workflows`

If reproduction proves no defect exists, record evidence and do not create a no-op code commit.

---

### Task 3: Local Git Workflow

**Files:**
- Reuse/extend the existing hardened Git capability/runtime path discovered from `git.status`, `git.changes`, and `git.log`.
- Modify: TypeScript/Rust protocol contracts only where needed.
- Modify: focused capability adapter files.
- Modify: `packages/mcp-server/src/tool-context.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Test: protocol parity, Rust runtime, capability, MCP, security, and audit suites.

**Interfaces:**
- Typed operations for stage/add, commit, branch create, branch switch, and safe branch delete.
- READY workspace + effective trusted authority required.
- No public raw Git argv or shell string.

- [ ] **Step 1: Trace and document the existing hardened Git execution chain**

Use symbol/reference search from current Git tools to the Rust fixed-command executor. Reuse it rather than spawning Git independently in TypeScript.

- [ ] **Step 2: Write RED protocol tests for local mutation variants**

Define bounded typed inputs for stage paths, commit message, branch name, switch target, and safe delete. Reject unknown fields and malformed names according to existing protocol conventions.

- [ ] **Step 3: Implement TS/Rust protocol variants and restore parity**

Run targeted protocol tests until GREEN.

- [ ] **Step 4: Write RED Rust runtime tests with temporary repositories**

Cover stage, commit, branch create/switch/delete, workspace scoping, policy denial outside trusted, deterministic errors, bounded output, and no shell invocation.

- [ ] **Step 5: Implement fixed-argv local Git mutations**

Construct argv internally from typed requests. Do not add hard reset or rebase.

- [ ] **Step 6: Run targeted Rust Git/security tests to GREEN**

Expected: PASS.

- [ ] **Step 7: Write RED TypeScript capability + MCP tests**

Assert trusted requirement, schemas, annotations, structured results, and safe public errors.

- [ ] **Step 8: Implement capability/MCP wiring through the hardened runtime**

Do not duplicate Git execution logic in the MCP layer.

- [ ] **Step 9: Add durable audit tests for local Git mutation**

Verify operation class, workspace, bounded targets, outcome, and no secret leakage.

- [ ] **Step 10: Run affected TS/MCP/security suites to GREEN**

Expected: PASS.

- [ ] **Step 11: Commit Task 3**

Commit message: `feat(git): add trusted local workflow`

---

### Task 4: Remote Git Workflow

**Files:**
- Extend the same hardened Git runtime/capability path from Task 3.
- Modify protocol, runtime, capability, MCP, audit, and integration tests only for fetch/pull/push.

**Interfaces:**
- Typed `fetch`, `pull`, and `push` semantics for trusted workspaces.
- Network behavior follows trusted profile authority.
- No force push, arbitrary rebase, raw Git argv, or shell.

- [x] **Step 1: Write RED deterministic local-remote tests**

Use temporary repositories and local bare remotes to prove ref updates, pull/integration semantics, and push correctness without relying on external network availability.

- [x] **Step 2: Add separate RED policy/network gating tests**

Prove non-trusted/non-network-authorized contexts cannot use remote Git, while trusted authority reaches the remote operation path.

- [x] **Step 3: Add/implement bounded protocol variants for fetch/pull/push**

Use explicit remote/ref inputs with safe defaults and closed operation semantics.

- [x] **Step 4: Implement fixed-argv runtime operations**

`fetch` may update refs but must not modify the working tree. `pull` behavior must be explicit rather than an opaque arbitrary integration command. `push` must not expose force semantics in this phase.

- [x] **Step 5: Run Rust/integration tests to GREEN**

Expected: PASS.

- [x] **Step 6: Write and implement TypeScript capability + MCP schemas**

Route through the runtime path from Tasks 3–4 and require trusted authority.

- [x] **Step 7: Add audit tests for fetch/pull/push**

Record bounded remote/ref metadata and outcome without credentials or transport secrets.

- [x] **Step 8: Run affected MCP/security/integration suites to GREEN**

Expected: PASS.

- [ ] **Step 9: Commit Task 4**

Commit message: `feat(git): add trusted remote workflow`

---

### Task 5: Surface & Release Closure

**Files:**
- Modify capability inventory/surface version source used by `system.capabilities`.
- Modify MCP inventory/schema acceptance tests.
- Modify security/integration tests as necessary for final cross-capability regression.
- Update implementation tracker/release/readiness/verification docs only after exact-head evidence exists.

**Interfaces:**
- Produces the next explicit MCP surface version, exact candidate verification, immutable installed-service provenance, and fresh ChatGPT acceptance.

- [ ] **Step 1: Write RED exact surface inventory tests**

Assert the three trust semantics plus the new local/remote Git tools. Assert raw shell, raw Git argv, force push, and provider tools remain absent.

- [ ] **Step 2: Bump semantic MCP surface according to existing conventions**

Update `system.capabilities` and all exact inventory/schema tests. Do not leave the public surface at `0.4`.

- [ ] **Step 3: Run focused cross-capability security regressions**

Include trust identity, filesystem boundary, process isolation, verification, Git current-state/history, new Git mutation, skills, audit durability, service provenance, and package provenance.

- [ ] **Step 4: Run the complete CI-equivalent verification matrix**

Run repository-defined TypeScript typecheck/tests/build, Cargo formatting/tests, protocol parity, integration/security/isolation/acceptance, forbidden-pattern scan, and clean-install/package-smoke gates as defined by current CI.

Expected: all PASS on the exact candidate head.

- [ ] **Step 5: Stage/install the exact candidate through the existing immutable service lifecycle**

Do not run live service from a feature worktree. Verify Node/Rust provenance under the immutable release root before and after explicit cutover.

- [ ] **Step 6: Perform fresh ChatGPT/KodeGPT schema acceptance**

Verify `system.health`, `system.capabilities`, new surface version, trust schemas, and local/remote Git mutation schemas are visible after a fresh host/schema refresh.

- [ ] **Step 7: Perform bounded end-to-end personal workflow acceptance**

Using a disposable repository: list trusts; trust as `trusted`; open; edit; run an available project verification/toolchain action; stage/commit/branch; fetch/pull/push against a controlled remote; inspect Git state; re-trust with a lower profile; untrust; prove future open is denied.

- [ ] **Step 8: Verify audit and live provenance**

Confirm trust/profile/Git mutations are durably audited without credential leakage and live Node/Rust/zrok provenance remains under the immutable installed release.

- [ ] **Step 9: Update tracker and release/readiness documentation from evidence**

Record exact head, surface version, verification results, package/release identity, host acceptance, and remaining limitations. Provider interoperability remains NOT STARTED.

- [ ] **Step 10: Final diff review and merge-readiness gate**

Do not merge until exact-head CI and fresh-host acceptance are green. Cleanup/canonical reconciliation remains post-merge work according to existing repository lifecycle.

- [ ] **Step 11: Commit final evidence/docs**

Commit message: `docs: close personal trusted authority readiness`

---

## Plan Self-Review

- The plan has one simple user model: trust, untrust, list trust; profile changes happen by re-trust.
- No granular grants or separate Personal Admin Mode are introduced.
- Trusted runtime work starts with reproduction and may result in no code change if the preset/runtime already behaves correctly.
- Local Git and remote Git are separate review boundaries.
- Prompt-injection handling is expressed as a code-path invariant, not a new detection subsystem.
- Package/service/host work is concentrated in one closure task rather than mixed into feature tasks.
- Provider interoperability and destructive Git history rewriting remain explicitly out of scope.
