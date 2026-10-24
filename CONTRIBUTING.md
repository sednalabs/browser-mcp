# Contributing

Contributions are licensed under Apache-2.0. Preserve applicable source notices
and document adapted code. Do not copy private repository content or credentials
into public tests or reports.

Read AGENTS.md. Keep browser behavior in the worker, transport semantics in
RMCP/toolkit, and authenticated application lease ownership in the HTTP adapter.
Use real synthetic-browser fixtures rather than personal authenticated sites.

Run `node scripts/verify.mjs` before requesting review. The script resolves a
pending dependency graph, formats Rust, runs both transport modes' checks and
executes the real-browser test suites. Commit the resulting Cargo.lock and
formatting changes. Do not equate a syntax check or a skipped browser suite with
end-to-end verification.
