# Operation and maintenance

## Build and readiness

`npm ci` resolves the exact JavaScript lockfile. `npm run setup` uses
`cargo build --release --locked` and installs Chromium for the pinned Playwright
version. Cargo fetches the pinned public Sedna toolkit and SDK commits; the
checkout does not require a sibling toolkit repository.

`node scripts/start.mjs --check` validates the assembled runtime by launching
Chromium and capturing a viewport. The Rust binary also provides `--help`,
`--version`, `--print-tools` and `--print-tool-schema`. The last two require
neither Node nor a browser launch.

Use `SEDNA_BROWSER_BINARY` for a relocated/custom binary, or set a Cargo target
directory when building. The default launcher always uses the release profile;
developers can select `target/debug/sedna-browser-mcp` explicitly. Keep the binary
and worker from the same source revision: the host embeds the catalog at build
time, while the worker validates calls from `worker/schemas.mjs`.

On a root container or Linux environment without usable Chromium user namespaces,
the default sandbox-enabled launch can fail. Opt into
`SEDNA_BROWSER_NO_SANDBOX=true` only when that is an intentional property of the
container. It is not the default in client examples. CI sets the override only
for disposable local-fixture browsers on runners that block user-namespace
sandboxing; that coverage does not prove a sandbox-enabled launch works there.

When the provider reports `CHROMIUM_SANDBOX_UNAVAILABLE`, it has not disabled
Chromium's sandbox or retried with weaker flags. On Ubuntu hosts that restrict
unprivileged user namespaces, prefer a root-owned AppArmor profile allowing
`userns` for the exact pinned Chromium executable. Keep the executable and its
parent directories root-owned and non-writable by the MCP account; a profile
matching an executable under a user-writable package directory does not protect
against replacement by that user. Avoid wildcard paths and do not disable the
host-wide `apparmor_restrict_unprivileged_userns` setting. See Chromium's
[AppArmor user-namespace guidance](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).
Do not use `SEDNA_BROWSER_NO_SANDBOX` when browsing the open web.

## Local configuration

Keep local settings under an ignored `.local/` directory or another private
operator-owned location. Set `SEDNA_BROWSER_CONFIG` to the absolute JSON path.
Configuration is loaded once at worker startup; restart the host to apply a
change. Unknown keys and invalid field types/ranges fail clearly.

On Unix the configuration file must belong to the current user and must not be
writable by a group or other users. Use mode `0600` for a file containing literal
service credentials. Prefer environment-variable references in `env_headers`.
Do not commit a populated local auth file.

Recognized JSON settings are `profile`, `executable`, `headless`, `cdp`,
`no_sandbox`, `viewport`, `service_auth`, `action_timeout_ms` and
`operation_timeout_ms`. Environment overrides are listed in the README. A
separate `SEDNA_BROWSER_AUTH_FILE` contains the service-auth object itself,
rather than a whole browser configuration object.

## Profiles and recovery

Use a dedicated automation profile instead of a user's ordinary interactive
Chrome profile. Persistent profile paths must be absolute, resolve without
symlinks, and on Unix have current-user ownership and mode `0700`.

The worker atomically creates `.sedna-browser-mcp.lock` in the profile and writes
owner metadata. A second provider cannot reserve the same directory. Normal
shutdown removes the lock. Explicit `browser_session close` closes Chrome but
retains the worker's profile reservation, allowing an intentional later reopen.
Reset relaunches against that reserved profile and invalidates old page IDs; it
does not delete persistent cookies/storage.

A hard process kill can leave a temporary profile or persistent-profile lock on
disk even when Chromium has exited. Before removing a stale lock manually,
confirm that its owning worker and Chromium are gone and no other provider uses
the profile. The software never guesses ownership or steals a lock. An explicit
profile is never automatically deleted.

After an unexpected browser disconnect, read status and perform an explicit
`browser_session reset` if a new live session is desired. After a worker crash or
retirement, start a new MCP server process. Inspect external application state
before repeating an action whose outcome was uncertain.

## Service-header behavior

The authenticated route fetches one HTTP response at a time, using
`maxRedirects: 0` and `maxRetries: 0`, and fulfills the corresponding browser
request. Exact-origin matching is checked for every request. Configured header
names are stripped on unapproved origins; service workers are blocked in this
mode so they cannot bypass the route.

Playwright's request API buffers responses. A declared response size above
16 MiB is rejected after fetching; the response may already have been buffered
at that point. This check is not a streaming memory bound, including when
Content-Length is accurate. Use this mode for ordinary pages/API traffic, not large
authenticated downloads or event streams. No request/response bodies or headers
are retained by the inspector. Configured header values are redacted from text,
while arbitrary application-rendered pixels remain application content.

## Testing

The repository uses three complementary test levels:

1. Rust tests exercise framing, typed result projection, protocol versions,
   cancellation queue retention, late control acknowledgments and worker failure.
2. Worker tests exercise validation, browser lifecycle, native input, profile/auth
   boundaries, capture and diagnostic behavior using local fixtures.
3. JavaScript protocol tests spawn the compiled Rust binary and use real Chromium
   to verify the complete MCP path and independent browser state.

The Linux abrupt-worker-death test discovers exact parentage and process start
identity before signaling only its own test worker. It confirms that Chromium
exits when the owning debugging pipe closes, even though Playwright launched
Chrome in a separate process group. This is evidence for the tested Linux,
Playwright and Chromium versions; it does not claim that Unix process-group
signals alone kill every possible browser child on every operating system.

Browser tests need loopback sockets and normal browser process privileges. Test
fixtures use localhost and contain no real user accounts or production services.
See `docs/validation.md` for the actual release verification record.

## Source ZIP

`python3 scripts/package.py` writes a deterministic ZIP under `dist/` and reports
its SHA-256 hash and file count. It includes the public source directories and
required root files. It excludes `.git`, Cargo targets, npm dependencies,
`.local`, test outputs, browser profiles and unrelated workspace files.

The ZIP has one `sedna-browser-mcp/` root and can be used for the first Git commit.
It is source, not a prebuilt offline runtime; setup requires access to the pinned
Git/Cargo/npm sources and the browser download origin.
