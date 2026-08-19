# KodeGPT Typed Git Remote Credential Bridge Design

Date: 2026-08-19
Status: user-approved bounded follow-up from the application-development roadmap audit
Baseline: `main == origin/main == f90a7065181517db9002b6838690cebe17a62e7d`
Target: `runtime 0.1 / protocol 2026-07-28 / surface 0.14 / 76 tools`

## Problem

The existing typed `git.fetch`, `git.pull`, and `git.push` run Git inside KodeGPT's retained-root Bubblewrap sandbox with prompts and credential helpers disabled. That is correct for isolation, but authenticated HTTPS Git therefore cannot consume the GitHub credential authority KodeGPT already admits through the provider gateway and the pinned `gh auth token` helper. Live dogfood already classified this as an `EXISTING_PRIMITIVE_GAP`.

## Goal

Allow the existing typed remote Git mutations to use the already-admitted GitHub credential for canonical `https://github.com/<owner>/<repo>[.git]` remotes without adding a public tool, generic provider/credential API, host HOME mount, persistent credential state, shell bypass, or wider Git authority.

## Architecture

1. Keep public MCP inputs and outputs unchanged.
2. Add a private Git-remote credential source to the native capability composition. It requests a credential only after the existing trusted/write/unrestricted-network policy gate passes.
3. Reuse the existing Provider Gateway registry, manifest identity, pinned helper identity, and `DefaultProviderCredentialBroker`:
   - `fetch` and the fetch stage of `pull` use the enabled `github.read.v1` admission;
   - `push` uses the enabled `github.write.v1` admission;
   - no enabled matching provider means no credential and preserves the existing anonymous Git behavior;
   - multiple enabled matching providers fail closed as provider state invalid.
4. Pass the credential ephemerally through the existing private Node-to-Rust framed RPC. The kernel client does not log request bodies, and the Git remote audit records only capability, remote name, ref and outcome. The credential is never returned in a result.
5. Rust remains final authority. An optional credential is accepted only as a fixed `github_token` variant with a bounded single-line token. Rust resolves the configured Git target with hardened local Git, independently validates that the actual target is canonical credential-free GitHub HTTPS, and only then installs an in-memory URL-scoped HTTP Authorization header for that invocation.
6. Credentialed Git uses the exact validated URL as the transport target rather than trusting the remote name after validation. Fetch/pull still write the validated remote-tracking ref under the caller-validated remote name.
7. Authentication is injected through Git's process environment/config, never through argv, repository config, artifact content, audit metadata, or host HOME. `credential.helper=` stays disabled and `GIT_TERMINAL_PROMPT=0` stays enforced.
8. Redirect following is disabled for credentialed Git HTTP so an authorization header cannot be carried to a redirected origin.

## Credential and URL bounds

- provider credential must be a non-empty bearer value from the existing bounded credential broker;
- internal token maximum: 4096 bytes;
- reject NUL, CR, or LF in the token;
- fixed Basic username: `x-access-token`;
- accepted target form: `https://github.com/<owner>/<repo>` or `https://github.com/<owner>/<repo>.git`;
- reject userinfo, query, fragment, non-HTTPS scheme, alternate host/port, empty owner/repository, extra path components, dot path components, and control characters;
- a credential acquired for an unrelated/non-GitHub remote is never attached to that remote.

## Failure behavior

- existing policy/input/runtime errors keep the existing `GIT_REMOTE_*` contract;
- no admitted/enabled GitHub provider yields `null` credential and preserves anonymous behavior;
- invalid/multiple provider state and credential-helper identity/acquisition failures are normalized to `GIT_REMOTE_UNAVAILABLE` without provider body, helper stderr, path, or credential disclosure;
- invalid credential framing fails before Git network execution;
- a non-GitHub remote is executed exactly as before with no credential header;
- Git authentication rejection remains ordinary bounded Git command evidence with the credential redacted by construction because it is absent from argv/output metadata.

## Surface and authority freeze

This phase must preserve exactly:

- runtime `0.1`;
- protocol identifier `2026-07-28`;
- MCP semantic surface `0.14`;
- exactly 76 public MCP tools.

It must not add `provider.*`, `credential.*`, new Git tools, a generic provider selection surface, arbitrary HTTP, host credential-file mounts, persistent tokens, automatic retries, force push, arbitrary refspecs, or arbitrary remote URLs.

## Test strategy

TDD must prove:

1. policy denial happens before credential acquisition;
2. fetch/pull select GitHub read admission and push selects GitHub write admission;
3. no enabled admission falls back to anonymous Git;
4. multiple enabled admissions fail closed;
5. the private credential is forwarded to the Rust mutation boundary but absent from public result schemas;
6. the Rust protocol rejects malformed credential variants/unknown fields;
7. Rust accepts bounded single-line tokens only;
8. credential configuration is URL-scoped to canonical GitHub HTTPS, uses a fixed username, disables redirects, and is not present for non-GitHub targets;
9. local-file remote regression still fetches/pulls/pushes without credentials;
10. canary credentials never appear in stdout/stderr previews, artifacts, audit JSONL, or public structured results;
11. existing surface tests remain exactly `0.14` / 76 tools.

## Acceptance

The phase is complete only after focused TypeScript/Rust/protocol tests, full deterministic verification, diff review, exact-head CI, and live dogfood demonstrate an authenticated typed HTTPS Git operation through the existing GitHub admission while preserving all authority and redaction invariants above.
