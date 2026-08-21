# Evidence Freshness + Source-State Binding Readiness

Date: 2026-08-21

Candidate contract: `runtime 0.1 / protocol 2026-07-28 / surface 0.20 / 76 public tools`

Baseline before this candidate: canonical `main` `221538a2e45debed7a6d844c5f8af044303d3ac3`, installed surface `0.19 / 76`, active immutable release `rel_f8ed46a490b83951f30a3bc6a01f4c0c`.

## Scope

This release adds deterministic source-state binding to existing evidence-producing capabilities without adding public tools or authority. The shared source-state contract is:

```ts
interface SourceStateRef {
  headOid: string;
  changesFingerprint: string;
}
```

`changesFingerprint` is the same SHA-256 identity returned by `git.changes.fingerprint`; `headOid` is the exact full lowercase Git object ID parsed from the same hardened porcelain-v2 status scan.

## Implemented behavior

- `git.checkpoint` captures `headOid` from its existing bounded Git-status operation; no second revision command is introduced.
- `git.changes` returns `sourceState` and enforces `sourceState.changesFingerprint === fingerprint`.
- `verify.run` captures source state immediately before process launch. Source-state failure prevents the verification process from launching.
- Preview creation captures source state once before its background process launch and stores that immutable value for the preview lifecycle.
- `preview.start`, `preview.inspect`, and `preview.stop` return the same stored source state.
- Browser sessions inherit the preview source state. Open, inspect, viewport changes, click/type acknowledgement, screenshot, console, and network-failure results propagate it without independent Git scans.
- `visual.captureMatrix` and `visual.compare` inherit source state from the browser evidence they compose.
- Preview, browser, and visual MCP result schemas are closed and require the bound source state.
- Runtime readiness remains backward-compatible with surface `0.19` and all earlier admitted service surfaces while admitting `0.20` as the current candidate.

## Invariants retained

- Runtime version remains `0.1`.
- MCP protocol remains `2026-07-28`.
- Public MCP tool count remains exactly 76.
- No tool name or required-input inventory changes.
- No evidence database, mutable freshness boolean, automatic invalidation, automatic rerun, scheduler, polling loop, provider abstraction, workflow engine, multi-agent runtime, generic shell surface, or Codex execution dependency is introduced.
- GPT/ChatGPT remains the reasoning and orchestration host; KodeGPT remains the deterministic execution/evidence/authority plane.

## Implementation commits

- `a98388c` — design: evidence freshness source state
- `5e118aa` — implementation plan
- `83ccba1` — bind Git changes to source state
- `1ce263d` — bind verification evidence to source state
- `92f4120` — bind preview lifecycle to source state
- `94f8a74` — propagate source state through browser evidence

The final surface/release reconciliation commit is recorded after candidate verification.

## Verification evidence before final release gate

TDD was used for each behavioral boundary:

- Git checkpoint/parser tests proved a single full HEAD OID is required and preserved through the capability layer.
- Verification RED tests proved missing behavior for launch-time source-state binding and proved source-state failure originally did not prevent execution; both became GREEN after implementation.
- Preview RED tests proved source state was not captured before launch and source-state failure did not stop process launch; lifecycle tests became GREEN after implementation.
- Browser RED tests proved browser evidence initially returned no source state; browser propagation became GREEN without adding a Git resolver.
- Visual RED tests proved visual results initially omitted source state; propagation became GREEN from existing browser evidence.
- MCP RED tests proved preview/browser output schemas were absent and visual strict schemas rejected source state; closed source-state-bound output schemas then became GREEN.
- Surface-version RED tests failed only because production still reported `0.19` / rejected `0.20`; the same focused suite became GREEN after the production bump and compatibility update.

Latest focused evidence collected on the candidate before the final full gate:

- source-state regression set: 8 test files, 133 tests passed;
- surface-version/readiness/security/provider set: 6 test files, 71 tests passed;
- full monorepo TypeScript typecheck passed before the final release-gate run.

## Final pre-merge verification

Fresh verification on the final candidate tree produced:

- `pnpm run typecheck` — PASS across all 13 participating workspace projects;
- `pnpm run build` — PASS, including the packaged CLI and release-profile Rust runtime build;
- complete Vitest inventory split into two `--no-file-parallelism` shards because the single-run wall clock exceeds the CodexPro 180-second command ceiling:
  - shard 1/2: 69 files passed, 516 tests passed, 1 intentional spike test skipped;
  - shard 2/2: 70 files passed, 553 tests passed;
  - aggregate: 139 passing files plus 1 intentionally skipped file, 1,069 tests passed and 1 skipped;
- `cargo test --workspace` — PASS across policy, protocol, runtime, sandbox, developer-environment, workspace-IO, semantic-scope, and skill-source suites, including the new checkpoint HEAD-OID parser/integration path and existing Bubblewrap/worktree/process isolation coverage.

The first full unsharded Vitest attempt exposed three stale test fixtures rather than production failures: a public `GitChangesResultSchema` fixture, a nested `context.build.git` fixture, and a full-stack unborn Git repository. The fixtures were corrected at their source: both schema fixtures now include the required source state, and the full-stack repository now receives an empty initial commit before preserving its existing staged `A/M` test state. Those three tests then passed together before the two complete shards were run.

Security/provider surface assertions continue to require exactly 76 public tools. Surface `0.20` changes only additive result schemas and service readiness compatibility; runtime `0.1` and protocol `2026-07-28` remain unchanged.

## Integration and cutover gates

The candidate is ready for integration review. Remaining external gates are exact-head CI on the pushed branch/PR, guarded integration into `main`, merged-main CI, immutable service release cutover, and exact-active-release dogfood. Installed `0.19 / 76` remains authoritative until those gates complete.
