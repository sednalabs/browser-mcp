# Streamable HTTP / HTTPS

This transport uses the same Rust `BrowserServer`, typed MCP results and
Playwright worker as stdio. It adds authenticated application leases rather than
creating a second browser engine. MCP framing, current/legacy routing and OAuth
resource metadata remain in `mcp-toolkit-rs` and RMCP.

## Status of this candidate

The implementation and tests are present, but the HTTP Rust code has not been
compiled or run in its authoring environment. The environment has no Rust
toolchain and cannot fetch dependencies. `Cargo.lock.pending` explicitly marks
the changed dependency graph. Run `node scripts/verify.mjs` before publishing or
using this over a network. Historical stdio test evidence does not qualify it.

## Start

Build/setup as documented in the root README. Copy `examples/http-proxy.json`
outside the repository and configure your real issuer and endpoint. Start with:

```sh
node scripts/start.mjs --transport http --http-config /etc/browser-mcp/http.json
```

An HTTP-enabled binary is the default. `--no-default-features` builds the stdio
variant. Only `stdio` and `http` are supported; two independently launched
processes never implicitly share a browser. Do not start two listeners against
one shared Chromium profile.

All HTTP MCP calls require a toolkit-validated JWT. There is no unauthenticated
HTTP mode, even on loopback. `/healthz` is public and returns only HTTP 204; it
is a process-liveness check, not proof that Chromium or the identity provider is
healthy. To check the browser, authenticate, create a lease, observe, then close.

## Authentication and TLS

The current implementation supports an external OIDC/OAuth issuer with JWKS
JWT verification. Configure your existing Keycloak realm or another compatible
issuer. Discovery must succeed and identify the configured issuer exactly.
There is no fabricated authorization endpoint or fallback to accepting tokens
when discovery fails. The canonical audience is `resource_url`, ending in
`/mcp`; at least one scope is required (default `browser:use`). The optional
client-ID allowlist restricts validated `azp` identities.

This process is an OAuth resource server. It does not become a login provider
or mint its own production credentials. Introspection and local delegation
modes are not implemented in this candidate; do not describe them as supported
merely because the toolkit can supply them.

Use either:

* A loopback HTTP listener behind a trusted HTTPS reverse proxy, using
  `examples/http-proxy.json`. The origin remains unreachable from the public
  network. End-to-end bearer verification still happens inside Browser MCP.
* Native rustls HTTPS, using `examples/http-tls.json`. Non-loopback listeners
  without native TLS are refused. Keep the private key mode 0600.

`Host`/`Origin` checks use the toolkit. Configure exact external and internal
Host values needed by your proxy, and exact allowed browser Origins. No
forwarded actor, forwarded certificate, or Cloudflare identity header is used
as authentication proof. Headers cannot override the configured issuer,
audience or public resource URL. No cookies are used for MCP authorization.

For local development only, `allow_loopback_http: true` permits literal
loopback/localhost HTTP metadata and issuer URLs; it does not permit arbitrary
cleartext remote endpoints. Paths in the HTTP config resolve relative to the
config file. Configs must be bounded regular non-symlink files, not
world/group-writable. Browser templates and TLS private keys must be private.

Reverse proxies must preserve POST and response streaming, must not cache tool
responses, and must not replay mutating POSTs on upstream failure. Configure
proxy timeouts longer than the operation/cancellation budget. The server
returns `Cache-Control: private, no-store`. Streamable HTTP carries MCP
responses, including typed images; it does not stream live browser video.

## Browser ownership

A transport connection is not a browser. Nor is a legacy `Mcp-Session-Id` a
browser or a bearer capability.

The authenticated principal is `(validated issuer, subject, authorized client)`.
No raw bearer token, full claims object or token fingerprint is retained as
browser ownership. Refreshing a token for the same principal preserves access;
changing issuer, subject or client does not. Current scopes are checked on every
HTTP request, not only when the browser is created.

Create a browser explicitly:

```json
{"name":"browser_session","arguments":{"action":"create","name":"checkout-test"}}
```

Its result returns a random `browser_session_id`, for example
`b_0123456789abcdef0123456789abcdef`. Pass it on each subsequent call:

```json
{"name":"browser_step","arguments":{"browser_session_id":"b_0123456789abcdef0123456789abcdef","actions":[{"type":"navigate","url":"https://example.com"}]}}
```

The server does not default an authenticated account onto one global browser.
Two threads with the same user credentials create separate leases. `list`
returns only the caller's leases. Missing/foreign IDs have the same error.
Stdio retains its original implicit private worker and does not require an ID.

Each HTTP lease gets a separate worker with a temporary, locked Chromium
profile. `browser_config` can point to an operator-owned worker template; it
must not contain `profile`, including after a template is changed. Inherited
`SEDNA_BROWSER_*` settings are cleared for HTTP workers. A template may configure
browser behavior and intentionally supplied service headers; those headers
then grant every authorized user of this deployment that service access.
Use separate deployments for different credential/security domains.

Idle leases expire after 1800 seconds by default. Their maximum lifetime is
86400 seconds. These are application leases, unrelated to legacy MCP session
retention. Active operations are not evicted by the sweeper; later admissions
after an absolute lifetime deadline fail explicitly. Browser cleanup is charged
against quota until completion. Failed cleanup quarantines the slot rather
than repeatedly allocating more workers.

Leases and page JavaScript do not survive process/browser death. Restarting the
service produces an empty registry and requires explicit creation. An HTTP
reconnect or legacy MCP reinitialization does not itself restart a living
browser. Losing a create response is reconciled with owner-scoped `list`, not
by automatically issuing create again.

## Cancellation and receipts

A browser operation retains its lease through the original worker's
cancellation, input cleanup and final observation. Dropping the HTTP waiter
requests cancellation but does not release the browser slot early. A client
may never receive that cancelled response. Use `browser_session` with `status`
and its lease ID to inspect `last_operation`, then observe before more input.

There is no automatic replay, transaction rollback or exactly-once claim.
Explicit `close` begins terminal cleanup and continues if its HTTP response is
lost. Cleanup must not be confused with undoing an application-side effect.

## Limits and legacy compatibility

The two independent bounds are intentional:

| Bound | Default | Accepted range |
| --- | ---: | --- |
| Browser leases | 16 | 1..128 |
| Leases per principal | 4 | 1..global limit |
| HTTP response/request lifetimes in flight | 32 | 1..256 |
| Legacy MCP sessions | 64 | 1..1024 |
| Buffered request bytes | 131072 | 1024..131072 |
| Browser idle seconds | 1800 | 1..86400 |
| Absolute lease seconds | 86400 | idle seconds..604800 |

The HTTP capacity permit is retained while the response body/SSE stream exists,
not released merely when response headers have been returned. Worker action
queues and image bounds remain those of the existing provider.

The primary toolkit service routes current MCP 2026-07-28 requests statelessly.
Legacy initialization is supported with a separate bounded actor-custody map.
Only transport-issued live IDs can be bound. A different authenticated caller
cannot reuse an old session for GET, DELETE or tool calls. Modern requests are
not turned into legacy sessions merely because a stale legacy header exists.
The SDK still validates protocol/body/header agreement. No custom protocol
parser or legacy replay database is introduced.

## DevTools

The worker's optional CDP endpoint is still loopback-only and scoped to that
lease's browser. It is not the public MCP endpoint. Keep it private. A DevTools
companion may attach through the intended private access path; this extension
does not add a generic network CDP proxy or share other agents' browser targets.

## Verification

`tests/http.integration.test.mjs` uses a local RSA/JWKS issuer and the compiled
Rust server. It exercises missing/wrong credentials, scope and Origin rejection,
typed screenshots, state continuity, fresh tokens, cross-owner access, two
same-owner sessions, diagnostics, stream cancellation, legacy custody, quotas,
and real native TLS with explicit CA trust. No real account, paid service or
public authenticated page is needed. These tests are not claimed as passing
until the release verification actually runs them.
