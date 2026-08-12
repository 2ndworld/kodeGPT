# Manual ChatGPT Host Evidence

This directory documents the manual evidence contract for ChatGPT-host acceptance. Do not commit machine-specific completed evidence, credentials, tunnel URLs, local absolute project paths, or account metadata here.

Run the deterministic integration/acceptance gates first for the exact KodeGPT commit being tested. For the managed personal/development path, start the installed candidate with `kodegpt expose zrok --name <namespace:name>` using a pre-existing reserved zrok v2 name; keep the emitted query-bearing Server URL local and out of Git/transcripts.

## Evidence record

Copy `tests/host/evidence-template.json` to a local-only location such as `/tmp/kodegpt-host-evidence.json` and fill it with the actual target-host observations.

An `observed:true` value requires the target ChatGPT host to have actually performed or rendered that category. Do not infer observation from MCP annotations, local integration tests, `host.uiSupported:true`, another ChatGPT plan/workspace, or the existence of a registered action.

Keep these categories distinct:

- discovery and locally trusted workspace open;
- read action;
- write action availability versus a successful reversible write/edit round trip;
- process action reaching KodeGPT, including policy-side denial where applicable;
- skill action exposure versus a positive non-empty skill list/inspect/load round trip;
- actual MCP Apps visual rendering versus usable text/tool fallback.

## Positive skill-host acceptance

Skill-source admission is local-only authority. Prepare a minimal source outside the repository:

```bash
mkdir -p /tmp/kodegpt-host-skill-source/portable/references
cat > /tmp/kodegpt-host-skill-source/portable/SKILL.md <<'EOF'
---
name: portable-host-acceptance
description: Host acceptance skill
---
Read the requested reference and report its exact marker.
EOF
printf 'kodegpt-host-skill-reference\n' > /tmp/kodegpt-host-skill-source/portable/references/marker.txt
kodegpt skill source add /tmp/kodegpt-host-skill-source --kind agent-skills
```

Then, from the actual ChatGPT host connected to the candidate:

1. Call `skill.list` and obtain the `skillId` and current `fingerprint` for `portable-host-acceptance`.
2. Call `skill.inspect` for that skill. Verify the result contains no host source path/state-root path and that the resource inventory contains `references/marker.txt`.
3. Call `skill.load` with `resources:["references/marker.txt"]`. Verify the returned text contains the exact marker `kodegpt-host-skill-reference`.
4. Only after all three steps succeed may `skillPositiveRoundTrip.observed` and `markerVerified` be set to `true` in the local evidence record.

There is intentionally no MCP `skill.source.add` action.

## Optional pinned-version reproducibility host check

Using local CLI authority only, pin the observed `(skillId, fingerprint)`. Modify or remove the live source afterward, then ask the ChatGPT host to call `skill.load` with the old fingerprint. The old instructions/resources must remain available from the immutable pinned snapshot under the same stable `skillId`.

Record only provenance-safe observations in the local evidence file. Do not commit state-root paths or machine-specific pin metadata.

## Cleanup

After the host check, use local CLI authority only:

```bash
kodegpt skill source list
kodegpt skill source remove <source-id>
# If a pin was created:
kodegpt skill unpin <skill-id> --fingerprint <sha256>
rm -rf /tmp/kodegpt-host-skill-source
```

Do not automate source removal or unpinning through MCP.

## MCP Apps rendering observation

Attempt to render the registered resource `ui://kodegpt/dev-console/v1` in the actual target ChatGPT host. Record `appsRendering.observed:true` only when the UI visibly renders. A host capability flag, resource registration, or local Apps test is not rendering evidence.

If the UI does not render but semantic tools/text fallback remain usable, record that separately in `fallbackBehavior`; a non-rendering host can still pass the semantic tool acceptance categories while Apps rendering remains unobserved.

## Isolation guard sequence

Immediately before host/local acceptance, capture the passive Pranikah guard to a local-only file:

```text
node scripts/host-compatibility-checklist.mjs capture --pranikah-root <path> --output /tmp/kodegpt-pranikah-before.json
```

Run the intended KodeGPT acceptance/host work, then capture again:

```text
node scripts/host-compatibility-checklist.mjs capture --pranikah-root <path> --output /tmp/kodegpt-pranikah-after.json
node scripts/host-compatibility-checklist.mjs compare --before /tmp/kodegpt-pranikah-before.json --after /tmp/kodegpt-pranikah-after.json
```

`compare` must exit zero. The guard is passive: it reads Git/tracked-file state and listening TCP state only. It must not start, stop, reconfigure, or write inside Pranikah.
