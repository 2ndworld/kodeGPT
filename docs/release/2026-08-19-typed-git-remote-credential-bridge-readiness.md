# Typed Git Remote Credential Bridge — Readiness

Date: 2026-08-19

## Scope

This readiness record covers the narrow Phase 6 bridge for the existing typed `git.fetch`, `git.pull`, and `git.push` operations. It reuses the already-admitted GitHub Provider Gateway credential authority for canonical GitHub HTTPS remotes. It does not add a public MCP tool, generic provider/credential API, arbitrary Git URL/refspec authority, host HOME mount, credential persistence, retry loop, force push, or broader process/network authority.

Implementation source head verified before this readiness-only documentation commit:

`bf28c01af12c8206c8fc331f40578d6475667636`

Baseline:

`f90a7065181517db9002b6838690cebe17a62e7d`

Branch:

`feat/typed-git-credential-bridge`

## Implemented boundary

- `fetch` / `pull` request `github.read.v1`; `push` requests `github.write.v1` only after the existing trusted + write + unrestricted-network policy gate.
- Credential selection revalidates the admitted provider contract, inventory mode, compiled/helper implementation identity, and dynamic-inventory approval before invoking the credential broker.
- No matching enabled provider preserves anonymous typed Git behavior.
- The private Node-to-Rust request carries only the closed optional `github_token` variant. Rust, TypeScript runtime validation, and canonical JSON Schema now agree on that private request shape.
- Rust independently resolves the configured fetch/push target with network denied and attaches a credential only to canonical `https://github.com/<owner>/<repo>[.git]` targets.
- The authorization material is not placed in Git argv, Bubblewrap argv, environment, repository config, result metadata, or audit metadata. A bounded private Git config is copied from an inherited FD into a fixed read-only in-sandbox file and included only for the authenticated Git command.
- Authenticated transport sets the exact-URL authorization header, `followRedirects=false`, empty proxy, and `sslVerify=true`; CA discovery remains platform-native through Git/libcurl.
- Before attaching a credential, a network-denied probe rejects effective local `http.*`, `url.*`, or `remote.*.proxy` configuration so repository-controlled transport configuration cannot weaken the authenticated path.
- Non-GitHub/file remotes keep the existing anonymous path even when a GitHub credential source is available.

## Review-driven corrections

Independent Codex review was run in bounded commit-sized slices because a whole-range review exceeded the local 180-second command ceiling. The behavior-changing range was covered and every actionable finding was either closed by a later commit or reviewed clean:

- `ef17f81` review: P1 provider credential selection could bypass provider identity/reapproval checks. Closed by `081c836` (`fix(provider): revalidate credential admission`); independent review of `081c836` found no blocking issue.
- `a5576fb` review: P1 credential forwarding stopped at the capability layer in that intermediate commit. Closed by `627feb9`, which forwards the fourth private credential argument through `WorkspaceManager` and framed RPC.
- `627feb9` review: P1 runtime executor still ignored the credential in that intermediate commit; closed by `b796ba8` and subsequent transport hardening. The same review found P2 TypeScript/JSON runtime-contract drift; closed by `bf28c01` (`fix(protocol): align Git credential request schema`), whose independent review reported the private optional variant consistently represented and focused protocol/type checks passing.
- `b796ba8` review: two P1 findings — authorization material reached Bubblewrap `--setenv` argv, and repository-local HTTP config could weaken authenticated transport. Both closed by `5655d4a` (`fix(runtime): harden authenticated Git transport`).
- `5655d4a` review: P1 distro-specific CA bundle paths. Closed by `f1db0ad` (`fix(runtime): preserve platform Git CA discovery`). Independent review of `f1db0ad` reported no actionable regression.

No unresolved Critical/P1/P2 review finding remains in the verified source head.

## Fresh verification at `bf28c01`

Focused TypeScript boundary suite:

- provider production admission
- typed Git remote capability
- core workspace manager
- MCP surface lock
- CLI production startup composition
- runtime JSON Schema
- framing parity

Result: **74/74 PASS** across 7 files.

TypeScript/build gates:

- `pnpm run typecheck` — PASS
- `pnpm run build` — PASS
- package/app Vitest partition — **802 passed, 1 intentional skipped** across 96 files
- root integration/security/protocol/performance partition — **141/141 PASS** across 34 files
- aggregate deterministic Vitest evidence — **943 PASS, 1 intentional skip**

Rust gates:

- `cargo fmt --all -- --check` — PASS
- `cargo check --workspace` — PASS
- `cargo test --workspace` — PASS
- protocol contract — **17/17 PASS**
- runtime — **95 passed, 3 ignored**
- sandbox — **25 passed, 4 ignored**
- workspace I/O and supporting crates — PASS

Repository/release gates:

- `pnpm run verify:forbidden` — PASS
- `pnpm run verify:package` — PASS (`package smoke ok`)
- `git diff --check` — PASS
- working tree was clean after the source gates

A transient Remote-CI credential-runner failure observed inside an independent reviewer command was reproduced directly with `packages/capabilities/src/remote-ci/credential-provider.test.ts`; focused reproduction was **6/6 PASS**, and the fresh full package/app partition also passed that suite.

## Public-surface regression

`packages/mcp-server/src/server.test.ts` remains green and locks:

- runtime `0.1`
- protocol `2026-07-28`
- MCP surface `0.14`
- exactly **76** public tools
- exactly the existing seven `github.*` tools
- no `provider.*` public tool

Because the full tool list is equality-locked to the 76-name snapshot, no `credential.*` public tool is present either. Phase 6 changes only private composition/runtime protocol.

## Remaining release gates

This record does **not** claim PR, CI, merge, release cutover, or live authenticated Git dogfood yet. The remaining roadmap is:

1. push this feature branch without force and create a PR;
2. require exact-head CI and review success;
3. merge through the existing guarded GitHub authority;
4. reconcile canonical `main`, stage/cut over an immutable release while retaining rollback;
5. live-dogfood one authenticated typed Git HTTPS operation without credential disclosure;
6. verify service health, audit redaction, `0.14` / 76 tools, active/rollback identities, then clean the feature worktree safely.
