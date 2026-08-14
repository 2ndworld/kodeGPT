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
