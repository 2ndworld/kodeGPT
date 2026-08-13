# KodeGPT Post-Merge Host Acceptance and Release Readiness

> **Historical evidence — superseded for current readiness.** This document records the 2026-08-12 post-PR-#3 acceptance state at semantic surface `0.2`, including the then-frozen 21-tool ChatGPT snapshot. It must not be used as the current v0.1/surface-`0.3` readiness truth. The current authority is source/tests, `docs/implementation/v0.1-execution-tracker.md`, `docs/release/v0.1-checklist.md`, `docs/compatibility/chatgpt.md`, and `docs/verification/host-acceptance.md`.

Status date: 2026-08-12 (historical snapshot).
Superseded for current readiness: 2026-08-13.

## Verdict

**NOT READY** for a final v0.1 tag/publish.

The merged implementation at `7050c9f9a6b76a8d62c6c5129aa282c11336662a` is deterministically healthy and substantial real ChatGPT host behavior was observed, including authenticated health, local-only workspace trust, real file read/write, Git status/diff, audit health, fail-closed workspace identity replacement, and clean shutdown/restart.

Two release-claim blockers remain:

1. the ChatGPT app/connector used for this acceptance run still exposed its previously approved/frozen 21-tool snapshot and did not surface the newly merged `skill.list`, `skill.inspect`, or `skill.load` tools, so actual ChatGPT-host skill interoperability rows cannot be marked PASS;
2. the existing release checklist's passive Pranikah isolation snapshot/compare was intentionally not run because this handoff explicitly prohibits touching Pranikah Labs.

The correct status is therefore: deterministic candidate healthy, host read/write observed, hybrid-skill backend acceptance green, final host compatibility/release tag blocked on the remaining external/scope gates.

## Baseline

- Base branch verified before work: `main`.
- Starting local `main`: `7050c9f9a6b76a8d62c6c5129aa282c11336662a`.
- `origin/main`: exact same SHA after `git fetch --prune`.
- Merge commit: `7050c9f Merge pull request #3 from 2ndworld/feat/hybrid-skill-interoperability`.
- Hybrid feature parent observed in history: `3b81e4a feat: ship hybrid agent skill interoperability`.
- Starting `main` working tree: clean.
- Readiness/docs work performed in isolated branch `chore/post-merge-host-readiness`, not directly on `main`.
- Exact ending documentation-branch SHA is intentionally reported by the external handoff/final Git state rather than embedded self-referentially in this commit.

## Candidate/build identity

The globally installed `kodegpt` command on this machine was older than the merged candidate: its help output did not include `skill source` or `skill pin/unpin`, while the bundle built directly from `main@7050c9f` did.

All real-host acceptance in this run therefore used the repository-built candidate corresponding to `7050c9f`, not the stale global CLI bundle.

This is installation drift, not evidence of a repository regression. Reinstalling/updating the global command is an operational follow-up and was not required to alter the release candidate.

## Host architecture actually exercised

```text
ChatGPT Web
  → public HTTPS zrok endpoint
  → KodeGPT MCP over /mcp
  → TypeScript tool/application layer
  → Rust runtime / policy / filesystem authority
  → locally trusted disposable workspace
```

Managed exposure used the production `kodegpt expose zrok --name <namespace:name>` path against an existing reserved zrok v2 name. KodeGPT remained loopback-only on `127.0.0.1:43121`; zrok provided reachability only.

Connection path classification:

```text
zrok-public-https-query-credential
```

No connector credential, query-bearing Server URL, zrok account credential, or other secret is recorded here.

## Connection/auth evidence

- Before startup, no KodeGPT/zrok process existed and ChatGPT KodeGPT calls failed at transport level.
- Starting the exact repository-built candidate restored `system.health` and `system.capabilities` through the actual ChatGPT connector.
- `system.health` reported `ok=true`, `auditHealthy=true`, filesystem boundary available, and production test methods disabled.
- `system.capabilities` reported runtime `0.1`, MCP protocol `2026-07-28`, and MCP semantic surface `0.2`.
- A syntactically valid unauthenticated MCP POST returned HTTP `401` on both loopback and the public zrok `/mcp` endpoint.
- A bare GET returned `405` and was not counted as authentication evidence.

## Real ChatGPT host acceptance matrix

| Scenario | Status | Evidence |
|---|---|---|
| Public reachability | PASS | Public zrok `/mcp` answered; unauthenticated valid MCP POST reached KodeGPT and returned `401`. |
| Unauthorized rejection | PASS | Both loopback and public valid MCP POST without credential returned `401`. |
| Authenticated health/capabilities | PASS | Actual ChatGPT calls returned healthy runtime, boundary available, protocol `2026-07-28`, surface `0.2`. |
| Workspace trust denial | PASS | Actual `workspace.open` rejected a disposable untrusted repository. |
| Local-only trust admission | PASS | Trust was established only with local CLI; no MCP trust-mutation tool was exposed. |
| File read | PASS | Actual `file.read` returned `before-kodegpt-host-test`. |
| File write | PASS | Actual `file.write` changed the fixture to `after-kodegpt-host-test`, then `file.read` verified it. |
| `file.edit` host behavior | BLOCKED | ChatGPT safety layer blocked this write call before KodeGPT execution; `file.write` on the same disposable workspace succeeded. |
| Git status | PASS | Actual KodeGPT Git reported the modified file and created untracked fixture. |
| Git diff | PASS | Actual KodeGPT Git returned the exact before → after unified diff. |
| Audit behavior | PASS | `system.health` remained audit-healthy and exposed recent decision/outcome events for exercised operations. |
| Workspace identity replacement | PASS | Replacing a trusted path with a different directory caused actual host `workspace.open` to fail closed with trusted identity changed. |
| `skill.list` | BLOCKED | Current ChatGPT app snapshot exposed only 21 older tools and did not discover the merged skill tools. |
| `skill.inspect` | BLOCKED | Same frozen tool-snapshot blocker. |
| `skill.load` | BLOCKED | Same frozen tool-snapshot blocker. |
| Script non-execution through actual ChatGPT skill load | BLOCKED | `skill.load` was unavailable to this host snapshot; deterministic production-MCP fixture is PASS separately below. |
| Live skill update through actual ChatGPT | BLOCKED | `skill.inspect/load` unavailable to host snapshot. |
| Pin reproducibility through actual ChatGPT | BLOCKED | `skill.load` unavailable to host snapshot; pin mutation correctly remains local-only. |
| Live-source unavailable pin fallback through actual ChatGPT | BLOCKED | `skill.load` unavailable to host snapshot. |
| Skill source identity replacement through actual ChatGPT | BLOCKED | Skill tool snapshot unavailable; deterministic Rust-backed fixture is PASS separately below. |
| MCP source/pin/trust mutation denial | PASS | Actual host inventory had none of these mutation tools; deterministic final skill inventory also contains only three read-only skill tools. |
| Provider execution surface absent | PASS | Actual host inventory contained no Codex/Claude/provider execution tool; deterministic forbidden/security gates remained green. |
| Provider-bound classification through actual ChatGPT | BLOCKED | `skill.inspect` unavailable in the current host snapshot. |
| Clean shutdown | PASS | SIGTERM to KodeGPT supervisor removed both KodeGPT and supervised zrok process; ChatGPT health then failed as expected. |
| Restart | PASS | Restarting the same candidate restored healthy actual ChatGPT `system.health`. |
| Final cleanup | PASS | Disposable trust/fixture removed; final KodeGPT/zrok acceptance processes stopped with no orphan observed. |

## Deterministic hybrid-skill evidence

Because blocked host rows must not be converted to PASS from local tests, the backend evidence is recorded separately.

Focused production-MCP integration:

```text
tests/integration/skill-interoperability.test.ts
3/3 PASS
```

It proves, through the production MCP server and real Rust source authority:

- live `skill.list` discovery;
- `skill.inspect` fingerprinting without state/source-root/source-capability leakage;
- bounded `skill.load` of instructions and UTF-8 resources;
- UTF-8 script returned as text without executing its side-effect marker;
- binary unsupported resource rejection;
- live mutation changes the current fingerprint;
- pinned fingerprint A retains immutable A content after live B mutation;
- pinned A remains loadable when the live source is deleted/unavailable;
- state/source overlap fails closed;
- source path filesystem-identity replacement fails with `SKILL_SOURCE_IDENTITY_CHANGED` even when a pin exists;
- escaping symlink resource rejection;
- Codex/subagent execution semantics classify `UNSUPPORTED` rather than launching a provider.

The compatibility unit suite separately covers explicit declared provider requirements as `PROVIDER_REQUIRED`.

## Deterministic verification

Final successful verification on the readiness branch:

| Gate | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS |
| `cargo fmt --all -- --check` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS |
| `pnpm test` final rerun | PASS — 72 files / 370 tests |
| `pnpm test:protocol` | PASS — 2 files / 10 tests |
| `pnpm test:integration` | PASS — 12 files / 31 tests |
| `pnpm test:security` | PASS — 11 files / 35 tests |
| `pnpm test:isolation` | PASS — 1 file / 3 tests |
| `pnpm test:acceptance` | PASS — 2 files / 4 tests |
| focused hybrid skill integration | PASS — 1 file / 3 tests |
| `pnpm verify:forbidden` | PASS — `forbidden-pattern scan ok` |
| `cargo test -p kodegpt-sandbox` | PASS — 7 tests, not skipped |
| `pnpm test:rust` (`cargo test --workspace`) | PASS — 116 Rust tests |
| direct `cargo test --workspace` final run | PASS — 116 Rust tests |
| `pnpm verify:package` | PASS — package smoke/checksum verification |
| `pnpm bench:baseline` | PASS — 5 warmups / 30 measured, record-only |
| `git diff --check` | PASS |

Rust count breakdown on the final workspace run: policy 3, protocol contract 10, runtime 44, sandbox 7, workspace-io 46, skill-source integration 6 = **116**.

### Timing-sensitive test observation

One intermediate full `pnpm test` run produced 369/370 PASS because the KernelClient concurrency test measured one `hello()` call at ~369 ms against its `<200 ms` responsiveness threshold.

No code involved in that test had changed. The same test then passed in a focused 5/5 run, the complete `@kodegpt/core` suite passed 17/17, the performance baseline measured `helloIpc` around sub-millisecond median/p95 values, and the final full suite passed 370/370 without changing the assertion.

The event is therefore recorded as a non-reproducible host scheduling/load spike, not patched as a product defect and not hidden by weakening the threshold.

## Gate intentionally not run

The repository release checklist includes a passive Pranikah repository/listener snapshot before and after the complete final gate set. This handoff explicitly prohibits touching Pranikah Labs, so that snapshot/compare was **NOT RUN**.

The KodeGPT-owned `pnpm test:isolation` gate itself passed 3/3. The omitted cross-repository snapshot remains a release-tag blocker under the current checklist unless the release policy is explicitly changed in a separate reviewed decision or that read-only guard is later run under an allowed scope.

## Defects and operational findings

### Repository code defects

No release-blocking KodeGPT code defect was reproduced during this run, so no source-code fix or security-contract relaxation was made.

### Operational/host findings

1. **Service initially offline.** Root cause of initial ChatGPT transport `ExceptionGroup`: no KodeGPT or zrok process was running. Starting the exact candidate restored health; shutdown/restart acceptance confirmed this lifecycle.
2. **Global CLI install drift.** The globally installed command predates Hybrid Skill Interoperability, while the repository-built candidate contains the merged local skill CLI surface. Acceptance deliberately used the exact candidate build.
3. **Frozen ChatGPT tool snapshot.** The current ChatGPT app retained the older 21-tool inventory despite the live server reporting semantic surface `0.2`. This blocks actual host `skill.*` evidence until actions are refreshed/rescanned/re-approved as required by the host.
4. **Write-tool host policy difference.** ChatGPT blocked `file.edit` before KodeGPT execution while permitting `file.write` on the same disposable trusted workspace. This is recorded as host behavior; KodeGPT's write boundary itself was proven with `file.write`.
5. **One non-reproducible timing spike.** See verification note above; final gates are green without weakening the test.

## Dogfood capability-gap report

| Capability / Skill Pattern | Native | Partial | Provider Required | Unsupported | Missing primitive / decision |
|---|---:|---:|---:|---:|---|
| Generic semantic/refactoring Markdown workflow | Yes | No | No | No | No new authority; improve skill-to-capability guidance. |
| Generic YAGNI/engineering-policy skill | Yes | No | No | No | No new primitive; GPT reasoning plus current repo/file/search/verify tools suffice. |
| Git/file/search/verification workflow | Yes | No | No | No | Already covered by `workspace.inspect`, `context.build`, `code.search`, `file.*`, `git.*`, `verify.*`. |
| GitHub Actions remediation using GitHub app + `gh`/Python helper | No | Yes | No | No | Bounded structured remote-CI inspection/integration if repeated dogfood proves sufficient demand; do not add generic shell. |
| Explicit declared external provider dependency | No | No | Yes | No | External provider semantic dependency remains advisory; no provider invocation in this phase. |
| `codex exec` / provider-agent / subagent-session workflow | No | No | No | Yes | Intentionally unsupported; do not implement `codex.exec`, provider agent proxy, or subagent session primitive. |

### Highest-leverage finding

The most important result is what **does not** need to be built next. KodeGPT already has the native filesystem, Git, search, inspect, context, verification, structured patch, and policy-bound process primitives previously suspected as gaps.

The next leverage comes from helping GPT map skill semantics to those existing primitives, and from separately evaluating bounded remote-system inspection for workflows that genuinely depend on external CI/service state.

## Recommended next phase

Canonical design:

`docs/superpowers/specs/2026-08-12-kodegpt-native-skill-execution-orchestration-design.md`

Implementation plan:

`docs/superpowers/plans/2026-08-12-kodegpt-native-skill-execution-orchestration.md`

The proposed phase keeps the public skill inventory at exactly three read-only tools and extends `skill.inspect` with deterministic advisory capability guidance. GPT Web remains the reasoning/orchestration actor; it explicitly calls existing native tools, which still pass through normal workspace trust, policy, Rust authority, sandbox, and audit enforcement.

A bounded remote-CI inspection adapter is deliberately deferred to a separate future design and should be pursued only if subsequent dogfood shows GitHub/CI-dependent `PARTIAL` skills are frequent enough to justify a new integration boundary.

## Required actions before final release claim

1. Refresh/rescan/re-approve the KodeGPT ChatGPT app actions so the host actually discovers `skill.list`, `skill.inspect`, and `skill.load` from the merged server surface.
2. Repeat the actual ChatGPT skill rows in `docs/verification/host-acceptance.md`, including script non-execution, live update, pin reproducibility, unavailable-source pin fallback, source identity replacement, and provider-bound classification/non-execution.
3. Satisfy the existing Pranikah passive isolation compare under an explicitly allowed scope, or make a separate reviewed release-policy change; do not silently remove the gate.
4. Re-run the final release matrix for the exact commit intended to be tagged.
5. Do not create the v0.1 tag until all current tag-gate requirements are satisfied.
