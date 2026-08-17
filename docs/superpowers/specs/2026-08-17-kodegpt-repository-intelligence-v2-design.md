# KodeGPT Repository Intelligence v2 Design

**Date:** 2026-08-17
**Status:** Approved from the user's request to continue the recommended Repository Intelligence v2 direction

## 1. Goal

Make KodeGPT materially better at understanding a codebase before it edits or verifies it, while keeping the implementation small, deterministic, bounded, dependency-free, and subordinate to the existing retained-root workspace authority.

The phase improves existing read-only capabilities instead of introducing a language server, background indexer, generic parser framework, or new execution/network authority.

## 2. Current problem

`workspace.inspect` currently reports project type, language counts, manifest/config entrypoints, areas, and manifests. It does not expose source-level symbols or relationships. In a scoped package such as `packages/capabilities`, this makes the result much less useful than the repository evidence already available to CodexPro.

`code.search` can classify identifier-like lines as symbols, definitions, or references, but non-text modes are intentionally heuristic and do not provide file-to-file dependency/test relationships.

The useful missing layer is a small amount of first-party structural evidence, not a full semantic compiler service.

## 3. Chosen approach

Add one focused analyzer used by `workspace.inspect`.

The analyzer reads only bounded source files already admitted by the workspace tree. It recognizes a deliberately small subset of TypeScript/JavaScript and Rust syntax that is useful for repository orientation:

- top-level TypeScript/JavaScript `function`, `class`, `interface`, `type`, `enum`, and variable declarations;
- top-level Rust `fn`, `struct`, `enum`, `trait`, and `mod` declarations;
- TypeScript/JavaScript relative `import ... from`, side-effect imports, and `export ... from` relationships when the target resolves to a source file already present in the inspected tree;
- Rust `mod name;` relationships when `name.rs` or `name/mod.rs` exists in the inspected tree;
- conventional TypeScript/JavaScript test-to-source relationships for `.test.*` and `.spec.*` files when the sibling source file exists.

No new dependency is added. Recognition is conservative line-oriented parsing. If syntax is ambiguous, the analyzer omits evidence rather than guessing.

## 4. Public contract

`workspace.inspect` remains the same tool and keeps the existing input schema and MCP surface version `0.7`.

Its result gains two additive fields:

```ts
interface WorkspaceInspectSymbol {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "enum" | "variable" | "struct" | "trait" | "module";
  path: string;
  line: number;
  exported: boolean;
}

interface WorkspaceInspectRelationship {
  from: string;
  to: string;
  kind: "imports" | "tests" | "module";
}

interface WorkspaceInspectResult {
  // existing fields unchanged
  symbols: WorkspaceInspectSymbol[];
  relationships: WorkspaceInspectRelationship[];
}
```

The existing fields remain backward-compatible. `context.build` automatically carries the richer workspace result because it already embeds `WorkspaceInspectResult`.

No new MCP tool and no new `code.search` mode are added in this phase. Impact analysis can be derived by the host from `relationships`; a dedicated impact API is deferred until real usage proves that host-side derivation is insufficient.

## 5. Entrypoint quality

`workspace.inspect.entrypoints` additionally recognizes common source entrypoints already present in the inspected tree:

- `src/index.ts`, `src/index.tsx`, `src/index.js` as `source-index`;
- `src/main.ts`, `src/main.tsx`, `src/main.js` as `source-main`;
- `src/lib.rs` as `rust-lib`;
- `src/main.rs` as `rust-main`.

This applies at any inspected package/crate root, not only repository root.

## 6. Bounds and failure behavior

The analyzer must remain cheaper than the existing workspace inspection ceiling.

- analyze at most 256 source files;
- read at most 128 KiB from any one source file;
- read at most 4 MiB total source bytes;
- return at most 1,000 symbols;
- return at most 1,000 relationships;
- sort symbols and relationships deterministically;
- never read paths outside the retained-root tree supplied by the existing adapter;
- never execute code or consult the network.

When a bound is reached, inspection still succeeds and appends a stable warning:

- `INSPECT_ANALYSIS_FILE_LIMIT_REACHED`
- `INSPECT_ANALYSIS_BYTE_LIMIT_REACHED`
- `INSPECT_SYMBOL_LIMIT_REACHED`
- `INSPECT_RELATIONSHIP_LIMIT_REACHED`

Unreadable or non-UTF-8 source files are skipped with `INSPECT_ANALYSIS_FILE_SKIPPED` rather than failing the entire inspection.

## 7. Authority and security

Repository Intelligence v2 is read-only and does not widen KodeGPT authority.

The user's separate preference for a less restrictive personal workflow is handled operationally by using the already implemented `trusted` workspace profile for personal repositories. That preset already allows normal Node package-manager executables and unrestricted network while preserving KodeGPT's audit, retained-root filesystem boundary, explicit workspace trust, and process lifecycle controls.

This phase does not weaken `develop` globally and does not remove audit/workspace isolation. That keeps installations predictable while giving the user's explicitly trusted personal workspaces CodexPro-like flexibility.

## 8. Testing

TDD coverage must prove:

1. existing inspect output remains present;
2. TypeScript/JavaScript symbols are found with stable kinds/line/exported state;
3. Rust symbols are found with stable kinds/line/exported state;
4. relative TS/JS imports resolve only to files present in the inspected tree;
5. Rust `mod` resolves only to present module files;
6. `.test`/`.spec` files link to sibling source files when present;
7. source entrypoints are detected for scoped package/crate inspection;
8. all result arrays are deterministic;
9. analysis limits produce warnings instead of unbounded reads or hard failure;
10. schema/MCP structured-result tests accept the additive fields;
11. `context.build` remains compatible with the richer workspace result.

## 9. Explicit non-goals

Deferred unless later dogfood proves a need:

- TypeScript compiler API or Tree-sitter dependency;
- full AST correctness;
- cross-package module resolution through `tsconfig` path aliases;
- npm package dependency graphs;
- Rust `use` resolution beyond simple `mod` declarations;
- inheritance/call graphs;
- persistent/background indexing;
- watch mode;
- a new `code.impact` tool or `impact` search mode;
- generic language plugin framework;
- any provider/network/write authority change.

## 10. Completion gate

The phase is complete when focused capability/MCP/context tests, full Vitest, typecheck, build, and current repository deterministic gates pass, and live `workspace.inspect` on KodeGPT demonstrates non-empty structural evidence after the installed service is updated through the existing release workflow.
