# Bounded CI Status Wait Readiness

Date: 2026-08-22

Candidate contract: `runtime 0.1 / protocol 2026-07-28 / surface 0.22 / 76 public tools`

Installed baseline before this candidate: merged P0-C main `ce26f26b055d7c1f8e91b367af8cdce34e77dc41`, live `runtime 0.1 / protocol 2026-07-28 / surface 0.21 / 76 public tools`, active release `rel_bcb37f54b6d749ca20db8524aeb38ce0` with rollback `rel_9272a41e002c592e16f67f792da98851`.

## Scope

P0-E extends only the existing read-only `ci.status` input with optional integer `waitMs` bounded to `0..30000`. Default/zero wait preserves the existing one-observation behavior.

One logical `ci.status` call resolves repository identity and the requested local Git revision once, obtains the credential once, creates the provider adapter once, and then observes the same resolved OID. `PASS`, `FAIL`, and `CANCELLED` return immediately. `PENDING` and `UNKNOWN` may be re-observed up to three additional times, for at most four observations total, distributed across the requested wait window.

Each observation retains the existing `CI_REQUEST_BUDGETS.status = 6` provider-request ceiling. Therefore one bounded wait has a structural maximum of four observations and 24 provider requests, without adding a second provider API or changing the result schema.

## Retained invariants

- Runtime remains `0.1`.
- MCP protocol remains `2026-07-28`.
- Public tool count remains exactly 76.
- No new public tool or tool family is introduced.
- `CiStatusResult` schema is unchanged.
- `waitMs` is optional; omitted and zero retain one-shot behavior.
- No background CI monitor, durable queue, scheduler, indefinite poller, automatic retry loop, rerun/cancel/dispatch behavior, or autonomous agent authority is introduced.
- Provider/revision failures remain ordinary `ci.status` failures and are not swallowed or retried as hidden recovery policy.
- ChatGPT remains the host orchestrator. Workflow guidance permits one bounded `ci.status(waitMs: 30_000)` on the same exact revision and forbids chaining waits as busy polling.

## TDD evidence

Completed during implementation:

- baseline focused Remote-CI/MCP/skill suite: 72/72 PASS before changes;
- `CiStatusInputSchema` RED on unknown `waitMs`, then GREEN for exact integer range `0..30000`;
- service RED proved the existing implementation remained one-shot for pending CI;
- service GREEN proves zero/terminal one-shot behavior, fixed revision reuse, `PENDING -> UNKNOWN -> PASS`, bounded scheduling at 10-second targets for a 30-second window, and maximum four observations;
- workflow RED proved the host skill did not yet mention bounded CI wait; GREEN now requires `ci.status(waitMs: 30_000)` and preserves `never busy-poll` guidance;
- surface RED produced only expected `0.21 -> 0.22` compatibility failures; surface GREEN passed 71/71 while preserving exactly 76 tools.

## Remaining release gates

Before merge:

- focused aggregate Remote-CI + MCP structured + workflow + surface regression;
- complete Vitest inventory;
- `pnpm run typecheck`;
- `pnpm run build`;
- `cargo test --workspace`;
- `pnpm run verify:forbidden`;
- `pnpm run verify:package`;
- exact diff review and clean candidate head;
- real GitHub dogfood on the exact feature OID using `ci.status(waitMs)` while CI transitions from nonterminal to terminal.

After local verification:

- exact-head push and PR-event CI SUCCESS;
- guarded PR merge using the exact passing feature OID;
- merged-main CI SUCCESS on the exact merge SHA;
- immutable release provenance from clean merged main;
- service cutover to `0.22 / 76` with prior `0.21` retained as rollback;
- refreshed live `system.capabilities`, health, and host-visible `ci.status.waitMs` acceptance;
- phase-local branch/worktree cleanup and final canonical reconciliation.
