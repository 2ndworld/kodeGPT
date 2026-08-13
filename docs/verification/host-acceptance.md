# KodeGPT Host Acceptance Runbook

Status date: 2026-08-13.

This is the canonical manual acceptance runbook for proving an actual ChatGPT Web → KodeGPT path. It complements deterministic protocol/integration/security suites; it does not replace them.

## Acceptance rule

A row is `PASS` only when the named layer was directly observed. Do not infer ChatGPT-host behavior from local tests, tool annotations, or server implementation.

Keep machine-specific paths, connector credentials, query-bearing Server URLs, zrok account data, and local evidence files outside Git.

## Architecture under test

```text
ChatGPT Web
    ↓
public HTTPS endpoint / configured private connection
    ↓
KodeGPT MCP TypeScript layer
    ↓
Rust runtime / policy / filesystem authority
    ↓
locally trusted workspace or skill source
```

For the managed personal/development path, KodeGPT keeps the MCP listener on `127.0.0.1` and supervises zrok as the reachability layer. zrok does not grant workspace or filesystem authority.

## 1. Prerequisites

- Linux host supported by the current release candidate.
- Node.js and pnpm versions satisfying the repository release checklist.
- Rust toolchain satisfying the repository release checklist.
- Required Bubblewrap/AppArmor security prerequisites healthy.
- `zrok2` installed and enabled when using managed zrok exposure.
- An existing reserved zrok v2 name. KodeGPT does not create or manage the namespace/name.
- The exact release-candidate commit checked out in an isolated worktree or verified clean release checkout.
- ChatGPT custom MCP app/connector configured for the intended endpoint and authentication mode.

If the MCP tool surface changed since the ChatGPT app/connector was last approved or scanned, refresh/rescan its actions before host testing. ChatGPT may otherwise retain a previously approved tool snapshot. If the expected tools are still absent from host discovery, mark those host rows `BLOCKED`; do not substitute a local MCP test.

## 2. Freeze the candidate identity

Record locally:

```bash
git branch --show-current
git rev-parse HEAD
git status -sb
```

Requirements:

- working tree is clean before the acceptance run;
- exact commit is recorded in the local evidence record;
- the candidate is built from that exact checkout, not from an older globally installed `kodegpt` binary.

Build and run the deterministic precondition gates at minimum:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:integration
pnpm test:acceptance
cargo test --workspace
pnpm build
```

Use the complete release matrix in `docs/release/v0.1-checklist.md` before a release-readiness verdict.

## 3. Start the exact candidate

For the managed zrok path, start the repository-built/installed candidate corresponding to the recorded commit:

```bash
kodegpt expose zrok --name <namespace:name>
```

Expected properties:

- KodeGPT listens only on loopback;
- public endpoint ends in `/mcp`;
- exposure target is the loopback listener;
- existing connector credential is reused, or a newly issued query-bearing ChatGPT Server URL is shown only for onboarding;
- the query-bearing URL is treated as a secret and is not copied into Git or the acceptance report.

Record the connection path as:

```text
zrok-public-https-query-credential
```

when that path is used.

## 4. Prove reachability and authentication separately

From the host, send a syntactically valid MCP POST to both the loopback endpoint and public endpoint without a connector credential. The request must be rejected with `401`.

Do not use a bare `GET /mcp` as authentication evidence: a method-level rejection such as `405` only proves HTTP method handling.

Then invoke `system.health` and `system.capabilities` from ChatGPT through the configured KodeGPT app/connector.

Expected:

- authenticated host call succeeds;
- `auditHealthy=true`;
- filesystem boundary is available;
- production test methods are disabled;
- MCP protocol is exactly `2026-07-28`;
- semantic MCP surface is exactly `0.3` for the current v0.1 baseline.

Then inspect the host-visible action inventory itself. Do not use tool count alone as evidence: verify the expected action names, confirm the three read-only skill actions are present, and confirm forbidden mutation/provider/trust authorities are absent.

## 5. Disposable workspace fixture

Create a disposable directory outside protected repositories. Initialize a tiny Git repository with a committed file containing:

```text
before-kodegpt-host-test
```

Do not use another development repository for write acceptance.

### Untrusted boundary

Before local trust is granted, call `workspace.open` from ChatGPT.

Expected: the request is rejected because the workspace is not trusted.

### Grant trust locally

Use only the local CLI:

```bash
kodegpt workspace trust <fixture-path> --ceiling trusted
```

There must be no MCP tool that creates, edits, or removes workspace trust.

### Open through ChatGPT

Call `workspace.open` through the KodeGPT connector using the trusted fixture path. Record only the public workspace ID and effective policy in evidence; do not copy private runtime capability identifiers.

## 6. Actual host read/write flow

Through ChatGPT → KodeGPT, not through the setup tool:

1. `file.read` the committed fixture and confirm `before-kodegpt-host-test`.
2. Change the file to `after-kodegpt-host-test` with an available KodeGPT write primitive.
3. `file.read` it again and verify the exact new contents.
4. If one write tool is blocked by ChatGPT host policy/confirmation behavior, record that behavior separately. A different successful write tool may prove `WRITE_OBSERVED`, but it does not make the blocked tool a pass.
5. Call `system.health` and confirm the audit sink remains healthy. Where recent audit diagnostics are exposed, confirm decision/outcome evidence for the exercised actions.

CodexPro or another local setup tool may create the fixture and independently inspect it, but the action counted as host read/write evidence must be executed by KodeGPT.

## 7. Git acceptance

Using the same disposable repository through ChatGPT → KodeGPT:

- call `git.status` and verify the modified/untracked paths are reported;
- call `git.diff` and verify the before/after text is represented correctly;
- do not push, reset, rebase, or perform destructive repository operations.

## 8. Workspace identity replacement

Close the READY fixture workspace. Outside KodeGPT, rename the original trusted directory away and create a different directory at the same visible path.

Call `workspace.open` again through ChatGPT.

Expected: fail closed because the trusted filesystem identity changed. Restore/delete the disposable fixture afterward and remove its local trust record.

## 9. Read-only skill surface discovery

Before calling skill tools, confirm the ChatGPT host currently discovers exactly the intended read-only skill surface:

- `skill.list`
- `skill.inspect`
- `skill.load`

Confirm the host-visible `skill.list` input schema has optional `compatibility` with exactly these enum values:

- `NATIVE`
- `PARTIAL`
- `PROVIDER_REQUIRED`
- `UNSUPPORTED`

Confirm the host does **not** discover:

- `skill.run`
- `skill.pin`
- `skill.unpin`
- `skill.source.add`
- `skill.source.remove`
- workspace trust mutation
- Codex/Claude/provider invocation tools

If the current ChatGPT app/connector still exposes an older frozen tool snapshot or a stale `skill.list` schema, refresh/rescan the app actions and reconnect as required by the host product. Until both the three read-only skill tools and the `compatibility` input are visible, mark the affected host action-schema scenarios `BLOCKED`. When validating a candidate that adds advisory `skill.inspect` result fields, refresh/rescan before claiming those fields are host-visible; local integration output is not a substitute for actual ChatGPT observation.

## 10. Portable live-skill fixture

Create a disposable skill source with a `SKILL.md`, a UTF-8 reference, and a UTF-8 script resource. The script may contain a harmless marker write if executed; ensure the marker does not initially exist.

Register the source through the **local CLI only**:

```bash
kodegpt skill source add <absolute-source-path>
```

Through ChatGPT:

1. `skill.list` and record the public skill ID plus compatibility classification.
2. `skill.inspect` and record the fingerprint.
3. For candidates with advisory orchestration, verify `capabilityPlan.schemaVersion == 1`, `classification` matches the skill compatibility verdict, arrays are bounded, and at least one relevant existing native capability is suggested for a native fixture.
4. Verify the inspection result does not reveal the state root, canonical source root, source capability ID, workspace/security handles, credentials, or unnecessary host path.
5. If exercising a suggested native capability, invoke it as a **separate ordinary KodeGPT tool call** and record the result; the plan itself must not execute anything.
6. `skill.load` the instructions, UTF-8 reference, and UTF-8 script resource.
7. Verify the script is returned as data/text and the side-effect marker still does not exist.

Binary/unsupported resources should be rejected according to the bounded resource contract rather than silently executed or decoded as text.

## 11. Live update

Modify the live `SKILL.md` content in the registered source without re-registering the source.

Through ChatGPT:

- inspect/list the live skill again;
- confirm a new fingerprint is observed;
- load the current live version and verify the new instructions.

Do not interpret filesystem identity replacement as a normal live update; that is a separate fail-closed case.

## 12. Pinned reproducibility

Using the **local CLI only**:

1. pin fingerprint A;
2. mutate the live skill so current fingerprint becomes B;
3. through ChatGPT confirm current live fingerprint is B;
4. load pinned fingerprint A and confirm its original contents are preserved;
5. remove or make the live source unavailable without replacing its filesystem identity;
6. confirm pinned A remains loadable from its immutable snapshot with pinned availability.

Then separately test source identity replacement. A source path replaced by a different filesystem identity must fail with `SKILL_SOURCE_IDENTITY_CHANGED`; an old pin must not weaken that security decision.

## 13. Provider-bound and unsupported skill semantics

Use fixtures that cover both cases:

- a skill with a declared provider requirement, expected to classify `PROVIDER_REQUIRED`;
- a skill that explicitly requires disallowed Codex execution/subagent-session semantics, expected to classify `UNSUPPORTED` under the current classifier.

Classification is advisory only. Confirm no provider process is launched, no Codex/Claude session is attached, no provider API is invoked, and no provider credential is forwarded.

## 14. Shutdown/restart lifecycle

Terminate the managed exposure normally (for example with `SIGTERM` to the supervising KodeGPT CLI process or interactive shutdown).

Verify:

- the KodeGPT loopback listener disappears;
- the supervised zrok share process exits;
- authenticated ChatGPT calls fail while the service is down.

Restart the exact same candidate and verify `system.health` again. Shut it down after the run unless the operator explicitly intends to keep the connector online.

## 15. Cleanup

- close any READY disposable workspace;
- locally untrust the disposable workspace;
- remove disposable workspace/skill fixtures;
- remove disposable local evidence files after they are recorded elsewhere as intended;
- stop the managed exposure and verify no orphan KodeGPT/zrok process remains;
- never commit secrets or machine-specific evidence.

## 16. Evidence matrix

Record each row as `PASS`, `FAIL`, or `BLOCKED` with one-line evidence:

| Scenario | Status | Evidence |
|---|---|---|
| Public reachability |  |  |
| Unauthorized rejection |  |  |
| Authenticated health/capabilities |  |  |
| Workspace trust denial |  |  |
| Local-only trust admission |  |  |
| File read |  |  |
| File write |  |  |
| Git status/diff |  |  |
| Audit behavior |  |  |
| Workspace identity replacement |  |  |
| `skill.list` |  |  |
| `skill.list.compatibility` host schema |  |  |
| `skill.inspect` |  |  |
| `skill.load` |  |  |
| Script non-execution |  |  |
| Live skill update |  |  |
| Pin reproducibility |  |  |
| Live-source unavailable pin fallback |  |  |
| Source identity replacement |  |  |
| MCP mutation denial |  |  |
| Provider non-execution |  |  |
| Clean shutdown |  |  |
| Restart |  |  |

Never replace a `BLOCKED` host row with a deterministic integration-test result. Record deterministic backend evidence separately.
