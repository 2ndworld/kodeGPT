# Bounded Read-Only Git History Intelligence — Candidate Readiness

Status date: 2026-08-14
Branch: `feat/bounded-git-history-intelligence`
Pre-documentation exact source candidate: `c41aabd5b4fa3078d9d3ba51e66704057f6b31d5`
Baseline: `3e3e257500d8d35d887ab8a68d55439dbdae0c1a`
Historical tag: `v0.1^{}` = `b8eae12cea3be002a9a61d06cecfd34f86283eb4` (unchanged)
Status: implementation and complete local deterministic source-head verification PASS after a real staged-upgrade compatibility defect was discovered and fixed before cutover. Documentation-head verification, push/CI of the corrected head, corrected installed-release staging/cutover, bounded real ChatGPT host acceptance, final PR review/merge, and post-merge reconciliation remain pending.

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

The complete Task 11 source-head gate sequence was rerun on exact corrected source commit `c41aabd5b4fa3078d9d3ba51e66704057f6b31d5`. This supersedes the earlier locally/CI-green `26c64ada3bc271641e85b92c5234daa26783081d` candidate because real pre-cutover staging exposed an upgrade-compatibility defect in its local service status reader.

Observed results:

- `pnpm install --frozen-lockfile`: PASS;
- `cargo fmt --all -- --check`: PASS;
- `pnpm run typecheck`: PASS across all TypeScript workspace projects;
- `pnpm test`: PASS — 85 files / 455 tests, including the new surface `0.3` -> `0.4` staged-upgrade compatibility regression;
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

Implementation was not replayed from the historical baseline. Work resumed from the existing bounded-history branch and used RED/GREEN cycles for the remaining tasks. During exact-head verification and real pre-cutover staging, three integration defects were found rather than ignored:

1. the capability-to-core adapter boundary still typed public optional history inputs instead of normalized/defaulted inputs, while local service status fixtures/contracts still pinned semantic surface `0.3`;
2. one packaged service integration fixture and one service security fixture also remained pinned to `0.3`;
3. after `26c64ad` passed local docs-head verification and GitHub CI run `31795974860`, the candidate CLI successfully staged `rel_4379e487d5b6bb6d90cd1ba4f64472c4` while active release `rel_fa7cf9e07de98ae6941da6c4e3f9a918` remained running at surface `0.3`, but candidate `service status --json` then failed because the `0.4` parser rejected the still-running `0.3` readiness file. Cutover was stopped before restart. A RED regression reproduced this upgrade boundary; `c41aabd` makes the reader/status snapshot accept `0.3 | 0.4` while preserving the observed value rather than rewriting it, so a new candidate can inspect the old active release safely while still writing `0.4` when the new runtime becomes active.

The first two defects were fixed in `36d9cf6` and `f51ac97`; the staging-discovered upgrade defect was fixed in `c41aabd`. Targeted tests were made green and the deterministic gate sequence was rerun on the corrected source head rather than reusing the earlier `26c64ad` CI result. The old staged release has not been activated; the live service remains on the previous active surface `0.3` baseline until corrected-head CI and explicit cutover both pass.

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

## Corrected-head CI, installed cutover, and live host evidence

The later exact cutover-evidence head `0383f2769f000e42b410a6362b26949f18de84d5` was pushed without force. GitHub Actions run `31798373407` completed SUCCESS on that exact head; the single `Deterministic v0.1 gates` job passed trusted Bubblewrap build, frozen install, rustfmt, typecheck, full TypeScript tests, sandbox probes, Rust workspace tests, protocol, integration, security, isolation, acceptance, forbidden-pattern scan, and clean-install package smoke.

A fresh exact-head package was then built, packed, and clean-installed outside the repository. Before staging, the corrected candidate CLI successfully read the still-running surface `0.3` active release status, directly confirming the `c41aabd` backward-compatible status-reader fix. Candidate `service install` staged `rel_d31389af6de91e2f2d4b8dc5ae051799` while active release `rel_fa7cf9e07de98ae6941da6c4e3f9a918` remained running/listener-ready at surface `0.3`. Explicit `service restart` then promoted `rel_d31389af6de91e2f2d4b8dc5ae051799` and retained `rel_fa7cf9e07de98ae6941da6c4e3f9a918` as rollback.

Post-cutover service status is:

```text
state = running
listenerReady = true
managedExposure = true
localPort = 43121
reservedName = public:kodegpt-dev
runtime = 0.1
protocol = 2026-07-28
surface = 0.4
activeRelease = rel_d31389af6de91e2f2d4b8dc5ae051799
rollbackRelease = rel_fa7cf9e07de98ae6941da6c4e3f9a918
```

Process provenance was verified directly from `/proc`: Node CLI argv and CWD resolve under `~/.local/share/kodegpt/service/releases/rel_d31389af6de91e2f2d4b8dc5ae051799`; the Rust runtime executable is under the same immutable release root; zrok2 is a direct child of the Node supervisor in the same process group/session, executable `/usr/bin/zrok2`, with `share public http://127.0.0.1:43121 --headless --force-local --backend-mode proxy -n public:kodegpt-dev`. No feature-worktree runtime path is present.

Actual ChatGPT connector calls after cutover proved `system.health.ok=true`, `auditHealthy=true`, `filesystemBoundaryAvailable=true`, `testMethods=false`, and `system.capabilities` = runtime `0.1`, protocol `2026-07-28`, surface `0.4`. Existing compatibility calls `workspace.open`, `git.status`, `git.diff`, and `git.changes` also PASS on the canonical trusted repo.

A fresh ChatGPT host snapshot on 2026-08-14 now exposes all four additive history actions and their structured schemas: `git.log`, `git.show`, `git.range`, and `git.diffHistory`. Live `system.health` remains healthy (`ok=true`, `auditHealthy=true`, `filesystemBoundaryAvailable=true`, `testMethods=false`) and `system.capabilities` remains runtime `0.1`, protocol `2026-07-28`, surface `0.4`.

Real-host bounded acceptance PASS on the canonical trusted repository. The already-open canonical workspace was reused after an expected `WORKSPACE_ROOT_OVERLAP` on a duplicate open attempt. `git.log` on `head` with `limit=3` resolved `3e3e257500d8d35d887ab8a68d55439dbdae0c1a`, returned three structured commits, and reported `truncated=true` with `COMMIT_LIMIT`. `git.show` on the full 40-hex `3e3e257500d8d35d887ab8a68d55439dbdae0c1a` with a 16 KiB patch bound returned bounded commit metadata/body/path/patch fields without truncation. `git.range` from tag `v0.1` to `head` with `limit=5` resolved base `b8eae12cea3be002a9a61d06cecfd34f86283eb4`, reported `isAncestor=true`, exact ahead/behind `108/0`, returned five commits, and reported `COMMIT_LIMIT`. `git.diffHistory` from `v0.1` to `head` with a 32 KiB patch bound returned a structured 167-file summary and reported `truncated=true` with `PATCH_LIMIT`. An abbreviated OID (`3e3e257`) was rejected at the host action-schema boundary because OID input accepts only full lowercase 40/64-hex values. Existing `git.status`, `git.diff`, and `git.changes` remained successful and clean. The fresh action inventory still contains no `skill.run`, provider actions, generic shell, raw arbitrary Git command, Git mutation, network Git, MCP service-lifecycle mutation, MCP workspace-trust mutation, provider-agent execution, or desktop/computer-use authority. The workspace was then closed normally.

## Remaining gates

1. commit this fresh-host evidence and rerun the required docs-head verification subset;
2. push the resulting exact evidence head without force and require GitHub CI success on that exact head;
3. perform final branch diff/security review and merge through the normal PR flow only if those final gates pass;
4. post-merge reconcile canonical `main`, close installed-service provenance against the merged baseline according to the established lifecycle policy, run bounded live smoke, clean the feature worktree/branch safely, audit stash state, and freeze the final phase baseline.

Historical `v0.1` must remain untouched throughout this sequence.
