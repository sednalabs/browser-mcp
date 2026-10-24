## Summary

Initial standalone Sedna Browser MCP, with the existing visual-first
Playwright implementation and an authenticated Streamable HTTP/HTTPS adapter.
This PR does not remove or modify the Browser implementation in Codex.

The six browser tools retain typed image results, ordered action receipts,
responsive review, diagnostics and the existing worker supervisor. Stdio remains
the default. HTTP uses the shared toolkit's current/legacy protocol routing,
OAuth resource metadata and request authentication.

## HTTP ownership and security

- Fresh private worker/profile per explicit browser lease, even for two threads
  sharing one OAuth principal.
- Principal bound to validated issuer, subject and client; no browser authority
  from MCP transport IDs, URL matching or forwarded headers.
- Separate bounded legacy transport custody, with cross-owner rejection.
- Current authentication checked for every request; no retained bearer token in
  the application lease or worker.
- Native TLS or loopback origin behind a trusted HTTPS proxy. No public
  unauthenticated mode.
- Finite request/body/browser limits. SSE responses retain capacity until body
  completion/drop. Closing workers remain charged until cleanup confirms.
- Request cancellation retains the browser lease through worker settlement;
  lost receipts are reconciled without replaying mutations.
- No shared profile inherited from the operator environment in HTTP mode.

## Licence

Apache-2.0. Preserve the original Sedna/OpenAI Codex attributions in NOTICE and
prominent modification notices on adapted worker code. No private build-helper
source or runtime credentials are included.

## Validation and readiness

See `docs/validation-current.md` and `docs/verification-run.json`. The source
candidate was prepared in an environment without Rust or package-download
access. Only the explicitly recorded local JavaScript/schema checks were run
there; the historical stdio evidence is not HTTP qualification.

The publishing script refuses to create the repository until a subsequent
`node scripts/verify.mjs` run resolves the lockfile and passes the Rust, worker,
HTTP/HTTPS and packaging checks. Hosted CI is still required before marking
this PR ready and merging. A browser-to-Codex model-request visual test is a
separate integration gate.
