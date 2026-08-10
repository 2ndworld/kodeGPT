# Task 15 Evidence — Hardened Read-Only Git Inspection

Date: 2026-08-10 Asia/Jakarta

## Status

DONE. Product implementation commit: `37431b92fcdf83f4cf3632edbbdbbe82d6ce85a8` (`feat(git): add read-only sandboxed git inspection`). This commit has parent `b7ed5ace0d3210f671d0d8e70073b81dbbc29e52`, the final Task 14 checkpoint, so the Task 15 product diff is a single clean commit.

## RED evidence and root-cause findings

The initial malicious-helper regression reproduced a real repository-controlled clean-filter execution path. The helper emitted `HELPER_EXECUTED`, exited 97, and Git failed with an external clean filter error. This proved that disabling fsmonitor, external diff, and textconv alone was insufficient.

The fix is generic, not fixture-specific: `.git/config` is read through the retained workspace root FD; repository `include`/`includeIf`, `core.worktree`, and `extensions.worktreeConfig` indirection fail closed; every discovered filter driver is overridden with empty `clean`, `smudge`, and `process` commands plus `required=false`.

During CI verification, the GitHub-hosted runner exposed `/usr/local/bin` as root-owned but mode `0777`. KodeGPT correctly rejected the executable chain as `UntrustedLocation`. Verification fixed only the ephemeral CI host fixture by restoring `/usr/local/bin` to root:root `0755` and installing trusted root-owned `bwrap`/`git`; the product trusted-executable policy was not weakened.

## Security contract covered

- Git always receives the retained READY workspace root FD through Bubblewrap with `WorkspaceAccess::ReadOnly`, regardless of effective writable workspace policy.
- Git executable resolution uses the existing trusted-executable identity/revalidation authority; production Git code contains no direct `Command::new` fallback.
- Network mode is deny.
- Git repository/worktree authority is pinned to `/workspace/.git` and `/workspace` using both environment and command-line arguments.
- Environment/config hardening includes `GIT_OPTIONAL_LOCKS=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `GIT_ATTR_NOSYSTEM=1`, fixed locale, `core.fsmonitor=false`, disabled hooks/global attributes/excludes/credential helper/external diff, `--no-ext-diff`, `--no-textconv`, and ignored submodules.
- Malicious fsmonitor, external diff, diff textconv, and clean-filter helpers are regression-tested and never execute.
- Repository/worktree fingerprint is unchanged by `git.status` and `git.diff` attempts.
- Git child is registered as private `ExecutionKind::Git` / `ex_...` and removed after completion.
- stdout/stderr chunks are written to the raw `ka_...` spool before bounded preview accumulation; previews are capped while raw-source truncation remains represented by spool metadata.
- Durable Git audit decision occurs before retained-root duplication/process launch; terminal success/failure outcomes are recorded without output contents.
- Public MCP tools are `git.status` and `git.diff`, accept only opaque `workspaceId`, and carry exact read-only annotations. Private capability IDs and PID/PGID identities are not exposed.
- TypeScript/Rust/schema runtime contracts include closed `git.status`/`git.diff` fixtures and parity checks.

## Verification evidence

Targeted Task 15 verification on the final product state passed:

- `pnpm typecheck` — PASS.
- `cargo test -p kodegpt-protocol` — PASS, 8/8 contract tests.
- `pnpm test:protocol` — PASS.
- `cargo test -p kodegpt-runtime git -- --nocapture` — PASS, including functional malicious-helper repository test.
- `pnpm exec vitest run tests/security/git-helper-isolation.test.ts` — PASS.
- `pnpm --filter @kodegpt/core test` — PASS.
- `pnpm --filter @kodegpt/mcp-server test` — PASS.
- MCP stdio + HTTP integration tests — PASS.
- `pnpm build` — PASS across all TypeScript workspaces.

Full repository verification passed after updating two pre-existing source-regression tests to follow the bit-for-bit extracted workspace authority at `workspace_dispatcher.rs` rather than assuming it remained physically in `dispatcher.rs`:

- `pnpm test` — PASS, 103/103 tests.
- `cargo test --workspace` — PASS with policy 3/3, protocol contract 8/8, runtime 23/23, sandbox 7/7, workspace-io 30/30, and no failures.

The temporary CI workflow and draft verification PR were removed/closed without merge after evidence was collected.

## Plan mapping

- 15.1 malicious repository helpers: PASS.
- 15.2 read-only retained-root-FD workspace bind: PASS.
- 15.3 hardened Git environment/config: PASS, with additional dynamic filter/worktree indirection hardening.
- 15.4 repository mutation fingerprint: PASS.
- 15.5 ExecutionRegistry + spool-before-preview: PASS.
- 15.6 read-only MCP annotations + audit decision/outcome: PASS.
- 15.7 targeted verification: PASS.
- 15.8 clean implementation commit: `37431b92fcdf83f4cf3632edbbdbbe82d6ce85a8`.

Known deviations: none requiring an amendment. Linked Git worktrees whose `.git` indirection points outside the admitted workspace intentionally fail closed rather than widening filesystem authority.
