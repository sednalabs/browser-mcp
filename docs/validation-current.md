# Validation of the HTTP/HTTPS candidate

Prepared 2026-10-19 from the supplied `sedna-browser-mcp-0.1.0-source.zip`.
The prior `docs/validation.md` describes the earlier stdio baseline only.
It does not qualify this changed dependency graph or HTTP implementation.

Executed in this authoring environment:

- Four new Node tests for HTTP worker/profile isolation: passed, no skips.
- Original shared worker/stdin tool catalog consistency: passed, six schemas.
- JavaScript syntax checks over every `.mjs` file: passed.
- JSON and TOML parsing: passed (9 JSON and 4 TOML files at the check).
- Python syntax: passed for the packaging script.
- All six worker input schemas passed Draft-aware JSON Schema structural checks.
- Full verification was attempted and stopped at dependency preparation because
  Cargo was unavailable. The pending lockfile marker was retained. Exact outcome
  is recorded in `docs/verification-run.json`.

Not executed here:

- Rust formatting, compilation, unit tests or clippy.
- The new native HTTP/HTTPS and browser integration tests.
- An end-to-end Codex model request over HTTPS.
- Hosted GitHub CI, repository creation or PR publication.

The container has no Rust toolchain and cannot fetch packages. No passing Rust
or HTTP result is inferred from source inspection or from the earlier stdio
artifact. `Cargo.lock.pending` marks the unresolved HTTP dependencies rather
than presenting the old lockfile as a validated new graph.

The repository's publishing script first invokes `scripts/verify.mjs`; that
runs the missing build/tests in a properly equipped environment and stops on
failure before any repository is created. A successful run generates
`docs/verification-run.json` with its concrete commands, times, platform and
source digest. It does not claim hosted CI or a model-perception benchmark.
