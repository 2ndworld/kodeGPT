# ChatGPT Compatibility Claim Gate

Status date: 2026-08-10.

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

## Required manual host evidence matrix

Before claiming ChatGPT compatibility for a release candidate, capture a local-only evidence record containing at least:

| Field | Required evidence |
|---|---|
| date | Absolute date/time of the host test |
| kodegptCommit | Exact KodeGPT commit tested |
| planWorkspace | ChatGPT plan/workspace type used for the test |
| connectionPath | Exact path used, for example `secure-mcp-tunnel-stdio` or `zrok-public-https-query-credential` |
| discovery | Whether ChatGPT discovered the KodeGPT server/tools |
| readAction | At least one read-only action and observed result |
| writeAvailability | Whether write/modify actions were available to that host |
| writeConfirmation | Whether/how the host requested confirmation for the tested action |
| appsRendering | Whether `ui://kodegpt/dev-console/v1` rendered as an MCP App |
| fallbackBehavior | What happened when Apps rendering was unavailable/disabled |
| notes | Any host-specific limitations or permissions |

Machine-specific tunnel IDs, connector credentials, tokens, local absolute paths, and Pranikah guard manifests must remain outside Git.

## Claim levels

`DETERMINISTIC_MCP_PASS` means Task 23 local security/protocol/Apps acceptance is green. It does **not** imply ChatGPT compatibility.

`CHATGPT_HOST_OBSERVED` may be used only after the manual evidence matrix above is populated for the exact plan/workspace and connection path tested.

`WRITE_OBSERVED` may be used only when the target host actually exposes and successfully confirms/executes the tested write action. It must not be inferred from KodeGPT's tool annotation or from another plan/workspace.

## Source checked

Current product facts above were checked against the OpenAI Help Center article **“Developer mode and MCP apps in ChatGPT”** on 2026-08-10. Because host availability and permissions are product-state facts, re-check the current OpenAI documentation when producing release evidence rather than treating this document as permanently authoritative.
