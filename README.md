# Sedna Browser MCP

A standalone visual-first browser MCP: look at a live page, act on it, receive
the resulting screenshot, and continue in the same browser. A Rust/RMCP host
supervises the existing Node/Playwright runtime. Both local stdio and
authenticated Streamable HTTP/HTTPS use that same worker implementation.

**HTTP candidate status:** implementation and tests are present, but this
revision has not been compiled or tested over HTTP in its authoring environment.
The container has no Rust toolchain/package access. Only the recorded
JavaScript/schema checks passed here. See [current validation](docs/validation-current.md).
No GitHub repository or PR has been created by this archive.

## Get started

Requires Node.js 22+, Rust (the repository pins 1.99.0), a native C toolchain
and Chromium system libraries.

```sh
npm ci
npm run setup
node scripts/start.mjs --check
```

The pending HTTP lockfile is regenerated explicitly during setup. The final
release build then uses `--locked`. Install Linux browser system libraries
with `npx playwright install --with-deps chromium` when necessary.

Stdio remains the default:

```sh
node scripts/start.mjs
```

For an authenticated HTTP service, copy and configure an example outside the
repository, then run:

```sh
node scripts/start.mjs --transport http --http-config /etc/browser-mcp/http.json
```

See [HTTP/HTTPS setup and ownership](docs/http.md),
[proxy example](examples/http-proxy.json), [native TLS example](examples/http-tls.json),
and [Codex HTTP configuration](examples/codex-http.toml). HTTP always requires
issuer-validated, audience-bound, scoped JWTs. A TLS proxy is not a substitute
for authorization inside the server.

## Tools

| Tool | Purpose |
| --- | --- |
| `browser_observe` | Inline current screenshot, geometry and compact controls. |
| `browser_step` | Bounded ordered actions (including persistent CSS viewport/scroll changes), cleanup, partial receipts and resulting image. |
| `browser_review` | Explicit responsive captures with per-view geometry and restoration receipts. |
| `browser_inspect` | Bounded recent console/network records and sequence cursors. |
| `browser_tabs` | Explicit tab operations and actual Chrome target identities. |
| `browser_session` | Lifecycle and last-operation reconciliation; HTTP adds owned create/list/close. |

Over HTTP, call `browser_session` with `action: "create"`, then pass its
`browser_session_id` on subsequent calls. Two agents sharing credentials do not
automatically share a browser. Stdio keeps its private implicit worker.
Screenshots are typed MCP image blocks, not filenames or base64 embedded in text.

The existing viewport/action semantics and recovery model are documented in
[architecture](docs/architecture.md), [protocol](docs/protocol.md), and
[operations](docs/operations.md). HTTP leases add a transport-independent
owner check; they do not replace browser/page/observation identities.

## Verify and publish PR #1

```sh
node scripts/verify.mjs
```

This resolves any pending lockfile, formats Rust, compiles/tests both transport
modes, runs real Chromium and native TLS tests, and checks packaging. Failures
stop the run. It writes concrete evidence to `docs/verification-run.json`.

To create the requested new public repository using an authenticated GitHub CLI:

```sh
node scripts/publish-pr1.mjs
```

The script targets only `sednalabs/browser-mcp`, refuses to modify an existing
repository, runs verification first, creates a minimal licensed `main`, then
pushes the implementation branch and opens **draft PR #1**. It never merges a
PR or force-pushes. It requires `gh`, `git` and permission to create organization
repositories. Only the explicit `SOURCE_MANIFEST.json` inventory is copied.

## Licence and security

Apache-2.0. [NOTICE](NOTICE) preserves Sedna/OpenAI Codex provenance.
Read [SECURITY.md](SECURITY.md) before exposing a browser service. Browser
users can act on the network reachable from their browser host; run it in an
appropriately isolated environment. The optional CDP endpoint stays private.

The initial server retains stdio compatibility for MCP 2025-11-25 and targets
MCP 2026-07-28 via the maintained RMCP 3.5.1 source. Version support is not a
claim that this HTTP candidate has already passed its required integration tests.
