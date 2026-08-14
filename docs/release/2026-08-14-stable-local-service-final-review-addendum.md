# Stable Local Service Lifecycle — Final PR Review Addendum

Status date: 2026-08-14
PR: #7 — `feat(cli): add stable local service lifecycle`

This addendum supplements `2026-08-14-stable-local-service-readiness.md` with the final human-authorized PR review performed immediately before merge. Historical acceptance evidence in the readiness document remains unchanged.

## Final-review defect 7 — immutable release identity collision

Final patch review found one additional lifecycle integrity defect after the earlier six acceptance/review defects had been closed.

Release IDs intentionally identify immutable code artifacts from package version plus CLI and Rust runtime digests. A `ServiceReleaseRecord` also stores activation metadata such as Node/zrok executable paths, reserved zrok name, and local port. The metadata store previously allowed a record with an existing release ID to be overwritten by different activation metadata.

That allowed the same artifacts to be re-installed with a different port or reserved name under the same release ID. With an already-active release this could make stored metadata diverge from the loaded unit. With an initial staged release, the install path could rewrite the unit before the metadata collision was rejected.

The fix preserves artifact-derived release IDs and strengthens their immutability contract:

- staging an existing release ID is allowed only when the complete release record is identical;
- conflicting metadata for an existing release ID is rejected fail-closed;
- initial install stages/validates metadata before writing the user unit, so a collision cannot mutate the unit before rejection;
- no MCP semantic surface, zrok credential semantics, provider surface, or OS-authority boundary changed.

## TDD evidence

The first RED regression was introduced at commit `440b78cb606b05f0d8905e3ff620d4961d6c3f65`. GitHub Actions failed exactly on the new immutable-metadata assertion: 81/82 test files and 438/439 tests passed, while the new test showed `stageRelease()` resolving instead of rejecting and overwriting the active record.

Commit `24b7ee8e984cdbc5c235ec33abc2b9ea7d455cc0` made release records immutable per release ID. Push run #58 then passed every deterministic v0.1 gate.

A second RED regression at `446f8709e0b3e995a1b18e180b86675125b0f958` exercised the higher-level initial-install transaction. GitHub Actions failed exactly on the new unit-preservation assertion: 82/83 test files and 439/440 tests passed, and the diff showed the rejected install had already changed `ExecStart` from port 43121 to 43122.

Commit `ee7421fa7a7afd061113ee0c8c07e4d1d70d8425` moved initial metadata staging ahead of unit mutation. Both push run #62 and pull-request merge-ref run #63 then passed every deterministic v0.1 gate, including:

- TypeScript: 83/83 files, 440/440 tests;
- Bubblewrap functional security probes;
- complete Rust workspace tests;
- protocol, integration, security, isolation, and acceptance suites;
- forbidden-pattern scan;
- clean-install package smoke.

## Final-review conclusions

The final review found no remaining blocker after defect 7 was fixed and verified. The established exclusions remain in force:

- no `skill.run`;
- no `provider.list`, `provider.tools`, or `provider.invoke`;
- no MCP service lifecycle mutation;
- no MCP workspace-trust mutation;
- no generic shell or provider-agent authority;
- Rust remains final OS/security authority;
- historical tag `v0.1` remains untouched;
- provider interoperability remains **NOT STARTED**.

The live installed service acceptance recorded in the main readiness document remains valid because defect 7 changes install-time collision handling only; it does not change the already-running Node/Rust/zrok service topology, MCP surface `0.3`, or existing managed zrok exposure.

## Post-merge canonical-main closure

PR #7 was merged with merge commit `c1f81f59a55071c5a3f8c91a92d814b808b84a65`. Post-merge GitHub Actions run #66 executed on that exact `main` head and completed successfully. The historical readiness document above remains an immutable account of candidate acceptance; this section records only the later canonical-main reconciliation and host cutover.

The canonical checkout at `/home/sauron/dev/kodegpt` was fetched and reconciled without reset or rebase. Local `main` was a strict ancestor of `origin/main` (`0 25`) and therefore fast-forwarded from `d4ff9d63b8cbde428e8100bff196e2a0b45ea89e` to the merge commit. The resulting checkout was clean with `main...origin/main = 0 0`. The annotated historical tag `v0.1` continued to resolve to `b8eae12cea3be002a9a61d06cecfd34f86283eb4`, and the stash remained empty.

A fresh merged-main CLI bundle/typecheck completed successfully with `pnpm --filter kodegpt build`. Running that exact bundle through `service install --name public:kodegpt-dev --port 43121` staged release `rel_fa7cf9e07de98ae6941da6c4e3f9a918` while the accepted release `rel_811e9083cea7418ece04285e60b3df60` remained active. The running MainPID stayed `356675`, the loaded unit and working directory continued to point at release A, and `listenerReady=true`; installation therefore did not perform a premature cutover.

An explicit `service restart` then promoted `rel_fa7cf9e07de98ae6941da6c4e3f9a918` and retained `rel_811e9083cea7418ece04285e60b3df60` as the immediate rollback release. The resulting user service reported `ActiveState=active`, `SubState=running`, `UnitFileState=enabled`, `Result=success`, MainPID `422446`, `listenerReady=true`, `managedExposure=true`, linger disabled, reserved name `public:kodegpt-dev`, and local port `43121`.

Live provenance after cutover was independent from both the canonical checkout and the former feature worktree:

- Node CLI: `/home/sauron/.local/share/kodegpt/service/releases/rel_fa7cf9e07de98ae6941da6c4e3f9a918/bin/kodegpt.mjs`;
- Rust runtime: `/home/sauron/.local/share/kodegpt/service/releases/rel_fa7cf9e07de98ae6941da6c4e3f9a918/node_modules/@kodegpt/runtime-linux-x64/bin/kodegpt-runtime`;
- Node, Rust, and zrok working directories: the same immutable installed release root;
- zrok executable: `/usr/bin/zrok2`;
- zrok argv: `share public http://127.0.0.1:43121 --headless --force-local --backend-mode proxy -n public:kodegpt-dev`;
- no running service argv, executable path, working directory, or systemd `ExecStart` referenced `/home/sauron/dev/kodegpt` or `.worktrees/stable-local-service-lifecycle`.

The bounded ChatGPT/KodeGPT smoke on the promoted release passed: `system.health` returned `ok=true`, `auditHealthy=true`, `filesystemBoundaryAvailable=true`, and `testMethods=false`; `system.capabilities` returned runtime `0.1`, protocol `2026-07-28`, surface `0.3`, and filesystem boundary availability; `skill.list compatibility=NATIVE` returned `native-host-acceptance` with classification `NATIVE`.

Only after those provenance and host-smoke gates passed was `/home/sauron/dev/kodegpt/.worktrees/stable-local-service-lifecycle` removed and pruned. The clean local branch `feat/stable-local-service-lifecycle` was then deleted normally with `git branch -d`, without force. A subsequent status call executed from the installed active CLI rather than the repository still reported the service running and listener-ready, and a subsequent ChatGPT `system.health` call remained healthy, proving the service no longer depends on that worktree.

This closes Stable Local Service & Managed Exposure Lifecycle. Provider interoperability remains **NOT STARTED**. The next ranked gap is a separate, design-first **Bounded Read-Only Git History Intelligence** phase; it must preserve bounded structured output, trusted-workspace boundaries, no arbitrary `git` or generic shell authority, and the existing Rust/security authority model.
