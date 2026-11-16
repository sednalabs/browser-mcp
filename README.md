# Sedna Browser MCP

A standalone visual-first browser MCP: look at a live page, act on it, receive
the resulting screenshot, and continue in the same browser. A Rust/RMCP host
supervises the existing Node/Playwright runtime. Both local stdio and
authenticated Streamable HTTP/HTTPS use that same worker implementation.

**Validation:** this repository has hosted Rust, worker and compiled MCP checks.
See the [latest CI runs](https://github.com/sednalabs/browser-mcp/actions/workflows/ci.yml)
for the exact revision under test. Historical authoring-environment limits in
[validation notes](docs/validation-current.md) are not current deployment proof.
A passing fixture suite does not by itself qualify an installed consumer or service deployment.

## Get started

Requires Node.js 22+, Rust (the repository pins 1.99.0), a native C toolchain
and Chromium system libraries.

```sh
npm ci
npm run setup
node scripts/start.mjs --check
```

The committed lockfile is used by locked release builds. Install Linux browser system libraries
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

Optional `semantic: {}` on observe/step adds bounded DOM-derived roles, names,
state and hierarchy alongside the same inline image. See [contract and limitations](docs/semantic-observations.md).

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
substitute for exact-revision integration and deployment verification.

## Reading without pixels

`browser_observe` and `browser_step` accept `reading: {max_chars: 8000,
max_blocks: 64, root_css: "main"}` for bounded readable text alongside the default
native MCP screenshot. Use `screenshot: false` to skip screenshot capture;
reading is then enabled by default. See [reading coverage and freshness](docs/reading.md).

### Bounded element geometry

For non-control layout checks (for example a clipped advertisement), pass
`element_geometry: { selectors: ["#ad", "#container"], max_matches: 8 }` to
`browser_observe` or `browser_step`. It is opt-in, limited to eight CSS selectors
of at most 1,000 characters each and at most 16 matches per selector (default 8).
Results use selector/match indices rather than echoing selectors or page text.
Each match includes a viewport-CSS-pixel rectangle, client/scroll dimensions,
computed overflow and visibility, and the same measurements for its immediate
parent. Missing and invalid selectors are explicit; a truncated flag means more
matches existed. No form values or arbitrary JavaScript are returned/accepted.

This read does not scroll, resize, focus or navigate. It stays in the chosen page's
main-frame light DOM; it cannot enter iframe documents or shadow roots. Visibility
is not proof of being unobscured or unclipped. Compare parent/viewport/scroll bounds
and the screenshot. Geometry carries the page and observation IDs and is withheld
if bounded before/after reads or capture geometry disagree. Matching reads are
not an atomic snapshot and must not be treated as a guarantee against later layout
changes. Inspect again before acting on stale measurements.

## Granted file selection

Stdio operators can grant immutable bounded file snapshots for explicit `set_files`
actions. Selection may immediately upload bytes; grants do not replace user consent.
Disabled by default and unavailable to HTTP leases. See [file-selection boundaries](docs/file-selection.md).
