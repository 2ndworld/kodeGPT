# KodeGPT Trusted Process Policy v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the built-in `trusted` profile expose `bash` and `sh` as sandboxed high-agency process entrypoints while preserving all existing Bubblewrap, retained-root, environment, audit, and cancellation boundaries.

**Architecture:** Keep the existing `process.run` contract and Rust execution pipeline unchanged. Add `bash` and `sh` only to the TypeScript `trusted` preset, then prove end-to-end that nested commands can run inside Bubblewrap without top-level executable allowlisting while host filesystem/environment authority remains unavailable.

**Tech Stack:** TypeScript, Vitest, Rust, Cargo tests, existing KodeGPT runtime/Bubblewrap process sandbox.

## Global Constraints

- Only the built-in `trusted` profile gains `bash` and `sh`.
- `observe` and `develop` remain unchanged and do not gain shell executables.
- `process.run`, `process.status`, and `process.cancel` remain the only public process tools.
- No protocol schema change and no MCP surface-version bump.
- Top-level `process.run.logicalExecutable` remains allowlisted; nested commands launched by trusted `bash`/`sh` are not individually revalidated by KodeGPT.
- `inheritEnv` remains `false`; reserved environment values remain KodeGPT-controlled.
- Bubblewrap retained-root workspace isolation, read-write semantics for trusted, controlled `PATH`, private `HOME`, network mode, process registry, spool, cancellation, and durable audit lifecycle remain unchanged.
- No automatic host `$HOME`, writable host root, Docker socket, arbitrary device, sudo, or host-admin authority.
- No new dependencies.

---

### Task 1: Add RED trusted-shell profile and full-stack acceptance tests

**Files:**
- Modify: `packages/profiles/src/resolve-profile.test.ts`
- Modify: `tests/integration/full-stack.test.ts`

**Interfaces:**
- Consumes: `getProfilePreset(name)` and existing MCP `process.run` flow.
- Produces: regression requirements that fail on the current preset because `bash`/`sh` are absent.

- [ ] **Step 1: Add profile-contract tests before production changes**

Add a test that reads all three presets and asserts:

```ts
expect(getProfilePreset("trusted").allowedExecutableNames).toEqual(
  expect.arrayContaining(["bash", "sh"])
);
expect(getProfilePreset("develop").allowedExecutableNames).not.toContain("bash");
expect(getProfilePreset("develop").allowedExecutableNames).not.toContain("sh");
expect(getProfilePreset("observe").allowedExecutableNames).not.toContain("bash");
expect(getProfilePreset("observe").allowedExecutableNames).not.toContain("sh");
```

- [ ] **Step 2: Run the profile test and verify RED**

Run:

```bash
pnpm vitest run packages/profiles/src/resolve-profile.test.ts
```

Expected: FAIL because the current `trusted` preset does not contain `bash` or `sh`.

- [ ] **Step 3: Add an end-to-end trusted-shell test before production changes**

Inside the existing full-stack trusted-workspace lifecycle, create an additional host-only temporary root/file and invoke:

```ts
process.run({
  workspaceId: openedA.id,
  logicalExecutable: "bash",
  argv: [
    "-lc",
    "git --version; printf 'shell-write\\n' > shell-created.txt; printf 'HOME=%s\\nPATH=%s\\n' \"$HOME\" \"$PATH\"; test ! -e <host-only-path>"
  ],
  background: false
})
```

Assert:

- state is `completed` and exit code is `0`;
- stdout contains `git version`, proving a nested system executable not present in the top-level trusted allowlist can run;
- stdout reports `HOME=/home/kodegpt`;
- stdout reports the controlled system path rather than the host user's environment;
- `shell-created.txt` exists in the trusted workspace with `shell-write\n`;
- the host-only path remains invisible to the shell.

Do not add `git` to the trusted top-level executable allowlist.

- [ ] **Step 4: Run the full-stack test and verify RED**

Run:

```bash
pnpm vitest run tests/integration/full-stack.test.ts
```

Expected: FAIL at the new trusted `bash` process call with executable-policy denial.

---

### Task 2: Enable trusted shell with the minimal preset change

**Files:**
- Modify: `packages/profiles/src/presets.ts`

**Interfaces:**
- Consumes: existing `RuntimePolicy.allowedExecutableNames` contract.
- Produces: trusted preset allowlist containing existing entries plus `bash` and `sh`; no change to other policy fields.

- [ ] **Step 1: Make the minimal production change**

Change only the `trusted` preset executable list to:

```ts
allowedExecutableNames: [
  "bash",
  "cargo",
  "node",
  "npm",
  "npx",
  "pnpm",
  "python3",
  "rustc",
  "sh"
],
```

Keep `observe` and `develop` unchanged.

- [ ] **Step 2: Run the profile test and verify GREEN**

Run:

```bash
pnpm vitest run packages/profiles/src/resolve-profile.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the full-stack acceptance and verify GREEN**

Run:

```bash
pnpm vitest run tests/integration/full-stack.test.ts
```

Expected: PASS, including trusted shell nested-command/workspace/boundary assertions.

- [ ] **Step 4: Run focused Rust process tests**

Run:

```bash
cargo test -p kodegpt-runtime process::tests
```

Expected: PASS with existing sandbox/cancellation behavior unchanged.

- [ ] **Step 5: Review the implementation diff**

Confirm the production diff is restricted to the trusted preset and does not alter Rust sandbox resolution, environment handling, mounts, network mode, process registry, audit, or cancellation code.

- [ ] **Step 6: Commit the implementation**

```bash
git add packages/profiles/src/presets.ts packages/profiles/src/resolve-profile.test.ts tests/integration/full-stack.test.ts
git commit -m "feat: add trusted shell process policy"
```

---

### Task 3: Reconcile architecture/tracker documentation and policy regressions

**Files:**
- Modify: `docs/architecture/README.md`
- Modify: `docs/implementation/v0.1-execution-tracker.md`
- Modify: `tests/security/process-policy.test.ts` only if needed to encode a stable source-level invariant not already covered behaviorally.

**Interfaces:**
- Consumes: approved design spec and accepted implementation behavior.
- Produces: discoverable canonical documentation of Trusted Process Policy v2 without rewriting historical chronology.

- [ ] **Step 1: Update architecture index**

Add Trusted Process Policy v2 as the current trusted-process authority reference, pointing to:

```text
docs/superpowers/specs/2026-08-17-kodegpt-trusted-process-policy-v2-design.md
docs/superpowers/plans/2026-08-17-kodegpt-trusted-process-policy-v2.md
```

Describe it as a trusted-only `bash`/`sh` escape hatch that preserves Bubblewrap/retained-root isolation.

- [ ] **Step 2: Append tracker closure without rewriting historical entries**

Add a dated/current entry stating that Trusted Process Policy v2 is implemented on the feature branch, with trusted-only shell entrypoints and unchanged observe/develop behavior. Record exact verification evidence after Task 4 completes.

- [ ] **Step 3: Run focused source/security regression**

Run:

```bash
pnpm vitest run tests/security/process-policy.test.ts packages/profiles/src/resolve-profile.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit documentation reconciliation**

```bash
git add docs/architecture/README.md docs/implementation/v0.1-execution-tracker.md docs/superpowers/plans/2026-08-17-kodegpt-trusted-process-policy-v2.md
git commit -m "docs: track trusted process policy v2"
```

---

### Task 4: Full verification and acceptance evidence

**Files:**
- Modify only if verification finds a real defect caused by this feature; any fix must start with a failing regression test.

**Interfaces:**
- Consumes: complete feature branch.
- Produces: evidence that Trusted Process Policy v2 is compatible with the rest of KodeGPT.

- [ ] **Step 1: Typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 2: Build**

Run:

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 3: Full Vitest suite**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 4: Rust formatting and workspace tests**

Run:

```bash
cargo fmt --all -- --check
```

Expected: PASS.

Then run:

```bash
cargo test --workspace
```

Expected: PASS.

- [ ] **Step 5: Security and forbidden-pattern verification**

Run:

```bash
pnpm test:security
```

Expected: PASS.

Then run:

```bash
pnpm verify:forbidden
```

Expected: PASS.

- [ ] **Step 6: Package smoke**

Run:

```bash
pnpm verify:package
```

Expected: PASS through clean-install package smoke.

- [ ] **Step 7: Final diff review**

Use the review surface to confirm:

- no protocol schema changed;
- no public MCP tool changed;
- no surface-version bump occurred;
- no environment inheritance or host filesystem authority was added;
- no dependency was added;
- production behavior change is limited to the `trusted` preset executable allowlist.

- [ ] **Step 8: Record exact verification evidence in the tracker if the earlier tracker entry used provisional wording**

Update only the new Trusted Process Policy v2 tracker paragraph with actual pass counts/results. Do not alter historical chronology.

- [ ] **Step 9: Commit any verification-only documentation correction**

If Task 8 changes tracked documentation:

```bash
git add docs/implementation/v0.1-execution-tracker.md
git commit -m "docs: close trusted process policy v2 verification"
```
