# Bounded Read-Only Git History Intelligence — Candidate Readiness

Status date: 2026-08-14
Branch: `feat/bounded-git-history-intelligence`
Pre-documentation exact source candidate: `f51ac97f07f94e51749dc45c56cf171e3efe2b3f`
Baseline: `3e3e257500d8d35d887ab8a68d55439dbdae0c1a`
Historical tag: `v0.1^{}` = `b8eae12cea3be002a9a61d06cecfd34f86283eb4` (unchanged)
Status: implementation and complete local deterministic source-head verification PASS. Documentation-head verification, push/CI, staged installed-release cutover, bounded real ChatGPT host acceptance, final PR review/merge, and post-merge reconciliation remain pending.

## Scope

This phase adds four and only four structured, bounded, read-only Git-history capabilities for already-READY trusted workspaces:

```text
git.log
git.show
git.range
git.diffHistory
```

Existing `git.status`, `git.diff`, and `git.changes` remain separate and continue to use their existing semantics. This phase does not add `skill.run`, provider interoperability, service lifecycle over MCP, workspace trust mutation over MCP, generic shell authority, raw arbitrary Git execution, Git mutation, network Git, provider-agent execution, or desktop/computer use.

## Public version identity

The exact source candidate reports/locks:

```text
runtime = 0.1
protocol = 2026-07-28
surface = 0.4
```

Runtime/protocol identities remain unchanged from the baseline. The semantic MCP surface advances from `0.3` to `0.4` only because the four explicit read-only Git-history tools are additive public capabilities.

## Revision and path authority

Public callers cannot provide arbitrary Git argv, command strings, revision expressions, or host paths.

Revision input is a closed tagged structure:

- `head`;
- full lowercase object ID only (`40` or `64` hex characters); abbreviated OIDs are rejected;
- strict local branch-name subset;
- strict local tag-name subset.

Relative ancestry/reflog/range syntax such as `HEAD~3`, `HEAD^`, `HEAD@{1}`, `main..HEAD`, `main...HEAD`, and `:/regex` is not accepted as public revision input.

History paths are repository-relative UTF-8 values bounded to 4096 bytes. Absolute paths, traversal components, option/pathspec-magic prefixes, control bytes, empty components, `.` and `..` components are rejected. Runtime Git path-taking commands use fixed `--literal-pathspecs` and an explicit `--` separator.

## Fixed bounds and truncation semantics

Public/default bounds are fixed in source and cannot be increased by arbitrary command input:

- `git.log` default 20, hard maximum 100 commits;
- `git.range` default 20, hard maximum 100 returned commits;
- ancestry ahead/behind counts are capped at 10,000 with an `exact` flag;
- commit body cap: 16 KiB;
- changed-path public cap: 500 paths;
- patch default: 64 KiB;
- patch hard maximum: 256 KiB;
- serialized public history response cap: 512 KiB;
- production history command wall timeout: 5 seconds.

Stable truncation reasons are `COMMIT_LIMIT`, `MESSAGE_LIMIT`, `PATCH_LIMIT`, `PATH_LIMIT`, and `RESPONSE_LIMIT`. Where fixed non-optional metadata cannot fit safely within the public response ceiling, the capability fails closed with `OUTPUT_LIMIT_EXCEEDED` rather than returning malformed partial structure.

## Hardened execution boundary

Git history remains implemented through the existing Rust security authority and hardened Git runner. History operations use the trusted Git executable, retained workspace root FD, Bubblewrap read-only workspace access, network denial, helper/config hardening, lazy-fetch denial, bounded capture, and durable top-level audit decision/outcome records.

Repository-local or environment-controlled helper execution is disabled/neutralized for the history surface, including fsmonitor, external diff, textconv, filters, pager/editor prompting, and credential/helper paths covered by the hardened Git layer. Rename detection is disabled. Submodule traversal is ignored. Binary changes are represented as structured stat metadata; no `GIT binary patch` or raw binary payload is exposed.

## Stable public errors and leakage boundary

History-specific stable public errors include:

```text
WORKSPACE_NOT_READY
GIT_UNAVAILABLE
NOT_A_GIT_REPOSITORY
REVISION_INVALID
REVISION_NOT_FOUND
OBJECT_TYPE_UNSUPPORTED
PATH_INVALID
OUTPUT_LIMIT_EXCEEDED
PROCESS_TIMEOUT
GIT_READ_FAILED
```

Unknown internal failures are reduced to `CAPABILITY_INTERNAL`. Runtime/core/capability validation rejects malformed result shapes before they can become public MCP output. Raw stderr, host paths, private capability IDs, process-group/PID details, artifact internals, command lines, and raw environment/Git-dir authority are not part of the four public result contracts.

## Exact source-head deterministic verification

The complete Task 11 source-head gate sequence was rerun from the beginning on exact commit `f51ac97f07f94e51749dc45c56cf171e3efe2b3f` after the last integration-fixture reconciliation.

Observed results:

- `pnpm install --frozen-lockfile`: PASS;
- `cargo fmt --all -- --check`: PASS;
- `pnpm run typecheck`: PASS across all TypeScript workspace projects;
- `pnpm test`: PASS — 85 files / 454 tests;
- `cargo test -p kodegpt-sandbox`: PASS — 7/7;
- `pnpm test:rust` / `cargo test --workspace`: PASS — policy 3, protocol contract 11, runtime 65, sandbox 7, workspace-I/O 47 plus semantic/source suites and doc-tests;
- `pnpm test:protocol`: PASS — 12/12;
- `pnpm test:integration`: PASS — 33/33;
- `pnpm test:security`: PASS — 43/43;
- `pnpm test:isolation`: PASS — 3/3;
- `pnpm test:acceptance`: PASS — 5/5;
- `pnpm verify:forbidden`: PASS;
- `pnpm verify:package`: PASS; package smoke produced clean CLI/runtime artifacts and runtime checksum verification.

A targeted MCP surface verification also passed 22/22 and locks semantic surface `0.4` plus the four additive tool registrations/schemas. Security inventory continues to require the forbidden authority set to remain absent.

## TDD / defect-reconciliation evidence

Implementation was not replayed from the historical baseline. Work resumed from the existing bounded-history branch and used RED/GREEN cycles for the remaining tasks. During final exact-head verification, two integration defects were found rather than ignored:

1. the capability-to-core adapter boundary still typed public optional history inputs instead of normalized/defaulted inputs, while local service status fixtures/contracts still pinned semantic surface `0.3`;
2. one packaged service integration fixture and one service security fixture also remained pinned to `0.3`.

Those defects were fixed in `36d9cf6` and `f51ac97`, targeted tests were made green, and the complete deterministic gate sequence was then restarted on the new exact source head rather than reusing stale earlier results.

## Required public inventory

Present Git tools:

```text
git.status
git.diff
git.changes
git.log
git.show
git.range
git.diffHistory
```

Required absent authority remains:

```text
skill.run
provider.list
provider.tools
provider.invoke
service install/start/stop/restart/uninstall over MCP
workspace trust mutation over MCP
generic shell
raw arbitrary Git command
network Git
Git mutation
provider-agent execution
desktop/computer use
```

Provider interoperability is **NOT STARTED**.

## Remaining gates

The implementation/source candidate is locally verified, but the phase is not merged or deployed yet. The remaining sequence is intentionally unchanged:

1. commit this readiness/tracker evidence;
2. rerun the documentation-head gate subset so evidence and final local PR head are exact;
3. push the feature branch without force and require deterministic GitHub CI success on that exact head;
4. stage the exact candidate using the established package/service release flow without disrupting the currently active installed release;
5. perform explicit managed-service cutover only after CI is green and verify immutable installed-release Node/Rust/zrok provenance with runtime `0.1`, protocol `2026-07-28`, surface `0.4`;
6. run only the bounded phase-specific real ChatGPT host acceptance for the four history tools plus existing Git compatibility and forbidden inventory;
7. perform final branch diff/security review, normal PR merge, canonical-main reconciliation, installed-service verification, feature-worktree cleanup, and final baseline freeze.

Historical `v0.1` must remain untouched throughout this sequence.
