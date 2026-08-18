# Reliable Process Execution — Phase 2 Candidate Readiness

Status date: 2026-08-18  
Branch: `feat/reliable-process-execution`  
Baseline: `a7730f692ba6877a87dcb697c8bd6bf6be93da7a`  
Implementation commit: `b84e26b7e0b76b51b2dbd09f395593800afb3934`  
Status: PASS — Phase 2 behavior is implemented, verified, reviewed, and live-dogfooded. Hard stop after Phase 2 closure.

## Scope and root cause

Phase 1 live evidence exposed one concrete process-execution gap on linked-worktree records: direct `process.run(node --version)` could fail with `PROCESS_SANDBOX_UNAVAILABLE`, and `verify.run` could collapse because generic trusted process launch treated linked-worktree Git metadata admission as a mandatory prerequisite.

The Phase 2 fix is deliberately narrow. Generic process execution still requests the same trusted Git metadata access when available, but rejected/unavailable linked-worktree metadata may now be omitted for that generic process launch. No unvalidated path is mounted. Valid metadata is still admitted with the existing access mode. Hardened typed Git keeps the default mandatory metadata requirement and therefore remains fail-closed when the metadata pointer is invalid or stale.

No public tool, protocol schema, MCP surface, provider capability, network authority, executable authority, workspace authority, generic external-mount framework, retry/orchestration framework, or autonomous-agent behavior was added. Runtime/protocol/public surface remain `0.1 / 2026-07-28 / 0.10`.

## TDD and boundary behavior

The first RED tests reproduced the defect with a stale linked-worktree `.git` pointer. Before implementation, both a trusted non-Git Python process and a trusted shell request failed before child launch with `linked worktree Git metadata rejected: linked worktree gitdir is invalid`.

The GREEN implementation adds one internal `SandboxLaunchSpec.require_git_metadata` control whose default is `true`. Generic process execution sets it to `false`; all existing callers keep the strict default. The sandbox then follows three closed cases:

- valid requested Git metadata: admit and mount it exactly as before;
- rejected metadata for generic process launch: omit external Git metadata and continue child launch;
- rejected metadata for a caller that requires Git metadata: return the existing sandbox-unavailable failure.

Regression coverage proves all three boundaries: trusted non-Git process execution survives rejected metadata, a trusted shell launches while nested Git fails ordinarily because metadata was omitted, hardened typed Git still fails closed, and the optional generic-process mode still mounts valid linked-worktree metadata successfully.

## Fresh verification

Final source verification on the reviewed implementation state is green:

- TypeScript/Vitest: `681/681` package/app project tests plus `139/139` root tests = `820/820` PASS with clean exit codes.
- Root `pnpm run typecheck`: PASS.
- Root `pnpm run build`: PASS.
- `cargo test --workspace -- --test-threads=1`: PASS across the complete Rust workspace after final coverage hardening.
- `cargo check --workspace`: PASS.
- `cargo fmt --all -- --check`: PASS.
- `pnpm run test:protocol`: `14/14` PASS.
- `pnpm run test:security`: `65/65` PASS.
- `pnpm run test:acceptance`: `6/6` PASS.
- `pnpm run verify:forbidden`: PASS.
- Clean-provenance `pnpm run verify:package`: PASS.

A monolithic CodexPro `pnpm test` run reached `118/118` files and `820/820` tests passing, but its wrapper terminated after its execution ceiling before returning a clean outer exit status. The deterministic project/root split above covers the same 820 tests with exit code 0 and is the acceptance evidence.

## Review

CodexPro complete-diff review found the implementation localized to three Rust files and no new authority surface. One review hardening was added before final verification: the existing valid linked-worktree sandbox test now runs the optional-metadata mode and proves that valid Git metadata is still mounted rather than silently discarded.

KodeGPT repository inspection and normal Git/process capabilities were used throughout the feature worktree. Generated `.pnpm-store` setup data was explicitly removed before commit; the implementation commit was clean and contains only the three intended files.

## Immutable candidate and live dogfood

The exact clean implementation commit rebuilt the release runtime, staged the runtime package, rebuilt the CLI, and passed package smoke. Existing service status before staging was healthy on active Phase 1 release `rel_9b97fa11d7d1ef526557fe9b520c1b0a` with runtime/protocol/surface `0.1 / 2026-07-28 / 0.10`.

`service install --name public:kodegpt-dev --port 43121` staged immutable candidate `rel_0159cd3d4724220fcde20a247577036d` while leaving `rel_9b97fa11d7d1ef526557fe9b520c1b0a` active. An explicit `service restart` then promoted `rel_0159cd3d4724220fcde20a247577036d`; the former Phase 1 release became rollback. Post-cutover `system.health` is healthy and `system.capabilities` remains `0.1 / 2026-07-28 / 0.10`.

Live acceptance used a disposable trusted workspace with a deliberately stale absolute `.git` pointer plus a minimal pnpm verification recipe. On that same workspace:

- typed `git.status` returned `GIT_INSPECTION_FAILED`;
- `process.run(node --version)` completed with exit code `0` and `v24.17.0`;
- `verify.run(package:test)` completed with exit code `0` and `verify-ok`;
- trusted `bash -lc 'git status --short'` launched successfully, then Git itself exited `128` with `fatal: not a git repository...` because rejected metadata was not mounted.

This is the required behavioral separation. Generic process and verification execution no longer collapse merely because optional external Git metadata is rejected, while typed Git remains strict and nested Git receives no hidden authority. The disposable workspace was then closed, untrusted, and removed.

## Stop condition

Phase 2 is ready for PR/CI/merge and merged-main release reconciliation. Do not open another roadmap phase or broaden process/Git authority as part of this closure. After Phase 2 is merged, deployed, smoke-tested, and cleaned up, hard stop.
