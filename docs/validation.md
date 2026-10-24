> Historical evidence for the original stdio ZIP only. The HTTP extension is not covered here; see [validation-current.md](validation-current.md).

# Validation record

Validation date: **2026-10-19**. This is a source repository for an initial commit,
with installation and regression evidence for the implemented browser server.

## Dependency identity

| Component | Verified source/version |
| --- | --- |
| Rust compiler | 1.99.0; committed toolchain and declared 1.99 compatibility floor |
| Node used for browser tests | 24.19.0; package requires Node 22 or newer |
| RMCP runtime and macros | 3.5.1 |
| Official RMCP release ancestor | `79437f291b2c44053d00dcd5db969fd0cca7c887` |
| Maintained Sedna SDK | `1d2e6ffdaccc7711552154dd2c9d7af4913a8f1e` |
| Sedna toolkit | `07262fabdca86802f9e3c33f25d73b87f05e903f` |
| MCP current mode | 2026-07-28, per-request metadata and lifecycle-neutral discovery |
| MCP legacy mode exercised | 2025-11-25, initialize then initialized notification |
| Playwright | 1.64.1, exact package pin and registry integrity lock |
| Chromium tested | Chrome for Testing 156.0.8078.4, matching this Playwright release |
| JSON Schema validation | Ajv 8.20.0, exact package pin and registry integrity lock |

The source overrides use public immutable Git commits. The SDK commit's tree is
`3161574d9486ee1d733bce80aa53168c415f7031`, matching the independently reviewed
local merge. Relative to official 3.5.1, it changes only the maintained HTTP tower
implementation, three targeted regression files and fork CI. There is no stdio,
protocol-model or core-service divergence. See [provenance](provenance.md) for
primary specification and release references.

Dependency update reviews:

- [Sedna Rust SDK PR #4](https://github.com/sednalabs/rust-sdk/pull/4)
- [Sedna MCP Toolkit PR #312](https://github.com/sednalabs/mcp-toolkit-rs/pull/312)

SDK PR #4 passed all 16 applicable hosted checks (with the release job correctly
skipped) and was merged into `ops-sdk-3.5` as
`8bbec0ad47781dc00083c7e408aeeab78b440c6d`. Its landing tree matches the validated
SDK source tree above. [SDK CI evidence](https://github.com/sednalabs/rust-sdk/actions/runs/39247661639).

Toolkit PR #312 passed all nine required repository gates and all 12 triggered
workflows: 68 successful checks and one expected scheduled-scan skip. It was
merged to `main` as `b5173f3212ba4d82369443e93bc59ac8a71e9a02`. The canonical
remote `main` was verified at that revision, with tree
`5585cd80a1aba929d8db5cb3d342242353f7f2cf`, identical to the pinned, tested toolkit
source. [Toolkit check evidence](https://github.com/sednalabs/mcp-toolkit-rs/pull/312/checks).

The manifests pin the reviewed public source commits, and the normal squash
landings have the same source trees. No crate-registry release was performed.

## Final source test results

These checks ran with both final public Git dependency pins and the rebuilt Rust
binary. All tests passed; none were skipped or cancelled.

| Check | Result |
| --- | --- |
| Rust host/protocol/supervisor suite, locked dependencies | 13 passed |
| Real Chromium worker suite | 17 passed |
| Actual MCP browser/protocol/lifecycle suite | 18 passed |
| Runtime/embedded tool catalog comparison | All 6 tool schemas match |
| Rust formatting | Passed |
| Clippy, all targets, warnings denied | Passed, no warnings |

The toolkit update also passed 16 scoped HTTP contracts and the new lifecycle
contract in each of its two maintained stdio templates before publication.

## Clean archive installation

The source archive was extracted into a separate directory without either donor
checkout or any installed dependencies. `npm ci --ignore-scripts --no-audit
--no-fund` installed the locked JavaScript packages. With a new, empty Cargo
cache and a separate target directory, `npm run setup -- --skip-browser` fetched
both public Git dependencies, downloaded the locked crates and completed an
optimized release build successfully. No source paths or local Git overrides
were supplied. Locked offline metadata still passed afterward.

The documented Node launcher was then invoked from outside the repository with
the managed matching Chromium executable. Its `--check` command started the
browser, captured a 1280-by-800 PNG and shut down successfully. A second launcher
check exercised ordinary MCP stdio: a current `tools/list` returned all six
tools, `browser_observe` returned a real inline PNG of the same dimensions, and
stdin EOF led to a clean exit. No npm banner or image base64 was emitted as
ordinary protocol text.

The final archive's executable source, package manifests and lockfiles are
byte-identical to this tested extraction. The validation record was completed
afterward to include these results.

## Browser behavior exercised

The browser suites use an actual compiled Rust MCP server, the actual Node
worker and real Chromium against a deterministic local HTTP application. They
do not substitute a fake screenshot or mock DOM for the browser integration.

- Current metadata-bearing requests and discovery work before any legacy
  initialization; discovery does not launch Chromium.
- Legacy initialize clients execute browser actions and receive actual images.
- PNG/JPEG bytes, MIME types, image count, geometry and size limits are checked
  in ordinary MCP content. `structuredContent` is absent.
- Menus, unsaved form values, page JavaScript, focus, viewport and scroll remain
  live between ordinary observations.
- Invalid later actions are rejected before any action in the batch executes.
  Runtime failures retain completed and unstarted action receipts without replay.
- Coordinate actions reject stale observations and use viewport CSS geometry.
- Failed and cancelled actions release their owned keys/buttons. Cancellation
  reconciliation reads the retained last-operation receipt because an MCP
  cancelled call's response may be suppressed.
- Responsive review produces multiple real images and reports restoration of
  viewport and scroll; it does not claim application-state rollback.
- Console/network metadata and cursor updates are retained in bounded history.
- Tabs with identical URLs retain distinct page IDs and exact Chrome target IDs.
- Native dialogs return an explicit blocked receipt and fence ordinary mutations
  until tracked input settlement and cleanup. Dialog resolution by an external
  companion is also reconciled without leaving the fence stuck.
- An optional CDP companion can disconnect without closing the owned browser.
- Concurrent owners have isolated sessions; reset invalidates prior page IDs.
- Unexpected Chromium loss requires explicit recovery. Killing the exact owned
  Node worker closes Chromium and does not trigger host replay or worker restart.
- Worker tests also exercise dedicated profile exclusivity and origin-scoped
  service headers, including redirects and configured-value redaction.

The Rust suite additionally exercises bounded NDJSON framing, oversized input,
unknown-tool rejection before dispatch, modern cache hints, queue retention,
caller-drop cancellation, late cancellation acknowledgment ordering and worker
retirement. Queue saturation rejects excess calls immediately rather than
retaining an unbounded number of suspended callers.

## Reproduce the checks

```sh
npm ci
npx playwright install --with-deps chromium
npm run check:catalog
cargo fmt --all -- --check
cargo test --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
npm test
python3 scripts/package.py
```

For a managed matching browser, set `SEDNA_BROWSER_EXECUTABLE` instead of
installing another browser. `SEDNA_BROWSER_BINARY` selects a compiled host when
using a nondefault build directory. See [operations](operations.md).

## Environment and scope

The recorded browser runs use Linux x86-64 in a root container. They explicitly
set `SEDNA_BROWSER_NO_SANDBOX=true` because this container cannot run Chromium's
sandbox. Normal configuration leaves the sandbox enabled. The included GitHub
workflow uses an Ubuntu 24.04 runner and the normal browser-install command.

This environment's Playwright CDN request was unavailable. The matching Chrome
for Testing build was downloaded from Google's official distribution and its
version verified before testing. The managed-executable setup path is therefore
also exercised. This does not establish behavior for an arbitrary Chrome build.

Abrupt-worker cleanup was verified with and without the optional CDP port on
this Linux/browser combination. Windows and macOS behavior has not been
qualified in this environment. Tests use synthetic application data; they do
not establish compatibility with every website, SSO flow or extension.

Service-header mode buffers ordinary authenticated HTTP responses. It does not
provide authenticated streaming or WebSocket support, and its post-fetch size
check is not a streaming memory limit. The optional CDP attachment point allows
a separate DevTools companion; this repository does not implement a second full
profiling/tracing server. Those boundaries are described in
[architecture](architecture.md) and [operations](operations.md).

The source ZIP excludes Git history, prebuilt binaries, Chromium, dependency
directories, browser profiles, credentials and runtime captures. Setup downloads
and builds the dependencies. The new repository's own hosted CI will first run
after this source is committed and pushed to GitHub.
