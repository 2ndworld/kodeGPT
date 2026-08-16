# Bounded Remote CI Intelligence — Candidate Readiness

Status date: 2026-08-16
Branch: `feat/bounded-remote-ci-intelligence`
Pre-documentation exact candidate: `d959fbb7772521d8ff5501343d257773409e2b4a`
Baseline: `7a22bcd576e841dc7e49ba431679934af0f7284f`
Status: automated verification PASS; immutable installed-service cutover PASS; live health/capability identity PASS; final five-tool ChatGPT host dogfood PENDING because this conversation still exposes the pre-refresh 46-tool connector schema even though the live service reports surface `0.7`.

## Scope

This phase adds exactly five public, bounded, read-only, GitHub-backed Remote-CI capabilities:

```text
ci.repository
ci.status
ci.runs
ci.run
ci.failure
```

The public inventory is locked at exactly 51 tools and semantic surface `0.7`. The runtime remains `0.1` and MCP protocol remains `2026-07-28`.

No generic GitHub API, provider gateway, raw CI log API, CI mutation, workflow dispatch, arbitrary HTTP method/endpoint, or `skill.run` authority was added.

## Security boundary

Remote-CI repository identity is derived from the trusted workspace Git remote. Public tool inputs do not accept arbitrary repository, provider, URL, endpoint, host, token, credential, headers, or HTTP method selection.

GitHub transport is fixed to semantic GET operations. Regression coverage rejects mutation-oriented/public-generic names including:

```text
github.request
github.graphql
github.rest
gh.run
ci.logs.raw
ci.jobs.list
ci.steps.list
ci.rerun
ci.cancel
ci.dispatch
provider.list
provider.tools
provider.invoke
skill.run
gh api
```

Failure evidence remains bounded and redacted before public result/audit derivation. Full raw CI log artifacts are not persisted.

## Task 13–15 implementation evidence

Task 13 committed as:

```text
5804297 feat: expose bounded remote ci tools
```

It locks surface `0.7`, exactly 51 tools, exactly five public `ci.*` tools, strict input/output schemas, read-only/non-destructive/idempotent/open-world annotations, production Remote-CI handoff, and runtime-status compatibility for historical surfaces `0.3` through `0.6` while `0.7` is current.

Task 14 committed as:

```text
620ce16 feat: describe native ci capabilities
```

It reconciles advisory native skill metadata for the five Remote-CI capabilities without granting execution/provider authority.

Task 15 committed as:

```text
54ef110 test: lock remote ci security boundary
```

It adds forbidden-surface guards, fixed-GET transport assertions, and full-stack fake-provider coverage through actual MCP HTTP for all five tools. The fake-provider acceptance proves durable bounded audit plus credential/Authorization/log redaction.

Task 16 discovered four stale 46-tool integration fixtures rather than a production behavior defect. Those regressions were corrected and committed separately as:

```text
d959fbb test: reconcile remote ci surface fixtures
```

The corrected integration fixtures now lock the 51-tool surface and distinguish Remote-CI read-only open-world annotations from local read-only annotations.

## Complete automated verification

Fresh Task 16 gates on exact candidate `d959fbb7772521d8ff5501343d257773409e2b4a`:

- `pnpm test`: PASS — 96 files / 594 tests.
- `cargo test --workspace`: PASS across the complete Rust workspace; only existing warning/ignored helper-test noise remained.
- `pnpm run typecheck`: PASS across all TypeScript workspace projects.
- `pnpm run build`: PASS.
- `pnpm run verify:forbidden`: PASS — `forbidden-pattern scan ok`.
- `pnpm run verify:package`: PASS — package smoke completed successfully.
- `pnpm run test:acceptance`: PASS — 6/6 tests, including fake-provider Remote-CI full-stack acceptance.

The initial full `pnpm test` run found exactly four stale surface fixtures that expected 46 tools. Targeted regression verification passed 15/15 before the complete gate sequence was rerun to green.

## Immutable installed-service staging and cutover

Pre-cutover live baseline:

```text
state = running
enabled = true
listenerReady = true
managedExposure = true
reservedName = public:kodegpt-dev
localPort = 43121
runtime = 0.1
protocol = 2026-07-28
surface = 0.6
activeRelease = rel_2c9e12bd2de99faab0b1fb775af8da4f
rollbackRelease = rel_f00862ed93f8e2919402fc60048ba2a7
```

Candidate `service install --name public:kodegpt-dev --port 43121` staged:

```text
rel_0ceb386027eaad0cbd92e982321a8915
```

A status read immediately after staging proved there was no premature cutover: the old `rel_2c9e12...` release remained active at surface `0.6` and the new release existed only as `stagedReleaseId`.

Explicit `service restart` then promoted the staged candidate.

Post-cutover live service status:

```text
state = running
enabled = true
linger = disabled
listenerReady = true
managedExposure = true
reservedName = public:kodegpt-dev
localPort = 43121
runtime = 0.1
protocol = 2026-07-28
surface = 0.7
activeRelease = rel_0ceb386027eaad0cbd92e982321a8915
rollbackRelease = rel_2c9e12bd2de99faab0b1fb775af8da4f
publicUrl = https://kodegpt-dev.shares.zrok.io/mcp
```

A live ChatGPT connector call after cutover returned `system.health.ok=true`, `auditHealthy=true`, `filesystemBoundaryAvailable=true`, and `testMethods=false`. A subsequent live `system.capabilities` call returned exactly runtime `0.1`, protocol `2026-07-28`, and surface `0.7`.

The canonical trusted repository `/home/sauron/dev/kodegpt` could still be opened and closed normally through the live connector after cutover.

## Remaining live-host blocker

The current ChatGPT conversation was created before the surface `0.7` cutover. Its loaded KodeGPT connector action schema remains cached at 46 tools. Re-querying the connector resource inventory after cutover still returned 46 tools even though live `system.capabilities` already reports surface `0.7`.

Therefore this conversation cannot directly invoke the newly-added `ci.repository`, `ci.status`, `ci.runs`, `ci.run`, or `ci.failure` actions. Rotating the connector credential merely to bypass this host-schema cache was intentionally not done because it would invalidate the existing ChatGPT connector credential and is unnecessary/risky.

As a result, the following final Task 17 evidence is still pending a fresh ChatGPT host/session whose connector schema has refreshed to 51 tools:

1. confirm the host action inventory exposes exactly 51 tools and exactly five `ci.*` actions;
2. live `ci.repository` against trusted `/home/sauron/dev/kodegpt`;
3. live zero-argument `ci.status`;
4. live `ci.runs`;
5. live `ci.run` on an existing run;
6. live `ci.failure` only on an already-existing historical failed run, if one exists;
7. inspect durable audit after those calls and confirm only bounded CI metadata is present, with no token, Authorization header, raw response body/headers, or full raw CI log.

No failing CI run should be created for acceptance.

## Readiness conclusion

Source implementation, deterministic verification, package verification, service staging, explicit cutover, and live service identity are green. The installed candidate is healthy on surface `0.7` with a known-good immediate rollback release.

Task 17 is not yet declared fully closed because the current conversation's connector schema has not refreshed to the 51-tool host surface. Task 18 tracker reconciliation/final closure must wait for that fresh-host five-tool dogfood and audit evidence. Provider Gateway remains deferred.
