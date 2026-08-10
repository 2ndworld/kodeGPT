# ChatGPT Compatibility Claim Gate

Status date: 2026-08-10.

KodeGPT must distinguish deterministic MCP conformance from ChatGPT-host compatibility. Passing KodeGPT's local protocol, security, Apps, and packaging suites is necessary but is not evidence that a specific ChatGPT plan/workspace can connect to or invoke every KodeGPT capability.

## Connectivity truth

ChatGPT does not connect directly to a localhost MCP endpoint. OpenAI's current ChatGPT developer-mode guidance specifies that local, private-network, on-premises, and developer-machine MCP servers should use **Secure MCP Tunnel paired with KodeGPT's production stdio bridge** (`kodegpt bridge`) as the preferred private connection path.

The `kodegpt bridge` command serves the exact KodeGPT production stack over standard input/output (stdio) without opening network ports or requiring HTTP connector tokens, while strictly preserving local-only workspace trust, retained-FD boundaries, policy presets, and audit logging.

KodeGPT keeps all tunnel/exposure ownership outside the core runtime:

- `kodegpt bridge` provides the preferred private stdio transport for Secure MCP Tunnel or local subprocess integration.
- `kodegpt start` binds to loopback for local HTTP/SSE access.
- `--public-url` adds exact HTTPS Host/Origin trust semantics for operator-managed HTTP exposure layers.
- KodeGPT does not spawn or supervise Secure MCP Tunnel, Cloudflare Tunnel, ngrok, SSH tunnels, or other exposure subprocesses.
- Host compatibility must be tested through the actual supported remote/private connection path used by the target ChatGPT workspace.

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
| connectionPath | `secure-mcp-tunnel` or another explicitly identified remote HTTPS path |
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
