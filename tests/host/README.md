# Manual ChatGPT Host Evidence

This directory documents the manual evidence contract for Task 24. Do not commit machine-specific evidence here.

Run deterministic Task 23 first. A host test is valid only when `pnpm test:integration` and `pnpm test:acceptance` are freshly green for the exact KodeGPT commit being tested.

## Evidence file template

Store the completed record outside Git, for example under `/tmp/kodegpt-host-evidence.json`.

```json
{
  "schemaVersion": 1,
  "date": "2026-08-10T00:00:00+07:00",
  "kodegptCommit": "<exact commit>",
  "planWorkspace": "<ChatGPT plan/workspace>",
  "connectionPath": "secure-mcp-tunnel",
  "discovery": {
    "observed": false,
    "notes": ""
  },
  "readAction": {
    "tool": "system.health",
    "observed": false,
    "notes": ""
  },
  "writeAvailability": {
    "observed": false,
    "tool": "file.write",
    "notes": ""
  },
  "writeConfirmation": {
    "observed": false,
    "notes": ""
  },
  "appsRendering": {
    "observed": false,
    "resource": "ui://kodegpt/dev-console/v1",
    "notes": ""
  },
  "fallbackBehavior": {
    "observed": false,
    "notes": ""
  },
  "limitations": []
}
```

Do not replace `false` with `true` from inference. Each observed field must reflect what the target ChatGPT host actually did.

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
