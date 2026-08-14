# KodeGPT Package Provenance Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate mixed CLI/stale-runtime service releases by making the normal CLI build produce a provenance-bound artifact pair and making service installation reject inconsistent bytes before staging.

**Architecture:** `apps/cli/scripts/build-cli.mjs` becomes the single pair-build path: build Rust, stage it, bundle CLI, hash both artifacts, then atomically write identical provenance manifests into both package roots. Service release materialization parses and validates those manifests against actual bytes and copies provenance into the immutable release. Package smoke exercises the same operator command and a tampered-runtime rejection.

**Tech Stack:** Node.js 24 ESM, TypeScript 5.9, esbuild, Vitest, Rust/Cargo, pnpm.

## Global Constraints

- Base is `7ea156e76abf46bc078d183f8748206c1ce15052`.
- Runtime version remains `0.1`.
- MCP protocol remains `2026-07-28`.
- MCP surface remains `0.4`.
- Service metadata remains schema version 1.
- Do not add provider interoperability, `skill.run`, generic shell/network/Git authority, or workspace-trust mutation.
- Preserve `v0.1^{}` at `b8eae12cea3be002a9a61d06cecfd34f86283eb4`.
- Do not drop the preserved bounded-history design-artifact stash until unique contents are audited.

---

### Task 1: Lock the mixed-artifact bug with a RED regression

**Files:**
- Modify: `apps/cli/src/service/release.test.ts`

**Interfaces:**
- Consumes: existing `materializeServiceRelease(MaterializeServiceReleaseInput)`.
- Produces: a failing behavioral expectation that mixed provenance/runtime bytes must be rejected.

- [ ] **Step 1: Extend the release fixture with valid matching provenance files**

Add SHA-256 helpers in the test, then write identical schema-v1 provenance beside the fixture CLI and inside the fixture runtime package. The manifest contains `pairId`, `sourceRevision`, `sourceDirty`, `runtimePackage`, `cliSha256`, and `runtimeSha256`.

- [ ] **Step 2: Add the regression**

After building a valid fixture, rewrite the runtime binary to different bytes without updating provenance and assert:

```ts
await expect(materializeServiceRelease(input)).rejects.toThrow(/service artifact provenance/i);
```

- [ ] **Step 3: Verify RED**

Run the targeted release test. Expected result on baseline: the new test FAILS because current materialization ignores provenance and accepts the changed runtime.

- [ ] **Step 4: Commit only the RED test**

Commit message: `test: reproduce mixed service artifact release`.

---

### Task 2: Produce a provenance-bound CLI/runtime pair

**Files:**
- Modify: `apps/cli/scripts/build-cli.mjs`
- Modify: `apps/cli/package.json`
- Modify: `packages/runtime-linux-x64/package.json`

**Interfaces:**
- Produces identical `ArtifactPairProvenanceV1` JSON at:
  - `apps/cli/bin/kodegpt.provenance.json`
  - `packages/runtime-linux-x64/provenance.json`

Manifest shape:

```ts
interface ArtifactPairProvenanceV1 {
  schemaVersion: 1;
  pairId: `pair_${string}`;
  sourceRevision: string;
  sourceDirty: boolean;
  runtimePackage: "@kodegpt/runtime-linux-x64";
  cliSha256: string;
  runtimeSha256: string;
}
```

- [ ] **Step 1: Make build-cli build/stage Rust first**

Run `cargo build --release -p kodegpt-runtime` at workspace root, then run `scripts/stage-runtime.mjs`, and only then execute the existing esbuild bundle.

- [ ] **Step 2: Hash final artifacts and derive pair identity**

Compute SHA-256 of `apps/cli/bin/kodegpt.mjs` and `packages/runtime-linux-x64/bin/kodegpt-runtime`. Derive `pairId` from SHA-256 of `cliSha256 + "\0" + runtimeSha256`, truncated to 32 lowercase hex characters.

- [ ] **Step 3: Record source audit identity**

Capture `git rev-parse HEAD` and whether `git status --porcelain --untracked-files=all` is non-empty. These fields are informational; artifact digests remain the validation boundary.

- [ ] **Step 4: Atomically write both identical provenance files**

Write temporary JSON with mode-compatible normal package files, then rename into place.

- [ ] **Step 5: Package the manifests**

Add `bin/kodegpt.provenance.json` to CLI `files` and `provenance.json` to runtime package `files`.

- [ ] **Step 6: Run the normal CLI build**

`pnpm --filter kodegpt build` must complete with a freshly staged runtime and both manifests present.

---

### Task 3: Fail closed during service release materialization

**Files:**
- Modify: `apps/cli/src/service/release.ts`
- Modify: `apps/cli/src/service/release.test.ts`

**Interfaces:**
- Internal parser/validator accepts unknown JSON and returns a closed schema-v1 manifest.
- `materializeServiceRelease` validates provenance before creating/reusing a release.
- `verifyServiceRelease` validates persisted provenance against persisted CLI/runtime bytes.

- [ ] **Step 1: Parse provenance with a closed grammar**

Require exact schema/version, runtime package name, `pair_[a-f0-9]{32}`, 40-char lowercase source revision, boolean dirty flag, and 64-char lowercase artifact digests. Reject arrays/non-objects and unknown malformed values.

- [ ] **Step 2: Validate the artifact pair**

Read CLI provenance adjacent to `cliPath` and runtime provenance at the runtime package root. Require the two parsed manifests to be identical. Re-hash actual CLI/runtime bytes and require both stored digests and recomputed `pairId` to match.

- [ ] **Step 3: Copy CLI provenance into the immutable release**

Copy it to `releaseRoot/bin/kodegpt.provenance.json`. Runtime provenance is copied with the platform package.

- [ ] **Step 4: Revalidate immutable releases**

Extend `verifyServiceRelease` to invoke the same pair validation against persisted paths.

- [ ] **Step 5: Verify GREEN**

Run the targeted service release tests. The RED regression must now PASS and all previous release lifecycle tests remain green.

- [ ] **Step 6: Commit the minimal fix**

Commit message: `fix: bind service releases to package provenance`.

---

### Task 4: Harden package smoke around the operator workflow

**Files:**
- Modify: `scripts/package-smoke.mjs`

**Interfaces:**
- Consumes the normal `pnpm --filter kodegpt build` command.
- Proves packed/installed provenance matches exact packaged bytes.
- Proves service install rejects runtime tampering.

- [ ] **Step 1: Remove duplicate pre-build cargo/stage calls**

Package smoke must call `pnpm --filter kodegpt build` as the authoritative pair build instead of separately reproducing its prerequisites.

- [ ] **Step 2: Verify source package provenance**

Read the CLI/runtime provenance files and assert they are identical and their digests match the built artifacts.

- [ ] **Step 3: Verify packed provenance**

Extract/read provenance from both tarballs and assert it matches the source manifests and packed runtime/CLI bytes.

- [ ] **Step 4: Verify installed tamper rejection**

After the normal packaged-service lifecycle test is cleaned up, modify the installed runtime bytes and invoke `service install` again. Require a nonzero exit and an error containing `service artifact provenance`. Ensure no staged service metadata is created by the rejected attempt.

- [ ] **Step 5: Run package verification**

`pnpm verify:package` must PASS.

- [ ] **Step 6: Commit smoke hardening**

Commit message: `test: verify package provenance fail closed`.

---

### Task 5: Full deterministic verification and exact-head CI

**Files:**
- No behavior expansion.

- [ ] Run `pnpm run typecheck`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm test:protocol`.
- [ ] Run `pnpm test:integration`.
- [ ] Run `pnpm test:security`.
- [ ] Run `pnpm verify:forbidden`.
- [ ] Run `pnpm verify:package`.
- [ ] Run `cargo test --workspace`.
- [ ] Review only the intended diff.
- [ ] Push exact head and require GitHub CI SUCCESS before any merge decision.

---

### Task 6: Host-local stash audit and installed-service verification

**Files/state:**
- Local canonical repo `/home/sauron/dev/kodegpt`.
- Preserved `stash@{0}` containing the two bounded-history design/plan artifacts.
- User systemd service and installed releases under `~/.local/share/kodegpt/service`.

- [ ] **Step 1: Materialize the remote feature branch into an isolated local worktree when CodexPro/local filesystem access is available.**
- [ ] **Step 2: Audit the two stash files against canonical docs. Preserve any unique content; do not drop the stash until that proof exists.**
- [ ] **Step 3: Build using only the hardened normal build path and confirm CLI/runtime provenance pair equality.**
- [ ] **Step 4: `service install` must stage without premature cutover.**
- [ ] **Step 5: Explicitly restart/cut over and prove Node, Rust, and zrok process provenance comes from the immutable new installed release.**
- [ ] **Step 6: Fresh host smoke: health/capabilities, `git.log`, `git.show`, and existing `git.changes`; runtime/protocol/surface remain `0.1` / `2026-07-28` / `0.4`.**
- [ ] **Step 7: Verify `v0.1^{}` unchanged.**
- [ ] **Step 8: Only after these host gates, merge and perform post-merge baseline freeze/cleanup.**
