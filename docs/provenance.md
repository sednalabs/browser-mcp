# Provenance and dependency policy

## Browser implementation source

The user supplied `01-codex-main-1.zip`, whose ZIP comment identifies revision
`1cff1bf1c78cb878a95ba5339daf359eb6b9ee2f`. The relevant code in that archive is:

- `codex-rs/browser-computer-use/src/browser_playwright_provider.mjs`
- `codex-rs/browser-computer-use/src/browser_playwright_review.mjs`
- `codex-rs/browser-computer-use/src/browser_playwright_service_headers.mjs`

`worker/actions.mjs` adapts the Playwright action/locator approach;
`worker/dom.mjs` adapts compact control discovery and label-first field naming.
The capture, service-header and responsive-review approaches inform the matching
modules. The standalone runtime, serial operation ownership, receipt retention,
input cleanup, stale-view checks, Rust MCP adapter and tests are implemented for
this repository. No dependency on a surrounding Codex checkout remains.

The supplied tree's `codex-rs/core/config.schema.json` contains the stdio MCP
`command`, `args`, `startup_timeout_sec` and `tool_timeout_sec` fields used by the
Codex configuration example. The example is configuration guidance; these tests
exercise the wire protocol rather than an entire interactive Codex build.

The donor source is Apache-2.0. Applicable OpenAI and Sedna attribution is retained
in `NOTICE`, and the Apache license text is included in `LICENSE`.

## Rust SDK and toolkit

The Rust host consumes these small Sedna toolkit crates:

| Crate | Use |
| --- | --- |
| `mcp-toolkit-core` | RMCP type/trait re-export, maintaining one SDK type universe. |
| `mcp-toolkit-server` | Stdio lifecycle and standard tool-list handling. |
| `mcp-toolkit-process` | Unix process-group setup and termination primitives. |
| `mcp-toolkit-testing` | Actual Rust stdio protocol contract tests. |

The existing toolkit uses a Sedna fork of the official Rust SDK for carried HTTP
transport fixes. The update preserves those fixes while incorporating official
RMCP **3.5.1**. The browser's root manifest repeats the required Cargo patch,
because a dependency's own `[patch.crates-io]` section does not control the
consuming workspace. Both toolkit and SDK Git dependencies are pinned to
immutable public commits in `Cargo.toml` and fully resolved in `Cargo.lock`.

The Browser MCP server itself exposes stdio only; the preserved HTTP fixes are
part of the shared toolkit's downstream compatibility, not a second browser
transport.

Primary references, checked on 2026-10-19:

- [Official Rust SDK releases](https://github.com/modelcontextprotocol/rust-sdk/releases)
- [RMCP 3.5.1 API documentation](https://docs.rs/rmcp/3.5.1/rmcp/)
- [MCP 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP versioning and current/legacy request handling](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [Sedna MCP Toolkit](https://github.com/sednalabs/mcp-toolkit-rs)
- [Sedna Rust SDK fork](https://github.com/sednalabs/rust-sdk)

## JavaScript runtime and CI

Direct runtime dependencies are pinned exactly in `package.json` and locked with
registry integrity values in `package-lock.json`: Playwright **1.64.1** and Ajv
**8.20.0**. Their own licenses remain applicable. Dependencies and browser
executables are installed during setup and are excluded from the source ZIP.

The initial CI workflow pins official GitHub Actions to reviewed immutable tag
commits: checkout 7.0.1, setup-node 7.1.0, and upload-artifact 7.0.2. Updating a
version means updating its immutable reference as well as the documentation.

## Upgrade procedure

Confirm the current stable RMCP release and MCP spec using the primary sources.
Update the Sedna SDK fork without dropping carried fixes; run its required tests
and hosted checks. Update the toolkit's exact SDK requirements and immutable
patch revision, then its protocol and downstream tests. Finally update this
repository's toolkit and root SDK revisions, regenerate `Cargo.lock`, and run
the current/legacy browser suites. Keep the shared tool catalog synchronized and
preserve the ordinary MCP image blocks throughout an upgrade.


## Streamable HTTP/HTTPS candidate (2026-10-19)

The new `src/http/` implementation is original Sedna code composed against
public toolkit interfaces, with native rustls serving patterned on the public
GA4 MCP. No private build-helper source is vendored. The intended immutable
pins are toolkit `b5173f3212ba4d82369443e93bc59ac8a71e9a02` and maintained SDK
`8bbec0ad47781dc00083c7e408aeeab78b440c6d` (RMCP 3.5.1).

The earlier stdio lockfile is preserved as `docs/baseline-stdio.Cargo.lock` and
in the pending root lockfile. The added HTTP graph is not represented as
resolved until Cargo regenerates it. See `Cargo.lock.pending` and
`docs/validation-current.md`.
