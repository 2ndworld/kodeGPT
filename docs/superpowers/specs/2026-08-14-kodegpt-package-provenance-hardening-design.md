# KodeGPT Package Provenance Hardening Design

## Status

Approved scope for implementation after the post-PR #9 installed-service defect discovered on 2026-08-14.

Baseline: `main` at `7ea156e76abf46bc078d183f8748206c1ce15052`.

## Problem

The post-merge service cutover exposed a real mixed-artifact failure mode. A newly built CLI bundle was installed together with an older staged Rust runtime. `service install` accepted the pair because the current release identity only hashes the CLI bytes and whatever runtime bytes happen to be present at install time. The resulting service looked structurally valid, but newly added Git history operations failed at runtime.

The repository already has a correct package-smoke sequence that runs `cargo build --release -p kodegpt-runtime`, stages the runtime, then builds the CLI. The defect occurred because `pnpm --filter kodegpt build` can currently be run by itself and does not establish or verify any relationship between the CLI bundle and the runtime package.

## Goals

1. Make the normal CLI build path produce a coherent CLI/runtime artifact pair rather than a CLI-only artifact.
2. Persist bounded, deterministic provenance that binds the exact CLI bytes to the exact Rust runtime bytes.
3. Make `service install` fail closed when CLI/runtime provenance is missing, malformed, inconsistent, or does not match the actual artifact bytes.
4. Preserve provenance inside immutable service releases so later verification can re-check the pair.
5. Add regression coverage for the real mixed-artifact failure mode.
6. Keep MCP runtime/protocol/surface identities unchanged: runtime `0.1`, protocol `2026-07-28`, surface `0.4`.
7. Do not change service metadata schema version or broaden runtime authority.

## Non-goals

- Provider interoperability.
- `provider.list`, `provider.tools`, `provider.invoke`, or `skill.run`.
- Generic shell, generic network authority, or arbitrary Git authority.
- Reworking the service activation/rollback state machine.
- Replacing release IDs with source revisions.
- Proving reproducible Rust builds across toolchains or hosts.

## Design

### 1. One authoritative artifact-pair build path

`apps/cli/scripts/build-cli.mjs` becomes the authoritative CLI/runtime pair builder used by `pnpm --filter kodegpt build`.

Before bundling the CLI it runs:

1. `cargo build --release -p kodegpt-runtime` from the workspace root;
2. `scripts/stage-runtime.mjs` to atomically stage the just-built runtime into `packages/runtime-linux-x64/bin/kodegpt-runtime`;
3. the existing esbuild CLI bundle step.

After both artifacts exist, it hashes the final CLI bundle and staged runtime and writes the same provenance manifest to both package roots.

This directly removes the operator footgun that caused the incident: running the normal CLI build command can no longer leave the platform runtime stale.

### 2. Artifact-pair provenance schema

Both:

- `apps/cli/bin/kodegpt.provenance.json`
- `packages/runtime-linux-x64/provenance.json`

contain identical JSON:

```json
{
  "schemaVersion": 1,
  "pairId": "pair_<32 lowercase hex>",
  "sourceRevision": "<40 lowercase hex Git HEAD>",
  "sourceDirty": false,
  "runtimePackage": "@kodegpt/runtime-linux-x64",
  "cliSha256": "<64 lowercase hex>",
  "runtimeSha256": "<64 lowercase hex>"
}
```

`pairId` is deterministic from the exact CLI and runtime digests, using SHA-256 over the two digests with a separator and truncating to 32 lowercase hex characters. `sourceRevision` and `sourceDirty` are audit metadata, not the trust decision. The trust decision is the exact artifact-digest binding.

Dirty source builds remain possible for development/test workflows; they are explicitly marked rather than silently represented as clean HEAD output.

Writes are atomic: temporary file then rename.

### 3. Package both manifests

`apps/cli/package.json` adds `bin/kodegpt.provenance.json` to `files`.

`packages/runtime-linux-x64/package.json` adds `provenance.json` to `files`.

A packed or installed CLI therefore carries the expected pair identity, while the platform package independently carries the same identity.

### 4. Fail-closed service materialization

Before creating or reusing a service release, `materializeServiceRelease` reads:

- the CLI provenance adjacent to `cliPath`;
- the runtime provenance at the runtime package root.

It validates:

- both are schema version 1 with the closed field/value grammar;
- both manifests are identical;
- `runtimePackage` is exactly `@kodegpt/runtime-linux-x64`;
- `cliSha256` equals the actual CLI bytes;
- `runtimeSha256` equals the actual runtime bytes;
- `pairId` recomputes from those two actual digests.

Any failure aborts before metadata staging or service-unit changes.

The release materializer copies the CLI provenance next to `bin/kodegpt.mjs`; runtime provenance is already copied with the runtime package. `verifyServiceRelease` revalidates the persisted pair as well as the existing release digests/package identity.

The service metadata schema remains version 1. Existing release records keep their current fields. Provenance is an immutable release artifact rather than a new metadata authority.

### 5. Regression and package-smoke coverage

TDD begins with a service-release regression proving that a runtime whose bytes differ from the CLI provenance expectation is currently accepted. The test must fail on the baseline and pass only after fail-closed validation exists.

Package smoke is then updated to use only `pnpm --filter kodegpt build` as the build entrypoint, proving that command now performs the Rust build/stage itself. It verifies the two packaged provenance manifests agree with the exact packed artifacts.

After the normal packaged-service test, package smoke tampers with the installed runtime bytes and proves a subsequent `service install` fails before staging a release.

## Error handling

Provenance failures use concise operator-facing errors under a common `service artifact provenance` wording. No secrets or host paths need to be added to errors. Missing provenance is a hard failure rather than a compatibility fallback because accepting missing provenance would recreate the original vulnerability.

## Compatibility

This is a packaging/service safety change only. It does not change MCP tool schemas or semantic surface version.

Old active/rollback releases may remain in service metadata and continue to run. They are not proactively revalidated by the new candidate-materialization path. New releases produced by the hardened build are provenance-bearing and fail closed.

## Verification gates

1. RED regression test on the exact baseline behavior.
2. Targeted GREEN service-release tests.
3. `pnpm run typecheck`.
4. Full TypeScript suite.
5. protocol/integration/security suites.
6. `pnpm verify:forbidden`.
7. `pnpm verify:package` including the packaged tamper rejection.
8. `cargo test --workspace`.
9. Exact-head CI.
10. Local installed-service staging/cutover and real host smoke when the local connector is available.
11. Historical `v0.1^{}` remains `b8eae12cea3be002a9a61d06cecfd34f86283eb4`.
