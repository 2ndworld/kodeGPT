# ChatGPT Compatibility Claim Gate

Status date: 2026-08-12.

KodeGPT must distinguish deterministic MCP conformance from ChatGPT-host compatibility. Passing KodeGPT's local protocol, security, Apps, and packaging suites is necessary but is not evidence that a specific ChatGPT plan/workspace can connect to or invoke every KodeGPT capability.

## Connectivity truth

ChatGPT does not connect directly to a localhost MCP endpoint. A KodeGPT server on a developer machine therefore needs either a private connection mechanism supported by OpenAI or a remotely reachable HTTPS MCP endpoint.

KodeGPT v0.1 supports three deliberately separate transport/exposure paths:

- `kodegpt bridge` serves the production stack over stdio without opening a network port. It remains suitable for private subprocess-based connection mechanisms such as Secure MCP Tunnel.
- `kodegpt start` binds only to loopback for local HTTP access. `--public-url` adds exact HTTPS Host/Origin trust semantics for an operator-managed reverse proxy/tunnel, but `start` itself never spawns an exposure process.
- `kodegpt expose zrok --name <namespace:name>` is the explicit personal/development managed-exposure path. It resolves an existing zrok v2 reserved name through structured `zrok2` metadata, keeps the KodeGPT listener on loopback, enables the approved query-credential compatibility mode for that invocation, and supervises `zrok2` locally with `--force-local`.

The query-bearing ChatGPT Server URL emitted on first managed exposure is itself a credential and must be kept private. KodeGPT does not read or manage zrok account/environment credentials. zrok provides reachability only; workspace trust, file/process authority, policy, sandboxing, and audit remain KodeGPT responsibilities. Structured zrok readiness output is parsed only for target/mode/frontend fields and is never logged raw because zrok-owned metadata may contain sensitive fields.

OpenAI's current guidance recommends Secure MCP Tunnel when a local/private MCP server should be connected without exposing it to the public internet. That is an alternative private path, not a prerequisite for KodeGPT's explicitly public HTTPS zrok development path. Host compatibility must still be tested through the actual connection path used by the target ChatGPT workspace.

## Plan/workspace capability truth

OpenAI currently describes full MCP support, including modify/write actions, as a beta capability for ChatGPT Business, Enterprise, and Edu workspaces. Availability, action controls, confirmations, and developer-mode permissions can vary by plan/workspace and may change. Pro developer-mode support is more limited. KodeGPT must not turn deterministic server support into a broader statement that every ChatGPT account can execute write tools.

The compatibility claim is therefore scoped to observed evidence:

- Read discovery/action support must be observed from the target ChatGPT host.
- Write availability must be recorded separately from read availability.
- Any confirmation prompt or action-control behavior must be recorded as observed host behavior, not inferred from MCP annotations.
- MCP Apps rendering must be recorded separately from text fallback behavior.
- If Apps UI is unavailable, semantic tools and text/structured fallback must still remain meaningful.
- After the MCP tool inventory or tool input definitions change, the ChatGPT app/connector actions must be refreshed/rescanned before new host evidence is collected. ChatGPT may retain an approved/frozen tool snapshot; a running server with a newer surface version does not by itself prove the host is using that newer inventory.

For the reconciled `0.3` candidate, begin host acceptance by calling `system.capabilities` and require `mcpProtocolVersion:"2026-07-28"` plus `mcpSurfaceVersion:"0.3"`. A still-running `0.2` connector is a stale deployment and must not be used as evidence that the `0.3` candidate passed or failed host behavior; restart/reinstall the exact candidate first.

## Native capability hub semantics

KodeGPT's released native capability + read-only skill hub is the `0.3` semantic MCP tool surface; the MCP protocol remains `2026-07-28`. GPT Web remains the reasoning actor: KodeGPT provides bounded, typed, policy-checked desktop/repository capabilities and does not introduce an autonomous coding agent, a Codex execution path, or a general shell shortcut.

The higher-level tools reduce repeated primitive round trips without replacing lower-level authority:

- `workspace.inspect` assembles bounded evidence about project types, languages, manifests, entrypoints, and areas from retained-root inspection. `context.build` composes existing inspect/Git/search/verification/read capabilities using deterministic rules and a byte budget; it performs no model inference.
- `code.search` reports its precision (`exact`, `lexical`, or `heuristic`) and explicit truncation reasons. Heuristic symbol/definition/reference matches are never described as compiler-precise.
- `git.changes` provides a content-sensitive deterministic checkpoint. Untracked content participates in fingerprint identity, while v1 unified patch coverage is explicitly limited to staged and worktree tracked diffs.
- `verify.list` discovers only named deterministic recipes. `verify.run` selects and re-resolves one of those recipes through the existing process sandbox; it does not accept an arbitrary replacement executable/argv or shell command.
- `file.patch` defaults to `check`. It parses a bounded text-only unified patch, performs full preflight for all affected files before the first mutation, then in `apply` mode uses per-file conditional retained-root commits. It is **not** a globally atomic multi-file transaction: a host/runtime failure during commit may leave already committed earlier paths in place, and KodeGPT reports `committedPaths` plus `failedPath` rather than claiming rollback.

High-level repository understanding uses an internal **semantic traversal scope** by default for `workspace.inspect`, all `code.search` modes, `context.build` discovery evidence, and verification project discovery. The fixed VCS/worktree/generated/vendor/cache directory set is skipped for relevance before traversal/search budgets are consumed; this is not an access-control deny list. Primitive `file.tree`/`file.search` remain literal, arbitrary hidden first-party config directories are not excluded merely because they begin with `.`, and explicitly asking a high-level operation to start inside an otherwise excluded subtree opts that requested root back in.

Workspace trust remains local-only and is deliberately absent from the MCP tool inventory. The public surface also contains no `shell.run`, `codex.run`, `codex.exec`, or `skill.run` execution tools.

## Hybrid skill interoperability

Hybrid skill interoperability keeps GPT Web as the reasoning actor over skill semantics. KodeGPT discovers, fingerprints, inspects, and loads bounded skill instructions/resources, while KodeGPT's existing native capabilities perform any allowed host operations under the normal runtime, policy, sandbox, trust, and audit authorities.

The release does **not** launch, proxy, or depend on Codex or Claude agents. Skill scripts and resources are data: an explicitly requested UTF-8 script resource may be returned as text, but it is never executed merely because a skill references or contains it. Live skills reflect source changes automatically, while pinned skills preserve immutable, reproducible snapshots that remain loadable when the corresponding live source is unavailable. A persisted source path that is replaced with a different filesystem identity is not treated as ordinary unavailability: identity replacement remains fail-closed even when an older snapshot is pinned.

Source admission/removal and pin/unpin are local CLI actions. MCP exposes only the read-only `skill.list`, `skill.inspect`, and `skill.load` tools; it does not expose source mutation, pin mutation, workspace trust, host paths, state-root paths, canonical source roots, or source capability IDs. `skill.list` can optionally filter by `sourceId`, compatibility classification, and pinned state before applying its public result limit. Public bounds remain 500 list results, 32 explicitly requested `skill.load` resources, and 512 KiB returned load bytes.

Skill identity is stable across live and pinned state: `ss_...` identifies an admitted source, `sk_...` identifies the skill, and `(skillId, fingerprint)` selects an immutable version. The current private pin layout is `<stateRoot>/skills/pinned/<skillId>/<fingerprint>/`; no separate public `sp_...` pin identity is part of the shipped contract.

Compatibility classification is advisory semantic-portability metadata, not a permission grant:

- `NATIVE` means the declared/static semantics are representable by currently available KodeGPT-native capabilities.
- `PARTIAL` means part of the skill is portable but some semantics are missing or require adaptation.
- `PROVIDER_REQUIRED` means the skill describes semantics associated with an external provider/tool environment. It does **not** mean provider invocation is available in this release.
- `UNSUPPORTED` means the skill depends on semantics KodeGPT must not execute or pretend to support, including Codex/subagent execution workflows such as `codex exec`.

Runtime/security policy remains the final authority regardless of compatibility classification. Provider interoperability (`provider.list`, `provider.tools`, `provider.invoke`) and `skill.run` are intentionally out of scope for this phase.

## Required manual host evidence matrix

Before claiming ChatGPT compatibility for a release candidate, capture a local-only evidence record containing at least:

| Field | Required evidence |
|---|---|
| date | Absolute date/time of the host test |
| kodegptCommit | Exact KodeGPT commit tested |
| planWorkspace | ChatGPT plan/workspace type used for the test |
| connectionPath | Exact path used, for example `secure-mcp-tunnel-stdio` or `zrok-public-https-query-credential` |
| discovery | Whether ChatGPT discovered the KodeGPT server/tools |
| workspaceOpen | Whether the host successfully opened an already locally trusted workspace |
| readAction | At least one read-only action and observed result |
| writeAvailability | Whether write/modify actions were exposed to that host |
| writeRoundTrip | Whether a reversible write/edit was executed, read back, and exactly reverted |
| processAction | Whether a process action reached KodeGPT and the observed allow/deny/result behavior |
| skillActionExposure | Whether `skill.list`, `skill.inspect`, and `skill.load` actions reached KodeGPT, even if the catalog was empty/unconfigured |
| skillPositiveRoundTrip | Whether a configured non-empty host catalog completed `skill.list -> skill.inspect -> skill.load` and verified the expected resource marker |
| appsRendering | Whether `ui://kodegpt/dev-console/v1` actually rendered as an MCP App |
| fallbackBehavior | What happened when Apps rendering was unavailable/disabled |
| notes | Any host-specific limitations or permissions |

Machine-specific tunnel IDs, connector credentials, tokens, local absolute paths, and Pranikah guard manifests must remain outside Git.

## Claim levels

`DETERMINISTIC_MCP_PASS` means Task 23 local security/protocol/Apps acceptance is green. It does **not** imply ChatGPT compatibility.

`CHATGPT_HOST_OBSERVED` may be used only after the manual evidence matrix above is populated for the exact plan/workspace and connection path tested.

`WRITE_OBSERVED` may be used only when the target host actually exposes and successfully confirms/executes the tested write action. It must not be inferred from KodeGPT's tool annotation or from another plan/workspace.

## Source checked

Current product facts above were checked against the OpenAI Help Center article **“Developer mode and MCP apps in ChatGPT”** on 2026-08-10. Because host availability and permissions are product-state facts, re-check the current OpenAI documentation when producing release evidence rather than treating this document as permanently authoritative.
