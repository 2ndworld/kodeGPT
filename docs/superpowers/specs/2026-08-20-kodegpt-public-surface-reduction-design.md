# KodeGPT Public Surface Reduction Design

Date: 2026-08-20
Status: approved direction

## Goal

Reduce KodeGPT's public MCP surface by removing three low-value/redundant tools and one provider-specific deployment stack, while preserving the internal primitives that still power higher-level capabilities.

Target on this branch:

- runtime `0.1`
- protocol `2026-07-28`
- MCP semantic surface `0.16`
- exactly 75 public tools

## 1. Remove public `file.search`, keep private lexical search

`file.search` is redundant for ChatGPT because public `code.search(mode:"text")` already exposes structured lexical search and uses the same retained-root search authority internally.

Remove only:

- MCP `file.search` registration;
- MCP surface snapshots/tests/docs that describe it as public.

Keep unchanged:

- Rust/runtime `file.search` request and audit action;
- TypeScript runtime protocol schema/fixture;
- `WorkspaceManager.searchBounded(...)`;
- internal semantic/literal search adapters;
- `code.search` behavior.

This deliberately converts `file.search` from a public primitive to a private runtime primitive rather than deleting duplicated low-level implementation.

## 2. Remove typed Netlify preview deployment completely

Remove the Netlify-specific application surface and implementation:

- public `deploy.preview.create`;
- public `deploy.preview.inspect`;
- deploy tool context/types/schemas;
- `createDeployPreviewToolAdapter` startup wiring;
- `netlify.deploy.v1` static provider manifest and semantic mappings;
- Netlify deploy adapter/tool-adapter source and tests;
- Netlify export/registry wiring.

Keep the provider gateway itself because GitHub read/write/CI and credential-backed Git operations still use it.

Do not replace Netlify with:

- generic deployment tools;
- `provider.invoke`;
- another deployment provider;
- generic HTTP authority.

For personal trusted development, project-specific deployment CLIs can be run through existing `process.run` when needed.

## 3. Production provider inventory

`PRODUCTION_PROVIDER_MANIFESTS` becomes GitHub-only:

- `github.read.v1`
- `github.write.v1`

No other provider behavior changes.

## 4. Versioning and compatibility

This changes the public MCP contract, so semantic surface advances `0.15 -> 0.16` on this independent branch. Runtime/protocol versions do not change because private `file.search` remains and no Rust request is removed.

The locked public tool count changes `78 -> 75`.

Historical specs/plans/readiness documents remain historical records. Current architecture/compatibility documentation receives a short reconciliation note describing the new public/private boundary and Netlify removal.

## Acceptance

1. `listSurfaceTools()` has exactly 75 entries.
2. `file.search`, `deploy.preview.create`, and `deploy.preview.inspect` are absent.
3. `code.search(mode:"text")` still works end-to-end through private runtime `file.search`.
4. runtime/protocol parity still includes private `file.search`.
5. production provider manifests contain only GitHub read/write adapters.
6. no Netlify deploy source/export/startup/tool-context code remains outside historical docs.
7. all current tests/typecheck/build/package/security/Rust gates pass after fixture reconciliation.
8. no generic provider/deployment/network surface is introduced.

## Non-Goals

This cleanup does not remove:

- `file.read`, `file.tree`, or internal lexical search authority;
- provider gateway infrastructure;
- GitHub provider adapters;
- preview/browser/visual tools;
- any Git/GitHub/CI capability;
- historical documentation.
