# KodeGPT Application Development Capability Roadmap — Audited

Date: 2026-08-18
Baseline: `18748701c0558d3a86d3be20e4e7630e80532572`

## Goal

Improve KodeGPT + GPT Web for end-to-end application development by closing the local application-runtime feedback loop while preserving KodeGPT's current product class: typed, bounded, auditable capabilities controlled by an external reasoning host.

## Architecture rule

KodeGPT owns deterministic local execution and evidence. GPT Web/Codex/CodexPro owns reasoning, design interpretation, agent delegation, and planning. New capability must reuse the current workspace/process/artifact/provider authority rather than creating a second execution, browser, provider, or agent framework.

## Phase 1 — Bounded Preview Lifecycle — IMPLEMENT NOW

Public surface:
- `preview.start`
- `preview.inspect`
- `preview.stop`

Behavior:
- caller supplies workspace, existing allowed logical executable/argv, explicit port, optional cwd/env, optional request path and bounded readiness wait;
- start always delegates process creation to existing `ExecutionManager` with `background=true`;
- preview identity binds exactly one workspace + process operation + loopback port/path;
- readiness probes only `127.0.0.1` using HTTP HEAD and never returns response bodies/headers;
- inspect accepts only an opaque preview ID, never caller-selected host/URL;
- stop delegates to existing process cancellation and removes the preview record after successful cancellation/status resolution;
- preview state is ephemeral; no database or second supervisor;
- workspace process cancellation remains the final process lifecycle authority.

No Rust protocol change, no new dependency, no arbitrary host networking, no port auto-discovery, no restart tool.

Expected public surface after completion: `0.11`, 65 tools.

## Phase 2 — Preview-Scoped Browser Evidence

Prerequisite: Phase 1 stable and benchmarked through real web-app dogfood.

Candidate fixed semantic surface:
- `browser.openPreview` — open the exact origin from a live preview ID;
- `browser.inspect` — bounded title/URL/DOM-accessibility summary;
- `browser.click` — selector/accessibility-target interaction inside the preview origin;
- `browser.type` — bounded text input inside the preview origin;
- `browser.screenshot` — PNG artifact;
- `browser.console` — bounded console errors/warnings;
- `browser.networkFailures` — bounded failed-request evidence.

Constraints:
- no arbitrary URLs;
- same preview origin only, except static asset/subresource requests naturally initiated by the page under current network policy;
- no desktop or OS control;
- no arbitrary JavaScript/evaluate tool in the first version;
- browser process/session ephemeral and killed with its owning workspace/preview;
- use Playwright/CDP only after a dependency/spike confirms packaging and sandbox compatibility.

## Phase 3 — Visual Verification

Prerequisite: screenshot evidence from Phase 2.

Candidate capabilities:
- capture a fixed responsive viewport matrix;
- compare a current screenshot artifact with an explicit reference artifact;
- return dimensions, changed-pixel ratio, threshold result, and artifact references;
- keep image interpretation in GPT vision rather than adding computer vision reasoning to KodeGPT.

Constraints:
- no persistent visual-baseline database initially;
- no automatic acceptance/update of reference images;
- no screenshot acquisition path separate from the preview-scoped browser.

## Phase 4 — Typed Preview Deployment Adapters

Prerequisite: local preview loop proven useful and a concrete deployment provider selected.

Implementation strategy:
- extend the existing private Provider Gateway with one separately admitted provider-specific adapter at a time;
- semantic operations only, e.g. `deploy.preview.create`, `deploy.preview.inspect`, `deploy.preview.logs` if justified;
- fixed provider origins, JIT credentials, bounded requests/results, durable audit, redaction, and single-attempt mutation semantics;
- ambiguous deployment creation outcomes are reconciled, never blindly retried;
- no public generic `provider.invoke` or generic HTTP.

## Explicit non-goals

The audited roadmap does not add:
- autonomous `agent.run`;
- task graph or subagent scheduler;
- worktree-per-agent orchestration;
- model inference/gateway;
- core Figma/design connector;
- arbitrary browser navigation;
- desktop/computer-use authority;
- generic HTTP/provider invocation;
- a second process supervisor;
- persistent browser/preview state.

## Delivery discipline

Each phase is its own spec, plan, branch/worktree, TDD cycle, review, PR/CI, merge, release/cutover, and live dogfood. Do not start the next phase merely because the previous code compiles; require actual application-development evidence that the next layer is necessary.