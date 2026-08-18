# Audit — Initial Application Development Roadmap

Date: 2026-08-18

## Audit criteria

The initial plan was checked against current source, architecture authority, product boundaries, existing capability reuse, implementation dependency order, security/authority growth, and whether a feature belongs in KodeGPT or in the reasoning host.

## Findings

### 1. Browser before preview is dependency inversion — HIGH

A browser session needs a known application origin, lifecycle, and readiness signal. Building browser control first would force browser code to invent its own dev-server lifecycle or duplicate `process.run` behavior. Preview lifecycle must come first and become the only source of local application origins admitted to later browser tooling.

Action: move Preview Lifecycle to Phase 1 / first implementation target.

### 2. Agent/worktree orchestration changes the product class — HIGH

Current architecture explicitly keeps reasoning/planning and agent execution in ChatGPT/Codex/other hosts. A task graph, worker registry, delegated reviewer/tester agents, or worktree-per-agent scheduler would turn KodeGPT into a second autonomous coding-agent harness and duplicate capabilities already present in Codex/CodexPro/host workflows.

Action: remove Agent/Worktree Orchestration from the KodeGPT core roadmap. Keep ordinary Git/worktree correctness as a capability concern when independently justified, but orchestration remains host-owned.

### 3. Core Figma/design integration is mostly redundant — MEDIUM/HIGH

GPT Web and Codex can already consume design/Figma context through host-side plugins/apps/skills. KodeGPT gains little by owning a second design connector unless a concrete local-runtime capability needs it. The useful KodeGPT responsibility is returning application runtime and visual evidence, not interpreting design systems.

Action: remove Design Integration from the core roadmap. If a future provider is needed, admit it as a separately justified typed provider rather than a standing core phase.

### 4. Browser authority must be preview-scoped — HIGH

A generic browser/computer-use surface would conflict with the current deferred desktop/computer-use boundary and unnecessarily broaden authority. Application development only needs control over origins created by KodeGPT-managed previews.

Action: later browser capability may navigate only the exact loopback origin owned by a live preview session. No arbitrary URL, no desktop control, no generic browser scripting endpoint.

### 5. Preview lifecycle can reuse existing process authority — HIGH positive finding

Current `ExecutionManager` already provides background start, status, cancellation, artifact output, workspace binding, audit, Bubblewrap, and workspace-close cancellation. A preview manager can be a thin Node-level orchestration layer with no Rust protocol change and no second process supervisor.

Action: implement preview as composition, not a new runtime execution primitive.

### 6. Generic port discovery is unnecessary for the first slice — MEDIUM

Automatically discovering ports from arbitrary stdout/framework conventions would add heuristics and framework coupling. A caller-specified port is deterministic, works with existing dev-server CLI flags, and lets KodeGPT probe a fixed loopback endpoint.

Action: v1 requires an explicit port. Auto-discovery is deferred until evidence proves it materially improves workflows.

### 7. Restart is redundant in v1 — MEDIUM

`restart` can be expressed as stop + start and adds another mutating public tool plus ambiguous configuration retention semantics.

Action: v1 exposes start/inspect/stop only.

### 8. Deploy should reuse Provider Gateway — HIGH

The repository already has bounded provider identity, network policy, credential brokers, response budgets, mutation outcome handling, and audit. A separate deploy transport would be redundant and risky.

Action: deployment remains later and provider-specific through the existing gateway; no generic deployment HTTP/API tool.

### 9. Visual verification depends on browser evidence — MEDIUM

Screenshot comparison before there is a preview-scoped browser would create a second screenshot acquisition path.

Action: browser evidence precedes visual verification.

## Revised principles

- compose existing authority before adding new runtime primitives;
- only KodeGPT-owned preview origins can become browser targets;
- no agent scheduler, model runtime, Figma core, desktop automation, or generic HTTP;
- host interprets screenshots/designs; KodeGPT returns bounded evidence;
- typed public tools remain small and semantic;
- mutations stay auditable and workspace-bound;
- introduce no new production dependency for Preview Lifecycle v1.

## Audited priority

1. Bounded Preview Lifecycle — implement now.
2. Preview-Scoped Browser Evidence.
3. Visual Verification.
4. Typed Preview Deployment adapters.

Removed from core roadmap: Agent/Worktree Orchestration and Design Integration.