# Continuity v2 + Resume Intelligence Readiness

Date: 2026-08-21

Candidate contract: `runtime 0.1 / protocol 2026-07-28 / surface 0.21 / 76 public tools`

Installed baseline before this candidate: merged P0-D main `0d0885d605578fdd084ce86437cbb577be25c8a1`, live `runtime 0.1 / protocol 2026-07-28 / surface 0.20 / 76 public tools`.

## Scope

Continuity v2 keeps the existing public `WorkspaceCheckpoint` schema at v1 while advancing only the private persisted continuity envelope to schema v2. Checkpoint upsert captures current `SourceStateRef { headOid, changesFingerprint }` server-side; callers cannot supply or spoof that evidence. When a current checkpoint is displaced, a compact milestone snapshot is retained. History is bounded to eight milestones and milestone objective text is UTF-8-safely compacted to 512 bytes.

`context.build(intent:"resume")` remains the same public tool and returns normal bounded repository context plus additive deterministic resume synthesis. Checkpoint relation is one of `fresh`, `stale`, `superseded`, or `unverifiable`; ancestry uses at most two bounded `git.range` reads. Current source state comes from the base context Git evidence rather than a second `git.changes` scan.

Resume reconciles only evidence refs explicitly present in the current checkpoint. Process, preview, PR, CI, and artifact refs use one-shot read-only authority; Git/note refs are informational unless more bounded evidence is required. Individual missing/provider/validation failures degrade per reference instead of failing the entire synthesis.

## Retained invariants

- Runtime remains `0.1`.
- MCP protocol remains `2026-07-28`.
- Public tool count remains exactly 76.
- No new public tool family or authority is added.
- No `workspace.resume`, `session.*`, `task.*`, `workflow.run`, scheduler, polling loop, process/preview inventory API, autonomous agent runtime, vector database, or Codex execution dependency is introduced.
- `workspace.checkpoint` remains the only continuity mutation tool and retains replacement + CAS semantics.
- `context.build(intent:"resume")` is read-only and never retries, reruns, cancels, restarts, dispatches, or mutates evidence.
- ChatGPT remains the planner/orchestrator; KodeGPT returns deterministic evidence and relation codes.

## Implementation commits before release reconciliation

- `7b8ff56` — persist continuity milestone history
- `6edbc05` — bind checkpoints to captured source state
- `ad8d635` — add resume repository context intent
- `0453234` — synthesize bounded resume evidence
- `312bc75` — expose structured resume context
- `8119f15` — teach host deterministic resume workflow

The final surface/readiness commit is recorded after candidate verification.

## TDD and focused verification evidence

- Continuity store: legacy-v1 normalization, strict private-v2 parsing, source-state persistence, bounded milestone eviction, UTF-8 objective compaction, lazy migration, clear/purge behavior — PASS.
- Workspace manager + MCP checkpoint composition: continuity metadata read, one-shot server-owned source-state capture, fail-before-mutation when source state is unavailable — PASS.
- Repository resume intent: schema/contract/weighting plus unchanged public action count — PASS.
- Resume relation + evidence composer: exact match, working-tree drift, advanced/rewound/diverged history, legacy/unavailable source state, no-checkpoint behavior, ordered one-shot evidence reads, per-ref degradation — PASS.
- Structured MCP result/wiring + discovery/skill guidance regression: 65 tests PASS across resume-context, structured-results, discovery, skill catalog, and public-action catalog.
- Surface/readiness/security/provider focused gate after the `0.21` bump: 6 files, 71 tests PASS.

## Final verification and integration gates

Pending before merge:

- full focused continuity/MCP regression set;
- complete Vitest inventory;
- `pnpm run typecheck`;
- `pnpm run build`;
- `cargo test --workspace`;
- forbidden-pattern/package gates;
- local resume dogfood for fresh / same-HEAD working-tree stale / HEAD advanced / diverged history plus explicit evidence refs;
- persistence verification across close/reopen or isolated candidate restart.

Pending after local verification:

- exact-head push + PR-event CI SUCCESS;
- guarded merge using the exact passing head OID;
- merged-main CI SUCCESS on the exact merge SHA;
- immutable production release built from clean merged-main provenance;
- service cutover and live `0.21 / 76` health verification;
- refreshed ChatGPT-host dogfood for `workspace.info.continuity`, resume-oriented `system.discover`, server-captured checkpoint source state, and `context.build(intent:"resume")`;
- phase-local branch/worktree/trust cleanup and final canonical reconciliation.

Installed `0.20 / 76` remains authoritative until those external gates complete.
