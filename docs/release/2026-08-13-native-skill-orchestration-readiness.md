# KodeGPT Native Skill Execution Orchestration Readiness

Status date: 2026-08-13.

## Scope

This report records the bounded **Native Skill Execution Orchestration — advisory/read-only capability planning** implementation. It is not provider interoperability, skill execution, an autonomous agent, or a new security authority.

Baseline fork:

```text
main = origin/main = 8d0ad1b465bde19ea0297fdbeb7865950f17cb12
branch = feat/native-skill-execution-orchestration
```

Implementation evidence commits before this documentation closure:

```text
6c40020 docs: reconcile native skill orchestration plan
5fe8479 feat(capabilities): describe native skill semantics
1a8616e feat(skills): add deterministic capability planner
3f11fdf feat(skills): expose advisory capability plans
e700b36 feat(mcp): clarify native skill orchestration
b7b6f9a test(skills): prove advisory orchestration boundaries
```

The exact final candidate SHA must be taken from Git after the documentation commit and verification run; this file intentionally does not embed a self-referential commit identity.

## Baseline release closure

Before feature work, the exact `main@8d0ad1b465bde19ea0297fdbeb7865950f17cb12` baseline was re-audited and found clean with `origin/main` at the same SHA and only the main worktree present.

The exact baseline passed the current deterministic release matrix, including frozen install, Rust formatting, TypeScript typecheck/build/tests, protocol/integration/security/isolation/acceptance suites, mandatory Bubblewrap sandbox tests, Rust workspace tests, forbidden scan, package verification, record-only performance baseline, and the passive Pranikah before/after isolation comparison (`guard unchanged`). GitHub CI for the exact baseline was also successful.

The existing annotated `v0.1` tag already points to an older historical release commit. It was not moved, overwritten, or replaced.

The preserved planning-era safety stash was audited zero-loss: its plan is byte-identical to current committed content, while its tracker/design blobs are byte-identical to the historical committed state at `f09d5bf`, which is an ancestor of current main. Connector safety blocked `git stash drop`; the stash remains preserved and does not block feature development.

## Advisory contract

`skill.inspect` now includes a bounded `capabilityPlan` derived from the exact selected live or pinned skill bundle and the existing native capability registry.

The plan contains only deterministic advisory semantics:

- compatibility classification copied from the existing compatibility report;
- relevant existing native capability IDs;
- missing capabilities;
- external provider requirements as advisory strings;
- blocked semantics;
- one declarative purpose row per suggested native capability;
- explicit truncation state/reasons for bounded finding arrays.

`nativeCapabilities` and guidance are bounded by the current native capability registry. Missing, external, and blocked finding arrays are independently capped at 64 entries after bytewise sort/deduplication. Truncation never changes the compatibility verdict.

The plan is not permission and cannot execute a capability. Actual host operations still require separate ordinary KodeGPT tool calls and remain subject to normal trust, policy, Rust authority, sandbox, filesystem, and audit enforcement.

## Security boundary retained

This phase adds no:

- `skill.run`;
- provider invocation/gateway;
- Codex or Claude execution;
- source/pin/workspace-trust mutation through MCP;
- generic shell or tunnel abstraction;
- network/filesystem authority;
- credential/session forwarding;
- desktop/computer-use authority.

The public skill inventory remains exactly:

```text
skill.list
skill.inspect
skill.load
```

`skill.load` returns requested UTF-8 resources as data/text only and does not execute scripts.

MCP protocol remains `2026-07-28`. The additive advisory result stays within semantic surface `0.3`; no new MCP `outputSchema` was introduced solely for this field because the existing skill tools do not advertise one.

## Focused implementation evidence

The implementation was developed with RED → GREEN focused tests.

Current focused green evidence includes:

- capability semantic registry + existing contracts: 9/9 PASS;
- planner + compatibility: 17/17 PASS;
- live/pinned catalog + public tool adapter: 21/21 PASS;
- full `@kodegpt/skills` package: 86/86 PASS;
- MCP skill/structured/server focus: 18/18 PASS;
- production skill interoperability + security invariants: 7/7 PASS;
- official forbidden-pattern scan: PASS.

The production integration fixture independently demonstrates:

- `NATIVE` guidance for an ordinary portable skill;
- `PROVIDER_REQUIRED` for an explicitly declared provider while exposing only `provider:<name>` as an external requirement;
- `UNSUPPORTED` for Codex/subagent execution semantics with stable blocked semantics;
- script resources returned as text without creating their execution marker;
- absence of skill/provider execution or mutation tools from the real MCP inventory;
- host/state/source authority paths absent from public inspection output.

Pinned inspection is derived from the immutable pinned `SKILL.md`; mutating the live skill produces different advisory guidance without altering the pinned plan.

## Host acceptance status

**BLOCKED / pending for this exact advisory candidate.**

The current execution environment used to implement and verify this branch does not expose the `@KodeGPT` ChatGPT action namespace, so a real ChatGPT-host `skill.inspect.capabilityPlan` observation cannot be manufactured or inferred from local/production-MCP tests.

Before merge:

1. deploy the exact candidate;
2. refresh/rescan the ChatGPT app actions;
3. confirm healthy `system.health` and semantic surface `0.3`;
4. confirm the three read-only skill tools and existing `skill.list.compatibility` enum;
5. inspect a live native fixture and observe the advisory `capabilityPlan` with no path/security leakage;
6. exercise one suggested native capability through a separate ordinary KodeGPT call;
7. load a script resource and prove it remains data/text only;
8. confirm source/pin/trust/provider execution authorities remain absent.

Do not mark this host gate PASS from server tests.

## Remaining release/integration gates

After this documentation closure, run the full candidate matrix on the exact final branch commit and keep the working tree clean. Candidate preservation/push and PR creation may proceed once local gates are green, but the PR must not be merged until the exact-candidate host acceptance above is observed PASS.

Provider interoperability remains a separate future security/design phase.
