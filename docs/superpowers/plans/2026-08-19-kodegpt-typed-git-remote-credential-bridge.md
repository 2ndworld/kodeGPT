# Typed Git Remote Credential Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make existing typed `git.fetch`, `git.pull`, and `git.push` consume already-admitted GitHub HTTPS credentials without changing the public MCP surface.

**Architecture:** Add a private credential source between native Git capability composition and the existing Rust remote-mutation RPC. Reuse the Provider Gateway registry and credential broker to acquire a GitHub token, then let Rust independently validate the configured remote target and inject URL-scoped ephemeral Git HTTP auth only for canonical GitHub HTTPS.

**Tech Stack:** TypeScript, Zod/Vitest, Rust/Serde, Bubblewrap, existing Provider Gateway, Git CLI.

**Spec:** `docs/superpowers/specs/2026-08-19-kodegpt-typed-git-remote-credential-bridge-design.md`

## Global Constraints

- Preserve `runtime 0.1 / protocol 2026-07-28 / surface 0.14 / 76 tools`.
- Do not add public `provider.*`, `credential.*`, or new Git tools.
- Do not mount host HOME or persist credentials.
- Keep `credential.helper=` disabled and `GIT_TERMINAL_PROMPT=0`.
- Credentials may be attached only after Rust validates canonical credential-free GitHub HTTPS.
- No automatic retry, force push, arbitrary refspec, arbitrary URL input, or provider-framework expansion.

---

### Task 1: Private provider credential selection

**Files:**
- Modify: `packages/capabilities/src/provider-gateway/production.ts`
- Modify: `packages/capabilities/src/provider-gateway/production.test.ts`

**Interfaces:**
- Produces: `ProviderGatewayRuntime.acquireCredentialForEnabledAdapter(adapterId: string): Promise<ProviderCredential | null>`.
- Behavior: zero enabled matching provider => `null`; exactly one => acquire through the existing broker and compiled manifest; multiple => `PROVIDER_STATE_INVALID`.

- [ ] **Step 1: Write failing runtime tests** proving the new method exists, returns `null` with no enabled provider, and fails closed on duplicate enabled adapter records.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/capabilities/src/provider-gateway/production.test.ts --no-file-parallelism` and verify RED is caused by the absent credential-selection method.
- [ ] **Step 3: Implement minimal selection** using the existing `ProviderRegistryStore`, `ProviderAdapterRegistry`, `DefaultProviderCredentialBroker`, and runtime lifetime abort signal; do not expose provider records or credentials through MCP.
- [ ] **Step 4: Re-run the focused test** and require PASS.
- [ ] **Step 5: Commit** `feat(provider): expose private admitted credential selection`.

### Task 2: Native Git capability credential forwarding

**Files:**
- Modify: `packages/capabilities/src/adapters.ts`
- Modify: `packages/capabilities/src/git-remote.ts`
- Modify: `packages/capabilities/src/git-remote.test.ts`
- Modify: `packages/capabilities/src/native-capability-service.ts`
- Modify: `packages/capabilities/src/test-support.ts`
- Modify: `apps/cli/src/commands/start.ts`

**Interfaces:**
- Produces: private `GitRemoteCredentialSource.acquire(operation): Promise<{kind:"github_token"; token:string} | null>`.
- Extends `GitRemoteMutationAdapter.fetch/pull/push` with an optional fourth private credential argument.
- `fetch`/`pull` select `github.read.v1`; `push` selects `github.write.v1`.

- [ ] **Step 1: Add failing tests** in `git-remote.test.ts` proving policy denial precedes credential acquisition, successful acquisition is forwarded to the mutation adapter, and credential acquisition errors are normalized to `GIT_REMOTE_UNAVAILABLE` without raw secret/error text.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/capabilities/src/git-remote.test.ts --no-file-parallelism` and require assertion RED on missing acquisition/forwarding.
- [ ] **Step 3: Implement the private source/forwarding** and production composition in `start.ts`; no public schema changes.
- [ ] **Step 4: Re-run focused capability tests** plus `pnpm run typecheck` and require PASS.
- [ ] **Step 5: Commit** `feat(git): bridge admitted GitHub credentials`.

### Task 3: Private Node-to-Rust credential contract

**Files:**
- Modify: `packages/core/src/workspace-manager.ts`
- Modify: `packages/core/src/workspace-manager.test.ts`
- Modify: `crates/protocol/src/types.rs`
- Modify: `crates/protocol/tests` only if an existing protocol fixture is a better fit
- Modify: `crates/runtime/src/dispatcher.rs`

**Interfaces:**
- Adds only to private runtime RPC `git.remote_mutation`: optional closed credential `{kind:"github_token", token:string}`.
- Public `GitRemoteInput` and `GitRemoteMutationResult` remain unchanged.

- [ ] **Step 1: Add failing core test** proving a private credential is serialized into the kernel RPC while the returned structured result contains no credential field.
- [ ] **Step 2: Add failing runtime/protocol JSON test** proving the new closed credential variant is accepted and malformed/unknown fields are rejected.
- [ ] **Step 3: Run focused core/protocol/runtime tests** and verify RED occurs because the private credential contract is absent.
- [ ] **Step 4: Implement minimal private RPC fields** and pass the parsed credential into `run_git_remote_mutation`; do not add audit metadata containing the token.
- [ ] **Step 5: Re-run focused tests** and require PASS.
- [ ] **Step 6: Commit** `feat(runtime): carry ephemeral Git credential`.

### Task 4: Rust GitHub target validation and auth injection

**Files:**
- Modify: `crates/runtime/src/git.rs`
- Test in: `crates/runtime/src/git.rs`

**Interfaces:**
- `run_git_remote_mutation(..., credential: Option<GitRemoteCredential>, ...)`.
- Private helpers validate token framing, resolve actual fetch/push URL, classify canonical GitHub HTTPS, reject repository-controlled transport overrides, generate fixed Basic auth, and materialize one bounded private Git config through Bubblewrap's read-only data channel without secret-bearing argv/environment.

- [ ] **Step 1: Add failing pure tests** for canonical GitHub HTTPS acceptance and rejection of userinfo/query/fragment/alternate host/port/scheme/extra path/control characters.
- [ ] **Step 2: Add failing tests** for token bounds and for a credentialed launch spec that contains scoped auth + redirect denial but not the token in Git argv/output metadata.
- [ ] **Step 3: Run** `cargo test -p kodegpt-runtime git -- --nocapture` (or the narrow exact test names) and verify RED on missing helpers/behavior.
- [ ] **Step 4: Implement target resolution** with hardened local Git using `remote get-url` / `remote get-url --push`; credentialed operations use the exact validated URL as the network target.
- [ ] **Step 5: Implement ephemeral auth config** using fixed `x-access-token`, `base64`, exact-URL HTTP auth, redirect denial, empty proxy, and verified system CA settings; retain prompt/helper disabling.
- [ ] **Step 6: Keep secret-bearing config out of both Git and Bubblewrap argv/environment** by adding one bounded private Git-config data channel: Bubblewrap receives the config over stdin and exposes it read-only only at `/run/kodegpt/git-auth.config` via `--ro-bind-data`; authenticated Git consumes it at command scope with fixed `-c include.path=...`.
- [ ] **Step 7: Before authenticated GitHub network execution, inspect effective repository/worktree config under network denial** and fail closed if any `http.*`, `url.*`, or remote proxy override could rewrite or weaken the authenticated transport.
- [ ] **Step 8: Update the existing local bare-remote regression** to prove anonymous file remotes remain unchanged even when a credential is available.
- [ ] **Step 9: Add redaction/regression tests** proving the credential is absent from Bubblewrap argv/debug output, Git argv, result previews, and public structured results; prove unsafe local transport config is rejected before network.
- [ ] **Step 10: Run focused sandbox/Rust tests** and require PASS.
- [ ] **Step 11: Commit the review-driven hardening** after the original authentication implementation; record the independent reviewer findings and their closure in readiness evidence.

### Task 5: Surface regression, docs, and release evidence

**Files:**
- Modify: `docs/architecture/README.md`
- Modify: `docs/implementation/v0.1-execution-tracker.md`
- Create: `docs/release/2026-08-19-typed-git-remote-credential-bridge-readiness.md`
- Test: existing MCP/security/protocol/integration suites

**Interfaces:**
- No new public interface. This task records only verified implementation and acceptance evidence.

- [ ] **Step 1: Run focused TypeScript tests** for provider production, Git remote capability, core workspace manager, MCP structured/public boundary.
- [ ] **Step 2: Run full TypeScript gates**: `pnpm run typecheck`, `pnpm run build`, and full deterministic `pnpm run test` as repository policy permits.
- [ ] **Step 3: Run Rust gates**: `cargo fmt --all -- --check`, `cargo check --workspace`, `cargo test --workspace` on the host acceptance boundary.
- [ ] **Step 4: Run repository gates**: `pnpm run verify:forbidden`, `pnpm run verify:package`, and `git diff --check`.
- [ ] **Step 5: Verify public surface regression** remains exactly `0.14` / 76 and no `provider.*`/`credential.*` tool exists.
- [ ] **Step 6: Review complete diff** for credential leakage, hidden authority expansion, retries, host HOME mounts, generic provider APIs, and unrelated refactors.
- [ ] **Step 7: Write readiness evidence** with exact test counts/head and only claims actually observed.
- [ ] **Step 8: Commit** `docs: record typed Git credential bridge readiness`.

### Task 6: Publish, CI, merge, and live dogfood

**Files:** none unless CI evidence justifies a source fix.

**Interfaces:** Uses existing typed Git/GitHub/CI/service lifecycle only.

- [ ] **Step 1: Push the feature branch** without force and create a PR through existing typed GitHub authority.
- [ ] **Step 2: Inspect exact-head CI**; if failed, use `ci.failure` evidence before any edit/rerun.
- [ ] **Step 3: Merge only after exact-head gates and review pass**, using the existing guarded PR merge authority.
- [ ] **Step 4: Reconcile canonical `main`, build/stage an immutable release, and cut over explicitly while retaining rollback.**
- [ ] **Step 5: Live-dogfood an authenticated typed HTTPS Git operation against the canonical GitHub repository or a disposable controlled repository, without exposing the credential.**
- [ ] **Step 6: Verify health, `0.14` / 76 tools, audit redaction, active/rollback release identity, then clean the feature worktree/branch safely.**
