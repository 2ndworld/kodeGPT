# P1-B Dev Console v2 Implementation Plan

> Execute in the isolated `feat/p1b-dev-console-v2` worktree. Follow TDD: add one behavior test, prove RED, implement minimally, prove GREEN, then continue.

## Task 1 — Lock cockpit state semantics

Files:
- Modify: `packages/dev-console/src/state.test.ts`
- Modify: `packages/dev-console/src/state.ts`

Steps:
1. Add failing tests for source-state summary, checkpoint objective, fresh/stale verification, preview/process summaries, remote summaries, and bounded next-action hints.
2. Run the focused dev-console state test and confirm each new expectation fails for missing behavior.
3. Implement only the store observations/projection needed by those tests.
4. Re-run focused tests to green and refactor only after green.

## Task 2 — Record existing tool observations

Files:
- Modify: `packages/mcp-server/src/structured-results.test.ts`
- Modify: `packages/mcp-server/src/tools.ts`

Steps:
1. Add failing integration-level handler tests proving existing `workspace.info/checkpoint`, `context.build`, `git.changes`, `verify.run`, process, preview, GitHub PR, and CI calls feed the console store.
2. Preserve the invariant that the `console.state` handler itself calls only `workspace.list` and `system.health`.
3. Implement observation hooks around already-existing typed results; no new provider/Git call.
4. Prove focused MCP tests green.

## Task 3 — Render cockpit UI

Files:
- Modify: `packages/dev-console/src/app.ts`
- Modify: `packages/dev-console/templates/mcp-app.html`
- Modify: `tests/integration/mcp-apps.test.ts`

Steps:
1. Add failing resource/contract assertions for Dashboard, Evidence, Remote, objective/freshness labels, and no external assets.
2. Implement compact dashboard cards and dedicated Evidence/Processes/Remote/Security/Diagnostics views while retaining host-mediated actions.
3. Build the MCP app resource and prove focused integration tests green.

## Task 4 — Semantic-surface contract

Files determined by current surface-version ownership.

Steps:
1. If the additive `console.state.cockpit` contract is treated by existing project policy as a semantic-surface change, add a failing version-contract test and bump surface exactly once; keep tool count unchanged.
2. Update backward-compatibility acceptance only as required by the existing runtime-status contract.
3. Prove surface/tool inventory tests green.

## Task 5 — Verification and delivery

1. Review exact diff and confirm no new authority/tool family/network call was added.
2. Run focused dev-console/MCP Apps tests.
3. Run full deterministic Node/Rust/security/package gates using repository recipes, parallelizing independent broader gates after focused proof.
4. Commit and push exact feature head.
5. Create PR; require exact-head CI success; fix only evidence-backed failures.
6. Guarded merge exact passing head; require merged-main CI success.
7. Reconcile canonical main FF-only.
8. Build authoritative merged-main package, run `pnpm verify:package`, stage service install only, prove old active release remains active, then explicit service restart.
9. Verify runtime/protocol/surface/tool count/health and live `console.state` cockpit behavior through the refreshed ChatGPT connector.
10. CAS checkpoint to `Complete P1-B Dev Console v2`, status complete, `nextActions: []`, with PR/CI/release/health/dogfood evidence.
11. Remove clean worktree and merged local/remote feature branches.
