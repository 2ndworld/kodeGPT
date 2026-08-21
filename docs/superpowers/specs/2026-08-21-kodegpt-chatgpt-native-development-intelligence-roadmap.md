# KodeGPT ChatGPT-Native Development Intelligence Roadmap

Date: 2026-08-21
Status: architecture roadmap approved in chat; implementation is decomposed into independently valuable subprojects
Current baseline: semantic surface `0.18` with 76 public MCP tools

## 1. Objective

Evolve KodeGPT as a **high-leverage development substrate for ChatGPT**, not as a second autonomous coding agent. ChatGPT remains the reasoning, programming, planning, visual interpretation, web-research, and orchestration layer. KodeGPT remains the deterministic local execution, repository intelligence, evidence, continuity, and authority plane.

The target is to outperform CodexPro materially and approach Codex CLI on end-to-end application-development outcomes while preserving the architectural advantage of having ChatGPT as the host.

## 2. Core architectural rule

```text
User
  |
  v
ChatGPT / GPT-5.6 Sol High
  reasoning / coding / debugging / planning / orchestration
  |
  +--> KodeGPT capability discovery + Agent Skills
  |
  +--> Repository Intelligence
  |      structural code graph
  |      targeted context slices
  |      impact evidence
  |
  +--> Execution Authority
  |      file / process / verification / Git
  |      preview / browser / visual / GitHub / CI
  |
  +--> Evidence Plane
  |      source-state binding
  |      freshness / staleness
  |      artifacts / failure evidence
  |
  +--> Development Continuity
         checkpoint / milestones / resume synthesis
```

KodeGPT must not duplicate capabilities that ChatGPT already owns well.

## 3. Explicit non-goals

Do not add merely for competitive parity:

- a native LLM/model runtime;
- `agent.spawn`, an agent scheduler, or a KodeGPT subagent runtime;
- `workflow.run`, `skill.run`, a workflow engine, task queue, or autonomous repair loop;
- a conversation/session transcript database;
- generic `provider.invoke` or arbitrary HTTP authority;
- an in-process executable plugin VM;
- a vector database or embedding service for the current bounded capability catalog;
- a permanent language-server daemon farm;
- language-specific public MCP tool families;
- arbitrary browser/computer-use authority;
- Codex CLI as a KodeGPT execution dependency.

These remain excluded unless a later measured user need demonstrates that host-owned reasoning and existing typed execution cannot solve the problem cleanly.

## 4. Prioritized subprojects

### P0-A — Semantic Repository Intelligence + Context Slicing

Replace the current heuristic symbol/reference understanding with bounded parser-backed structural analysis and use the resulting graph to produce smaller, more precise `context.build` evidence.

Goals:

- structural definitions/references where supported;
- import/module/dependency relationships with explicit precision;
- language support added incrementally based on measured use;
- exact lexical fallback remains available;
- `code.search`, `code.impact`, `workspace.inspect`, and `context.build` remain the primary public tools;
- no LSP daemon or new public tool is required for v1;
- context prefers relevant symbol/region slices over whole-file payloads when structural evidence is available.

### P0-B — Evidence Freshness + Source-State Binding

Bind local verification/runtime/UI evidence to the exact source state it observed.

At minimum model a bounded source-state reference containing the current `HEAD` OID and `git.changes.fingerprint`. Evidence-producing operations can then report whether their evidence still matches the current state instead of forcing ChatGPT to infer freshness conversationally.

Primary targets:

- `verify.run`;
- verification-like `process.run` evidence where practical;
- preview creation;
- browser/visual evidence inherited from preview state;
- final-review summaries.

No autonomous rerun is introduced. ChatGPT decides whether stale evidence needs renewal.

### P0-C — Continuity v2 + Resume Intelligence

Keep development continuity separate from conversation persistence.

Extend native continuity with:

- a small bounded milestone history rather than a task database;
- resume synthesis that reconciles checkpoint state with current Git/workspace/process/preview/PR/CI evidence;
- a `context.build` resume intent or equivalent additive input rather than a new session tool family.

The result should detect stale or superseded checkpoints instead of treating them as current truth.

### P0-D — Host-Orchestrated Parallel Verification

Exploit existing background process/verification operations before considering multiple LLM agents.

The application-development skill should allow independent broader gates such as test, typecheck, lint, and build to run concurrently after focused proof succeeds. ChatGPT owns fan-out, evidence interpretation, cancellation, and repair decisions.

No scheduler or workflow engine is added.

### P0-E — Bounded CI Long-Polling

Consider an optional `waitMs` on existing `ci.status`, analogous to existing `process.status(waitMs)`, to reduce manual continuation turns while retaining bounded, user-visible host orchestration.

No background CI monitor, queue, or indefinite polling is introduced.

### P1-A — Capability Intelligence v2

Extend action metadata only where it gives ChatGPT measurable routing leverage:

- preconditions;
- side-effect/effect class;
- evidence produced;
- recovery hints;
- optional coarse cost/latency class.

Discovery remains explainable and deterministic. It never executes discovered actions automatically.

### P1-B — Dev Console v2

Turn the existing MCP Apps Dev Console into a development cockpit built from already-observed/cached state:

- workspace / branch / head / dirty state;
- current checkpoint or objective;
- verification evidence with freshness;
- active process/preview;
- PR and CI summary when already known;
- bounded next-action hints derived from explicit state, not hidden workflow execution.

`console.state` must not become a synchronous Git/network crawler.

### P1-C — Skill Ecosystem Lifecycle

Keep Agent Skills as instructions/resources rather than executable plugins. Improve operator-side lifecycle and interoperability through CLI/local management such as search/install/update/remove/doctor/sync only where existing sources can support it safely.

Runtime use continues through `system.discover`, `skill.list`, `skill.inspect`, and `skill.load`; avoid multiplying public MCP mutation tools unnecessarily.

### P1-D — GitHub Review Feedback Loop

Close the end-to-end pull-request loop with compact typed support for review threads/comments/requested changes and bounded response/resolution where the GitHub provider supports it. Prefer a small coherent contract over mirroring the GitHub API as many tools.

### P1-E — Round-Trip Reduction

Reduce ChatGPT tool-call overhead without duplicating semantics:

- bounded search context lines / source snippets;
- optional line-oriented file reads while retaining byte-oriented reads;
- composite context output that already contains the exact relevant slices.

### P2 — Conditional expansions

Only after dogfooding proves concrete need:

- operator-approved browser targets beyond preview origin;
- interactive PTY/stdin lifecycle;
- out-of-process MCP Plugin Gateway for integrations that cannot be connected directly to ChatGPT while preserving KodeGPT authority.

## 5. Priority rationale

The current KodeGPT execution/control plane is already mature. The highest remaining leverage comes from improving what ChatGPT receives **before** it edits and from making verification evidence provably tied to the state **after** it edits.

Therefore semantic repository intelligence and evidence freshness outrank adding more execution primitives.

Native multi-agent execution is deliberately not P0. Independent machine work such as test/typecheck/lint/build can already be parallelized with background processes at far lower architectural cost. Multiple LLM workers remain a host concern until evidence demonstrates that this is insufficient.

## 6. Delivery decomposition

Each subproject must have its own design/spec, implementation plan, tests, release evidence, and go/no-go gate. Completion of one subproject does not authorize the next automatically.

Recommended order:

1. P0-A Semantic Repository Intelligence + Context Slicing.
2. P0-B Evidence Freshness + Source-State Binding.
3. P0-C Continuity v2 + Resume Intelligence.
4. P0-D Host-Orchestrated Parallel Verification.
5. P0-E Bounded CI Long-Polling.
6. Re-score and dogfood before starting P1.
7. P1 items ordered by observed development friction, not competitive checkbox parity.

## 7. Success metrics

The program should be judged by development outcomes, not tool count.

Measure where practical:

- number of tool calls before first correct patch;
- context bytes/tokens supplied for representative tasks;
- top-k relevance of selected files/symbols/tests;
- false-positive/false-negative symbol/reference relationships;
- percentage of final claims backed by fresh evidence;
- number of manual continuation turns during normal PR/CI delivery;
- first-pass verification success after implementation;
- regression rate caused by missing dependents/tests;
- time and tool calls needed to resume work in a fresh ChatGPT conversation.

Do not ship a subsystem solely because it increases a comparison score.

## 8. Immediate next subproject

The first implementation candidate is **P0-A Semantic Repository Intelligence + Context Slicing** because source inspection confirms the current structural analysis is intentionally lightweight and heuristic while the rest of KodeGPT's execution/evidence surface is already comparatively mature.
