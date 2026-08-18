# KodeGPT Application Development Roadmap — Initial Detailed Plan

Date: 2026-08-18
Baseline: canonical `main` at `18748701c0558d3a86d3be20e4e7630e80532572`, runtime/protocol/surface `0.1 / 2026-07-28 / 0.10`.

## Goal

Close the largest remaining gaps between KodeGPT + GPT Web and a dedicated application-development agent while preserving KodeGPT as a deterministic capability substrate rather than embedding model reasoning inside the runtime.

## Initial Phase 0 — Browser/Application Runtime

Target capabilities:
- launch a local application development server;
- navigate a browser to the application;
- click and type;
- capture screenshots;
- inspect DOM/accessibility state;
- report console failures and failed network requests;
- return bounded visual/runtime evidence to the host.

Initial implementation direction:
1. add a browser session registry bound to a READY workspace;
2. use Playwright or CDP as the browser execution adapter;
3. expose typed `browser.*` operations rather than generic script execution;
4. scope browser navigation to a localhost application origin;
5. emit screenshots as KodeGPT artifacts;
6. keep browser state ephemeral and kill browser sessions on workspace close.

Acceptance:
- GPT Web can launch an app, navigate, interact, capture evidence, and diagnose a broken local page without arbitrary desktop control.

## Initial Phase 1 — Preview Lifecycle

Target capabilities:
- start a development server;
- bind the running operation to a preview identity and port;
- probe readiness;
- return a preview URL;
- inspect server state;
- stop/restart a preview;
- keep long-running development servers alive through ordinary MCP calls.

Initial implementation direction:
1. compose existing `process.run(background=true)`, `process.status`, and `process.cancel`;
2. add an in-memory preview registry;
3. probe only fixed loopback addresses;
4. do not add a second process supervisor or persistent daemon;
5. expose preview lifecycle as a small typed public surface.

Acceptance:
- dev server startup no longer requires the host to infer readiness from stdout or manually manage process operation IDs.

## Initial Phase 2 — Visual Verification

Target capabilities:
- capture deterministic screenshots at named viewports;
- compare current screenshots to bounded reference artifacts;
- return dimensions and change evidence;
- support a small responsive viewport matrix;
- let GPT vision interpret screenshots while KodeGPT only supplies evidence.

Implementation direction:
1. build on preview-scoped browser sessions;
2. emit PNG artifacts instead of embedding large bytes in MCP responses;
3. use pixel comparison only when a reference is explicit;
4. avoid a persistent visual-baseline database in v0.1.

Acceptance:
- a UI change can be verified at several viewport sizes with reproducible evidence.

## Initial Phase 3 — Deploy Adapters

Target capabilities:
- create preview deployments;
- inspect deployment state and logs/evidence;
- support Cloudflare, Vercel, and Netlify-class providers through separately admitted adapters.

Implementation direction:
1. extend the existing private Provider Gateway rather than expose generic HTTP;
2. introduce one provider at a time with fixed semantic operations;
3. use JIT credential brokers and existing audit/redaction rules;
4. make ambiguous mutation outcomes fail closed and reconcile rather than retry automatically.

Acceptance:
- the host can publish an explicit preview deployment and obtain a bounded deployment URL/status without generic provider invocation.

## Initial Phase 4 — Agent/Worktree Orchestration

Target capabilities:
- create isolated worktrees per task;
- run several tasks concurrently;
- coordinate implementer/reviewer/tester roles;
- merge approved outputs.

Initial implementation direction:
1. add a task/worktree registry;
2. expose create/status/close operations;
3. let the host assign tasks to separate agents;
4. add merge/review coordination primitives.

Acceptance:
- KodeGPT could act as a substrate for parallel coding workers.

## Initial Phase 5 — Design Integration

Target capabilities:
- ingest Figma context and design tokens;
- map design references to repository components;
- provide screenshot/reference evidence for visual parity.

Initial implementation direction:
1. add a typed Figma/design provider adapter;
2. keep design assets bounded and artifact-backed;
3. expose design context, not an autonomous design-to-code loop.

Acceptance:
- application implementation can consume structured design evidence without copying raw design-system logic into prompts.

## Initial execution order

1. Browser/Application Runtime
2. Preview Lifecycle
3. Visual Verification
4. Deploy Adapters
5. Agent/Worktree Orchestration
6. Design Integration

This document intentionally records the pre-audit plan. The audited plan is authoritative for implementation.