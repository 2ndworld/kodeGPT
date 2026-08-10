# Manual HTTPS Exposure

KodeGPT listens on loopback (`127.0.0.1`) even when `kodegpt start --public-url https://…` is configured. The option does not create, manage, or supervise a tunnel and does not bind the MCP server to a public interface.

`--public-url` is a trust declaration for an operator-managed HTTPS reverse proxy, tunnel, or other MCP-host exposure layer. It must be a credential-free absolute HTTPS URL. Its exact authority is added to the accepted Host and Origin trust set; sibling/subdomain authorities and HTTP origins remain rejected.

A typical manual deployment therefore has two independent layers:

1. KodeGPT listens only on loopback and enforces bearer authentication, Host/Origin checks, JSON request limits, and MCP protocol validation.
2. The operator separately configures a trusted HTTPS exposure mechanism that forwards requests to the loopback listener and preserves the expected public Host/Origin semantics.

This is generic MCP-host exposure. It is not a claim that ChatGPT, or any other remote MCP client, can connect directly to a user's localhost. Whether a particular host can reach the configured HTTPS endpoint depends on that host's networking and connector capabilities.

## Managed personal/development zrok exposure

For the approved personal/development ChatGPT path, KodeGPT can supervise an already-installed and enabled zrok v2 CLI using a pre-existing reserved name:

```bash
kodegpt expose zrok --name <namespace:name>
```

KodeGPT first resolves the reserved name from `zrok2 list names -n <namespace> --json`, derives the public HTTPS authority from that metadata, and then starts its MCP listener only on loopback. It supervises `zrok2 share public` locally with `--force-local`, proxying only `http://127.0.0.1:<port>`. `kodegpt start` itself remains tunnel-independent.

Readiness is checked through structured `zrok2 list shares --json` metadata for the exact target/mode/frontend endpoint; human-readable zrok logs are not scraped, and raw structured output is never logged because zrok-owned metadata may contain sensitive fields.

On the first managed exposure for a state root, KodeGPT creates the existing connector credential only after zrok readiness succeeds and prints the ChatGPT Server URL once. That query-bearing Server URL is a credential and must be kept private. Later runs reuse the stored verifier rather than silently rotating or reconstructing the plaintext credential.

KodeGPT does not read, persist, rotate, or print zrok account/environment credentials and does not create namespaces or reserved names. zrok is only the reachability layer; KodeGPT workspace trust, policy, sandbox, filesystem/process authority, and audit behavior remain unchanged.
