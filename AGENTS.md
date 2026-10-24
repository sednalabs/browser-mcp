# Browser MCP development

This repository owns a persistent Playwright browser session exposed through a thin Rust MCP host. Keep browser-specific state and behavior in `worker/`; keep MCP framing, host process supervision, and transport cancellation in Rust. Use `mcp-toolkit-rs` for shared primitives where its existing API fits.

## Invariants

- In stdio one provider owns one live browser session; in HTTP each authenticated application lease owns a separate provider worker. Never attach to a user's default browser profile implicitly.
- Serialize each browser operation through its final observation. Validate an entire action batch before performing any action.
- Keep screenshots as typed MCP image content. Text, file paths, and serialized base64 are not substitutes for model-visible image blocks.
- Preserve action receipts when screenshots or artifacts fail. Do not replay mutating operations after timeouts, cancellation, or lost responses.
- Ordinary observation does not resize, scroll, or navigate. `browser_step` exposes viewport changes as explicit mutating actions; responsive review remains a separate temporary capture with per-image geometry and restoration status.
- Session state and visual results must not be cached across calls.
- Own and clean up keys, mouse buttons, browser profiles, process groups, and optional diagnostic endpoints explicitly.
- Keep credentials out of tool arguments, normal diagnostics, logs, and checked-in fixtures. Authentication configuration is session-scoped.
- Keep schemas in `worker/tools.json` and their generating source aligned; the Rust host advertises that catalog.

## Development

Use Rust 1.99 and Node.js 22 or newer. Local build and synthetic-browser tests are appropriate in this standalone repository. Do not run against personal authenticated sites when a local fixture can verify the behavior.

Run `cargo fmt --check`, `cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings`, and `npm test`. Protocol tests must exercise the compiled Rust binary and real Chromium, including modern MCP discovery without initialization and legacy initialization. Test failures should be fixed or described precisely; do not mark skipped browser tests as successful qualification.

Keep `Cargo.lock` and `package-lock.json` committed. Update dependency provenance and validation evidence when changing pinned toolkit, SDK, or Playwright versions. Maintain a clean source archive without `.git`, dependencies, build products, credentials, or browser profiles.

## HTTP extension

Use `LocalMcpHttpRuntimeBuilder`/`LocalMcpHttpRouterBuilder` and `AuthSurfaceLayer` from the toolkit. Consume the request-bound authentication witness before handing work to RMCP and retain only a non-secret principal. A protocol session ID is not a browser lease or an authorization token. Browser calls must acquire an authenticated application lease; every worker gets a separate temporary profile. Do not copy the older build-helper router or its unbounded body-read path.

Keep lease ownership through actual worker settlement even when an HTTP request is dropped. Closed/expired workers remain charged against capacity until cleanup confirms completion. Never evict a live worker just to make capacity. A new process starts with a new empty lease registry; do not silently restore a browser by reopening a URL.

The source candidate carries `Cargo.lock.pending` because the HTTP dependency graph has not been resolved in its authoring environment. `node scripts/verify.mjs` must regenerate and validate it before the first PR is published. Never claim the historical stdio baseline tests qualify the HTTP changes.
