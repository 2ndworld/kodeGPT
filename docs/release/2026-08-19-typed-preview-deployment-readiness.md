# Typed Preview Deployment — Pre-Merge Readiness

Date: 2026-08-19
Branch: `feat/typed-preview-deployment`
Base: `5bfcf2e7969a7f1690678340df4b33f3a532883e`
Exact reviewed and verified feature head before this readiness record: `8964f87bec0efc29ea94b1c2620ef26a2a5aa5d9`
Target runtime / protocol / MCP surface: `0.1 / 2026-07-28 / 0.14`
Target public tool count: 76

## Scope

Phase 4 adds exactly two public MCP tools:

- `deploy.preview.create({ workspaceId })`
- `deploy.preview.inspect({ workspaceId, deploymentId })`

The implementation adds one static provider adapter, `netlify.deploy.v1`, with exactly two semantic mappings:

- `netlify.deploy.preview.create`
- `netlify.deploy.preview.inspect`

No `deploy.preview.logs`, production deployment tool, Cloudflare/Vercel adapter, generic HTTP surface, `provider.invoke`, generic provider selection, caller-supplied site/token/branch/SHA/URL, deployment database, queue, supervisor, polling worker, or automatic mutation retry is introduced.

## Authority and source-proof review

Create remains a bounded remote mutation:

- `REMOTE_MUTATION`;
- `workspaceBinding: "REQUIRED"`;
- one provider request maximum;
- `retry: "none"`;
- repository, branch, and exact HEAD OID are derived from the READY trusted workspace;
- `git.changes` must be clean and non-truncated before mutation;
- the admitted repository must match the workspace repository;
- the admitted production branch is rejected;
- provider response `sha` must equal the exact derived local HEAD OID;
- response/proof failure after mutation is handled by the existing `PROVIDER_MUTATION_OUTCOME_UNKNOWN` path.

Inspect remains a bounded typed read:

- `REMOTE_READ`;
- `workspaceBinding: "REQUIRED"`;
- one provider request maximum;
- fixed site-scoped Netlify endpoint;
- deployment/site identity is validated on response;
- only normalized bounded fields are exposed.

The Netlify manifest admits only `https://api.netlify.com`, uses the existing external-helper bearer credential broker with fixed argv `["token"]`, and keeps provider/site/credential selection private.

The hardened GitHub remote parser was extracted to `github-repository-identity.ts` and reused by Remote-CI. Existing Remote-CI resolver coverage remains green.

## Independent review finding and closure

Exact-diff review found one actionable public-evidence defect: Netlify `error_message` was length-bounded but could reach successful `deploy.preview.inspect` output without credential-pattern redaction.

The finding was closed test-first:

1. regression test added for credential-like `Authorization: Bearer ...` evidence;
2. RED run failed with the unredacted provider text;
3. implementation reused the existing deterministic provider-independent redactor;
4. GREEN run passed and existing Remote-CI redaction tests remained green.

Fix commit:

`8964f87bec0efc29ea94b1c2620ef26a2a5aa5d9 — fix: redact preview deployment error evidence`

Fresh post-fix focused review set: **9 files / 63 tests PASS**.

No other blocking finding remains from the review of scope growth, generic provider/HTTP leakage, source identity proof, mutation retry behavior, raw-response leakage, shared repository resolver behavior, surface version, or tool count.

## Fresh deterministic verification

Fresh host-scoped evidence on feature head `8964f87bec0efc29ea94b1c2620ef26a2a5aa5d9` before this readiness record:

- focused post-review set: **9 files / 63 tests PASS**;
- full monorepo `pnpm run test`: **129 passed files, 1 intentionally skipped file; 934 passed tests, 1 intentionally skipped test; 0 failed**;
- `tests/integration/full-stack.test.ts`: **2/2 PASS** in the host-scoped full run;
- root `pnpm run typecheck`: **PASS** across all workspace projects;
- root `pnpm run build`: **PASS**; existing Rust runtime warnings only;
- `pnpm run verify:forbidden`: **PASS** (`forbidden-pattern scan ok`);
- `pnpm run verify:package`: **PASS** (`package smoke ok`);
  - CLI package SHA-256: `6662203c86164bccfd69bbabfae21e98cc682b85f97834cb7802617f0bb41d01`;
  - runtime package SHA-256: `c5942f7a6c9d200fb90407ab0be9e4f3d1e87b26e3b108e101ac5d4bb4c02f47`;
  - runtime binary SHA-256: `fcfd42f258188e53c529e1c8a279c61186b73eae63f7c945d856ec439a4a1fad`;
- `cargo fmt --all -- --check`: **PASS**;
- `cargo check --workspace`: **PASS**; existing 10 runtime warnings only;
- `git diff --check 5bfcf2e7969a7f1690678340df4b33f3a532883e...HEAD`: **PASS**;
- worktree status after verification: **clean** before creation of this readiness record.

## Exact-diff evidence

KodeGPT `git.diffHistory` across:

`5bfcf2e7969a7f1690678340df4b33f3a532883e..8964f87bec0efc29ea94b1c2620ef26a2a5aa5d9`

reported:

- 30 files changed;
- 2029 insertions;
- 132 deletions;
- 0 binary files;
- patch not truncated.

The public surface is locked to `0.14` and exactly 76 tools, including only the two approved `deploy.preview.*` tools. Security and structured-schema tests reject public site/provider/branch/SHA/token/URL authority and reject generic provider/HTTP/deployment-log surfaces.

## Live Netlify acceptance prerequisite

The current host provider registry contains enabled `github.read.v1` and `github.write.v1` admissions only. There is no admitted `netlify.deploy.v1` provider on this host at pre-merge readiness time.

Therefore real Netlify create+inspect live acceptance cannot be truthfully executed yet. This is an external configuration prerequisite, not a code or deterministic-verification blocker. No mock provider authority or weakened admission rule will be added to manufacture acceptance.

After merge/release, live Netlify acceptance is conditional on a real operator-admitted `netlify.deploy.v1` record for `2ndworld/kodeGPT`, a non-production test branch, and a valid JIT helper implementing the fixed `token` argv contract.

## Pre-merge decision

**READY FOR PR/CI.**

This is not a Phase 4 completion claim. Still required for closure:

1. commit this readiness record;
2. push the exact feature branch;
3. create the PR;
4. require exact-head CI PASS on the reviewed/verified PR head;
5. merge only that exact accepted head;
6. require merged-main CI PASS;
7. stage/cut over the established immutable merged-main release;
8. verify live runtime/protocol/surface `0.1 / 2026-07-28 / 0.14` and exactly 76 tools;
9. if a valid Netlify admission/helper is then present, execute real create+inspect acceptance and prove returned `sourceOid` equals the exact deployed HEAD; otherwise retain the external acceptance prerequisite explicitly;
10. leave canonical Git state clean.
