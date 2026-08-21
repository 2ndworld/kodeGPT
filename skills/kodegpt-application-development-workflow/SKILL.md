---
name: kodegpt-application-development-workflow
description: Use when developing, fixing, or resuming an application end to end with KodeGPT to reconcile continuity, understand the repository, implement and verify changes, check preview/browser UI and visuals, create and deliver PRs, and inspect CI evidence.
metadata:
  kodegpt:
    requires:
      actions:
        - context.build
        - workspace.inspect
        - code.search
        - code.impact
        - file.read
        - file.edit
        - file.patch
        - file.write
        - git.status
        - git.diff
        - git.changes
        - verify.list
        - verify.run
    stages:
      - id: continuity
        description: Resume and reconcile bounded prior development state when continuation is requested.
        actions:
          - context.build
          - workspace.info
          - workspace.checkpoint
          - git.status
          - git.log
      - id: repository-understanding
        description: Build target-scoped repository context and impact evidence.
        actions:
          - context.build
          - workspace.inspect
          - code.search
          - code.impact
      - id: implementation
        description: Read and modify bounded workspace files.
        actions:
          - file.read
          - file.edit
          - file.patch
          - file.write
      - id: verification
        description: Run focused proof first, then host-orchestrated parallel broader verification through existing background operations.
        actions:
          - verify.list
          - verify.run
          - process.run
          - process.status
          - process.cancel
      - id: preview
        description: Start, inspect, and stop a bounded local application preview when relevant.
        actions:
          - preview.start
          - preview.inspect
          - preview.stop
      - id: browser
        description: Gather preview-scoped browser interaction and diagnostic evidence when relevant.
        actions:
          - browser.openPreview
          - browser.inspect
          - browser.console
          - browser.networkFailures
          - browser.click
          - browser.type
          - browser.screenshot
      - id: visual
        description: Gather responsive visual evidence and compare explicit captures when relevant.
        actions:
          - visual.captureMatrix
          - visual.compare
      - id: git-delivery
        description: Isolate, review, commit, and publish repository changes when delivery requires it.
        actions:
          - git.branchCreate
          - git.branchSwitch
          - git.worktreeCreate
          - git.worktreeRemove
          - git.stage
          - git.commit
          - git.push
      - id: pull-request
        description: Create and inspect a pull request when remote review is required.
        actions:
          - github.pr.create
          - github.pr.inspect
      - id: ci
        description: Inspect and reconcile remote CI after delivery.
        actions:
          - ci.status
          - ci.runs
          - ci.run
          - ci.failure
          - ci.cancel
          - ci.rerun
---

# KodeGPT Application Development Workflow

## Ownership

**Host owns orchestration.** Interpret the user's intent and acceptance criteria, choose only the stages that apply, sequence explicit KodeGPT calls, interpret returned evidence, and keep conversational identifiers such as preview, PR, and CI run IDs. KodeGPT remains the typed authority for every operation; loading this skill grants no execution permission. Do not invent `workflow.run` or `skill.run`, and do not delegate the workflow to another execution agent.

When isolated branch work materially helps, the host may explicitly compose `git.branchCreate` followed by `git.worktreeCreate`, then trust/open the returned `.worktrees/<name>` child through the normal workspace control plane. Isolation is optional, never automatic. Close the child before returning to the parent for `git.worktreeRemove`; delete the branch separately only when normal Git lifecycle evidence says that is safe. Do not treat these tools as an agent/worktree scheduler.

## Resume / continuation

When the user asks to continue, resume, or lanjutkan prior work, start with `context.build(intent="resume")` for the active READY workspace. Use its normal repository context together with the additive resume synthesis; do not separately rescan Git merely to reconstruct the same source state. If deeper raw checkpoint details are needed, `workspace.info` remains available as a bounded read.

Interpret the resume relation deterministically. **fresh** means the checkpoint source state still matches current Git evidence and its continuation hints may be used as current evidence. **stale** means repository state moved; reconcile current files/Git/evidence before trusting next actions. **superseded** means the checkpoint describes history that has been replaced or diverged and should be treated as historical hints only. **unverifiable** means required evidence is unavailable or legacy; make the current repository authoritative and state what could not be verified. Never infer freshness from timestamps, branch names, commit messages, or conversation memory.

Read `.ai-bridge/current-plan.md` only when there is explicit external-agent or cross-chat handoff context that makes that coordination file relevant; consult `.ai-bridge/agent-status.md`, `decisions.md`, or `open-questions.md` only when they are relevant to that active handoff. Treat an explicit `CLOSED`, `RECONCILED`, `CLEAN`, or equivalent terminal state as terminal and do not invent a new phase merely to keep working. Do not create or update a workspace checkpoint automatically merely because this workflow is running; checkpoint mutation is an explicit bounded continuity action, not a conversation log or task scheduler.

## Adaptive flow

Use this order, skipping conditional stages that do not add relevant evidence:

**understand → implement → verify → [preview] → [browser] → [visual] → final diff review → publish → PR → CI → [evidence-driven fix loop]**

1. **Understand.** Start with `context.build`; refine with `workspace.inspect`, `code.search`, `code.impact`, `file.read`, and relevant `git.status`, `git.log`, `git.show`, `git.range`, or `git.diffHistory`. Gather enough evidence to identify the smallest change.
2. **Implement.** Prefer test-first edits using `file.edit`, `file.patch`, or `file.write`. Keep the diff narrow.
3. **Verify. Focused proof first.** Start with the smallest targeted check and run it synchronously. Prefer `verify.list` and `verify.run`; use bounded `process.run` only when no suitable typed or discovered recipe exists. If focused proof fails, diagnose returned evidence and make a targeted correction; **never blind retry**.

   After focused proof succeeds, when multiple independent broader recipes such as test, typecheck, lint, or build are relevant, fan them out as distinct `verify.run` calls with `background: true`. Keep every returned `operationId` in host conversation state; KodeGPT does not own a verification workflow or scheduler. Collect each operation through `process.status` with bounded `waitMs`; do not busy-poll or create an automatic retry loop. Interpret each result separately.

   A failed broader gate does not make sibling evidence useless. **Do not automatically cancel sibling verification** when one gate fails; let independent siblings finish unless their work is now provably obsolete, unsafe, or the user asks to stop. Use `process.cancel` only for that evidence-backed case. Repair the smallest affected scope and rerun only verification invalidated by the repair.
4. **Preview only when relevant.** For previewable or runtime-relevant work, use `preview.start`, confirm readiness with `preview.inspect`, and eventually `preview.stop`. Skip preview for work whose behavior is fully established by non-runtime verification.
5. **Browser only when behavior matters.** With a live preview, use `browser.openPreview`, then `browser.inspect`, `browser.console`, `browser.networkFailures`, and targeted `browser.click`, `browser.type`, or `browser.screenshot` only as needed. Do not add browser work to unrelated changes.
6. **Visual only for UI/layout impact.** Prefer `visual.captureMatrix`; use `visual.compare` only with an explicit trusted reference artifact. A UI change should not stop at unit tests when visual evidence is material.
7. **Review before publishing.** Use `git.changes` and `git.diff` for the exact final diff review. If review causes edits, rerun the verification those edits invalidate. Then use `git.stage`, `git.commit`, and `git.push`.
8. **PR.** Use `github.pr.create` and `github.pr.inspect` as appropriate. Do not publish an unreviewed dirty diff.
9. **CI.** Start with `ci.status`; use `ci.runs` and `ci.run` only as needed. If CI is queued or running, report that evidence and **never busy-poll**. Treat mutation `accepted: true` only as provider acknowledgement, never as proof that the requested state transition has completed. Before any dependent remote mutation, refresh with `ci.run` or `ci.status` and require the observed state needed by the next operation. In particular, after `ci.cancel`, do not invoke `ci.rerun` until the run is observed in a terminal rerunnable state. When CI fails, inspect the run and gather **CI failure evidence** with `ci.failure` before changing code or tests. Make the smallest repair, verify locally, repeat the final diff review, commit, push, and inspect the new exact PR head. Use `ci.rerun` only when failure evidence supports a transient or infrastructure cause; never use rerun as diagnosis.

## Loop and deployment rules

A failed stage loops back only to the smallest affected earlier stage; do not restart the whole workflow by default. **Do not automatically deploy** or configure Netlify. Netlify preview deployment is a separate explicit workflow outside this normal development path.
