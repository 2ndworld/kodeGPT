---
name: kodegpt-application-development-workflow
description: Use when developing or fixing an application with KodeGPT from repository understanding through verified PR and CI evidence.
---

# KodeGPT Application Development Workflow

## Ownership

**Host owns orchestration.** Interpret the user's intent and acceptance criteria, choose only the stages that apply, sequence explicit KodeGPT calls, interpret returned evidence, and keep conversational identifiers such as preview, PR, and CI run IDs. KodeGPT remains the typed authority for every operation; loading this skill grants no execution permission. Do not invent `workflow.run` or `skill.run`, and do not delegate the workflow to another execution agent.

When isolated branch work materially helps, the host may explicitly compose `git.branchCreate` followed by `git.worktreeCreate`, then trust/open the returned `.worktrees/<name>` child through the normal workspace control plane. Isolation is optional, never automatic. Close the child before returning to the parent for `git.worktreeRemove`; delete the branch separately only when normal Git lifecycle evidence says that is safe. Do not treat these tools as an agent/worktree scheduler.

## Resume / continuation

When the user asks to continue, resume, or lanjutkan prior work, recover coordination state before rebuilding repository context. Inspect current Git state first. If `.ai-bridge/current-plan.md` exists, read it; consult `.ai-bridge/agent-status.md`, `decisions.md`, or `open-questions.md` only when they are relevant to the active plan. Treat an explicit `CLOSED`, `RECONCILED`, `CLEAN`, or equivalent terminal state as terminal and do not invent a new phase merely to keep working. Resolve the active objective and target before `context.build`; `.ai-bridge` remains host coordination state and is not automatically part of semantic context.

## Adaptive flow

Use this order, skipping conditional stages that do not add relevant evidence:

**understand → implement → verify → [preview] → [browser] → [visual] → final diff review → publish → PR → CI → [evidence-driven fix loop]**

1. **Understand.** Start with `context.build`; refine with `workspace.inspect`, `code.search`, `code.impact`, `file.read`, and relevant `git.status`, `git.log`, `git.show`, `git.range`, or `git.diffHistory`. Gather enough evidence to identify the smallest change.
2. **Implement.** Prefer test-first edits using `file.edit`, `file.patch`, or `file.write`. Keep the diff narrow.
3. **Verify.** Start with the smallest targeted check. Prefer `verify.list` and `verify.run`; use bounded `process.run` only when no suitable typed or discovered recipe exists. On failure, diagnose returned evidence and make a targeted correction; **never blind retry**.
4. **Preview only when relevant.** For previewable or runtime-relevant work, use `preview.start`, confirm readiness with `preview.inspect`, and eventually `preview.stop`. Skip preview for work whose behavior is fully established by non-runtime verification.
5. **Browser only when behavior matters.** With a live preview, use `browser.openPreview`, then `browser.inspect`, `browser.console`, `browser.networkFailures`, and targeted `browser.click`, `browser.type`, or `browser.screenshot` only as needed. Do not add browser work to unrelated changes.
6. **Visual only for UI/layout impact.** Prefer `visual.captureMatrix`; use `visual.compare` only with an explicit trusted reference artifact. A UI change should not stop at unit tests when visual evidence is material.
7. **Review before publishing.** Use `git.changes` and `git.diff` for the exact final diff review. If review causes edits, rerun the verification those edits invalidate. Then use `git.stage`, `git.commit`, and `git.push`.
8. **PR.** Use `github.pr.create` and `github.pr.inspect` as appropriate. Do not publish an unreviewed dirty diff.
9. **CI.** Start with `ci.status`; use `ci.runs` and `ci.run` only as needed. If CI is queued or running, report that evidence and **never busy-poll**. Treat mutation `accepted: true` only as provider acknowledgement, never as proof that the requested state transition has completed. Before any dependent remote mutation, refresh with `ci.run` or `ci.status` and require the observed state needed by the next operation. In particular, after `ci.cancel`, do not invoke `ci.rerun` until the run is observed in a terminal rerunnable state. When CI fails, inspect the run and gather **CI failure evidence** with `ci.failure` before changing code or tests. Make the smallest repair, verify locally, repeat the final diff review, commit, push, and inspect the new exact PR head. Use `ci.rerun` only when failure evidence supports a transient or infrastructure cause; never use rerun as diagnosis.

## Loop and deployment rules

A failed stage loops back only to the smallest affected earlier stage; do not restart the whole workflow by default. **Do not automatically deploy** or configure Netlify. Netlify preview deployment is a separate explicit workflow outside this normal development path.
