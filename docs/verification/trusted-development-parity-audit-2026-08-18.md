# Trusted Development Parity & Ergonomics Audit — 2026-08-18

Status: **P1 evidence audit complete; no P1 production expansion justified in this branch**

Baseline design: `docs/superpowers/specs/2026-08-17-kodegpt-trusted-development-parity-ergonomics-design.md`

Candidate branch: `fix/trusted-development-parity-ergonomics`

## P0 evidence carried into this audit

The candidate fixes the two proven environmental root causes without reimplementing Trusted Multi-Toolchain:

- unrestricted Bubblewrap networking exposes only the required `/run/systemd/resolve` runtime directory read-only when the host `/etc/resolv.conf` resolves there;
- trusted Rust-capable execution receives KodeGPT-owned persistent Cargo state at `<state-root>/tool-state/cargo-home`, bound at `/home/kodegpt/.cargo` while `HOME=/home/kodegpt` remains private;
- nested Node -> Cargo composition remains healthy;
- host PATH/arbitrary environment and host HOME/`~/.cargo` remain unmounted/uninherited;
- `observe` and `develop` policy behavior is unchanged.

Fresh live candidate evidence:

- `process.run(cargo --version)` exits 0 with Cargo 1.97.1;
- trusted `getent hosts github.com` exits 0, proving DNS under `unrestricted`;
- after an online Cargo run warms state, `cargo check --workspace --offline` exits 0 in a later independent sandbox invocation;
- Node `spawnSync("cargo", ["--version"])` exits 0;
- background process cancellation transitions to `cancelled` with exit 143 and retained bounded operation evidence;
- live profile remains `trusted` with `inheritEnv=false`;
- service health/audit/filesystem boundary remain healthy and MCP stays runtime/protocol/surface `0.1 / 2026-07-28 / 0.10`.

`verify.run(cargo:test)` is now deterministic and reaches the real repository tests after DNS/cache/toolchain resolution. On this acceptance host it cannot complete inside an already sandboxed KodeGPT process because the repository sandbox tests attempt Bubblewrap-inside-Bubblewrap while the outer KodeGPT sandbox intentionally keeps nested user namespaces disabled. Host-side `cargo test --workspace` passes fully on the same candidate. Direct nested-Bubblewrap reproduction also fails under the host user-namespace/AppArmor policy. The candidate therefore does **not** relax `--disable-userns`, capability drop, or the Bubblewrap boundary merely to make test-in-test execution possible.

`verify.run(package:test)` no longer collapses into an opaque synthetic exit 128. The long-running operation completes with normal exit 1 plus an 18.5 KiB bounded spool/artifact that identifies two environment-specific causes: linked-worktree `.git` metadata lives outside the retained workspace root, and full-stack tests attempt a second KodeGPT/Bubblewrap layer that the acceptance host rejects. The same candidate passes the complete host `pnpm run test` baseline. Signal-diagnostic contingency work is therefore not justified.

## Practical parity comparison

| Workflow | CodexPro evidence | KodeGPT evidence | Classification | Decision |
| --- | --- | --- | --- | --- |
| Workspace inspect/context | Direct workspace open/inspection works in the linked worktree. | `workspace.inspect` succeeds with bounded repository evidence. | `NO_GAP` | No change. |
| Search/read | Direct repository search/read works. | `code.search` and `file.read` work against retained-root source. | `NO_GAP` | No change. |
| Edit/patch | Direct targeted edits work. | `file.edit` performed a disposable architecture-doc marker edit and exact revert; host Git returned clean afterward. | `NO_GAP` | No change. |
| Shell/process | Host verification commands are direct. | Trusted `bash`, Cargo, Node -> Cargo, DNS, background process and cancellation all work through the existing process primitive. | `NO_GAP` | No new shell/tool surface. |
| Build/test/typecheck | Direct host gates complete normally. | Normal bounded commands work. Full repository verification from inside KodeGPT exposes sandbox-within-sandbox host limitations rather than missing build authority. | `DOC/ERGONOMIC_GAP` | Document the environmental boundary; do not weaken sandboxing. |
| Git workflow on ordinary checkout | Direct Git works. | Existing typed Git is proven historically on canonical ordinary checkouts. | `NO_GAP` | No change. |
| Git workflow on linked worktree | CodexPro `git_status` is clean and functional. | KodeGPT `git.status` fails closed because the worktree `.git` file resolves to common Git metadata outside the retained source root. | `NEW_BEHAVIOR_REQUIRES_SEPARATE_SPEC` | Separate worktree-metadata design; no opportunistic mount. |
| Failure diagnosis | Host process output is immediately visible. | Process status, stdout/stderr previews, spool artifact and durable audit expose DNS, nested-userns, worktree Git metadata and long-running verification state. | `NO_GAP` | Existing primitives are adequate. |
| Cancellation | Host process control is direct. | Benign `sleep 60` background operation cancels cleanly and remains inspectable. | `NO_GAP` | No change. |
| Iterative develop -> verify -> inspect | Direct loop works. | Candidate was repeatedly rebuilt, cut over, dogfooded, inspected and corrected using existing KodeGPT primitives. | `NO_GAP` | No orchestration framework required. |

## Evidence-based conclusion

P1 does not justify another public tool, provider abstraction, generic dependency-state framework, indexing subsystem, `skill.run`, agent orchestration, or looser trusted sandbox.

The one material parity gap is linked Git worktree metadata. Supporting it safely would require admitting a narrowly validated Git metadata root that is intentionally outside the retained worktree source root. That changes filesystem authority and therefore requires a separate approved design. The follow-up design record is `docs/superpowers/specs/2026-08-18-kodegpt-trusted-worktree-git-metadata-design.md`; no implementation from that follow-up is included in this branch.
