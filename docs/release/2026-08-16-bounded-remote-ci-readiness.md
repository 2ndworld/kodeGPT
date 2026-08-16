# Bounded Remote CI Intelligence — Candidate Readiness

Status date: 2026-08-16
Branch: `feat/bounded-remote-ci-intelligence`
Pre-documentation exact candidate: `d959fbb7772521d8ff5501343d257773409e2b4a`
Baseline: `7a22bcd576e841dc7e49ba431679934af0f7284f`
Status: PASS — automated verification, immutable installed-service cutover, fresh-host five-tool Remote-CI dogfood, live durable-audit inspection, and post-dogfood defect correction/cutover are complete on runtime `0.1`, protocol `2026-07-28`, surface `0.7`.

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

## Fresh-host defect signal and correction

Fresh-host dogfood exposed one real provider-shape compatibility defect after the initial `0.7` cutover. `ci.failure` rejected existing GitHub failure annotations whose valid `message` field contained a line feed, because the annotation normalizer reused a single-line control-character validator.

The defect was reproduced against historical failed run `31887613397`, isolated to the multiline annotation message, and corrected test-first. The regression test was observed RED before production code changed, then GREEN after the normalizer was narrowed so only annotation `message` accepts LF-delimited bounded text; other annotation fields retain the stricter control-character rejection.

Correction commit:

```text
57ef0e109d2e2c993d9bef4d780b4cac7fb2a96e fix: accept multiline ci annotations
```

Fresh verification after that behavior change:

- `pnpm test`: PASS — 96 files / 594 tests.
- `cargo test --workspace`: PASS across the complete Rust workspace.
- `pnpm run typecheck`: PASS.
- `pnpm run build`: PASS.
- `pnpm run verify:forbidden`: PASS — `forbidden-pattern scan ok`.
- `pnpm run verify:package`: PASS — `package smoke ok`.
- `pnpm run test:acceptance`: PASS — 2 files / 6 tests.

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

## Fresh-host five-tool dogfood

A fresh ChatGPT host snapshot exposed exactly 51 KodeGPT actions, including all five additive Remote-CI actions, while live `system.capabilities` reported runtime `0.1`, protocol `2026-07-28`, and surface `0.7`.

Live acceptance against the trusted canonical repository `/home/sauron/dev/kodegpt` produced the following bounded evidence:

- `ci.repository`: PASS — provider `github`, repository `2ndworld/kodeGPT`, selected remote `origin`, default branch `main`, auth state `AVAILABLE`.
- zero-argument `ci.status({})`: PASS when the uniquely READY canonical workspace was temporarily on its clean published `main` branch; it resolved revision `7a22bcd576e841dc7e49ba431679934af0f7284f`, branch `main`, overall state `PASS`, check `95108996638`, and run `31924171563`. The canonical repository's normal `docs/bounded-remote-ci-design` branch contains two intentional local-only design/plan commits, so an earlier zero-argument call on that unpublished HEAD could not resolve provider commit evidence. The branch was restored immediately after exercising the intended zero-argument path.
- `ci.runs`: PASS — bounded recent runs returned; `31924171563` was `COMPLETED` / `SUCCESS`. The small requested page reported `RUN_LIMIT` and `PROVIDER_PAGE_LIMIT` truncation explicitly.
- `ci.run`: PASS on existing run `31924171563`, returning structured bounded run/job/step data for job `95108996638`.
- `ci.failure`: PASS on pre-existing historical failed run `31887613397`; selected job `95019102488`, failed step `TypeScript test suite`, reason `STEP_FAILURE`, two structured annotations, and bounded failure-log evidence. Result reported `LOG_BYTE_LIMIT`; secret-bearing GitHub log fields were observed only in GitHub's redacted `***` form. No failing workflow was created, rerun, cancelled, or dispatched for acceptance.

## Durable live audit evidence

The live durable audit file was inspected through a bounded local projection that emitted only the CI audit schema fields plus boolean forbidden-text checks. The latest outcome for every required action was `success`:

```text
ci_repository  provider=github repository=2ndworld/kodeGPT truncated=false
ci_status      provider=github repository=2ndworld/kodeGPT truncated=false
ci_runs        provider=github repository=2ndworld/kodeGPT truncated=true
ci_run         provider=github repository=2ndworld/kodeGPT runId=31924171563 truncated=false
ci_failure     provider=github repository=2ndworld/kodeGPT runId=31887613397 jobId=95019102488 truncated=true
```

Observed CI-record keys are limited to the audit envelope plus bounded fields such as `provider`, `repository`, `credentialSource`, `runId`, `jobId`, `errorCode`, `truncated`, and `durationMs`. Full-file forbidden-text checks were false for `authorization`, `bearer `, `github_token`, `rawHeaders`, `rawBody`, `rawLog`, and `secretEnv`. No connector credential, GitHub token, raw HTTP header/body, full raw CI log, or secret environment value was copied into release documentation.

## Corrected installed-service cutover

The post-dogfood correction was staged as immutable release:

```text
rel_d826f47599984583931c632ed7e5818e
```

A status read after `service install` proved the existing `rel_0ceb386027eaad0cbd92e982321a8915` release remained active while `rel_d826...` was only staged. Explicit `service restart` then promoted the corrected release.

Final live service state:

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
activeRelease = rel_d826f47599984583931c632ed7e5818e
rollbackRelease = rel_0ceb386027eaad0cbd92e982321a8915
publicUrl = https://kodegpt-dev.shares.zrok.io/mcp
```

Post-restart `system.health` remained `ok=true`, `auditHealthy=true`, `filesystemBoundaryAvailable=true`, and `testMethods=false`.

## Readiness conclusion

Task 17 is PASS. The source implementation, corrected provider-shape handling, complete deterministic verification, package verification, immutable staging, explicit corrected cutover, fresh-host five-tool dogfood, bounded failure evidence, redaction, and durable audit inspection are green on surface `0.7`.

Provider Gateway / generic provider interoperability remains deferred. No `skill.run`, provider invocation, generic GitHub API passthrough, arbitrary HTTP authority, CI mutation authority, or raw CI-log persistence was added.
