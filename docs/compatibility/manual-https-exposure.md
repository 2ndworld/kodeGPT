# Manual HTTPS Exposure

KodeGPT listens on loopback (`127.0.0.1`) even when `kodegpt start --public-url https://…` is configured. The option does not create, manage, or supervise a tunnel and does not bind the MCP server to a public interface.

`--public-url` is a trust declaration for an operator-managed HTTPS reverse proxy, tunnel, or other MCP-host exposure layer. It must be a credential-free absolute HTTPS URL. Its exact authority is added to the accepted Host and Origin trust set; sibling/subdomain authorities and HTTP origins remain rejected.

A typical deployment therefore has two independent layers:

1. KodeGPT listens only on loopback and enforces bearer authentication, Host/Origin checks, JSON request limits, and MCP protocol validation.
2. The operator separately configures a trusted HTTPS exposure mechanism that forwards requests to the loopback listener and preserves the expected public Host/Origin semantics.

This is generic MCP-host exposure. It is not a claim that ChatGPT, or any other remote MCP client, can connect directly to a user's localhost. Whether a particular host can reach the configured HTTPS endpoint depends on that host's networking and connector capabilities.
