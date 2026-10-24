# Security policy

This is browser automation, not a passive document reader. An authorized browser
user can interact with sites and networks reachable from the browser host.
Run the service as a dedicated unprivileged user, preferably in a disposable
container/VM with deliberately limited network egress. Do not put host cloud
credentials, Docker sockets or personal browser profiles in that environment.
Browser profile separation is not a substitute for operating-system isolation.

HTTP mode requires authenticated scoped JWTs on every MCP request. Keep the
issuer and exact resource audience configured by the operator. Prefer a
private deployment even with TLS. Non-loopback native HTTP without TLS is
refused. Reverse-proxy deployments bind the application to loopback and retain
application-side token verification. A public `/healthz` response contains no
browser inventory or credentials.

Service-header templates deliberately grant upstream access; do not share a
deployment across trust domains that should not share those grants. Inbound MCP
bearer tokens are never forwarded to web pages. Screenshots can contain secrets
visible on the page, so textual redaction alone does not make them non-sensitive.
Console/network data and all page contents are untrusted.

Disable or privately scope the optional Chrome debugging endpoint. Anyone with
unrestricted CDP access can interfere with the browser independently of MCP
approval and ownership rules. Do not expose it alongside the public MCP route.

No application-level operation is retried merely because a network connection
failed. Interrupted input may already have effects. Leases do not survive a
process restart, and a lease identifier alone never authorizes access.

Report sensitive vulnerabilities through the repository's private security
reporting facility when enabled. Do not put credentials, private screenshots
or exploit details for a live deployment in a public issue. Until a repository
exists, no reporting endpoint or email address is represented as established.

The current HTTP candidate is uncompiled/unqualified in its authoring
environment. See docs/validation-current.md before deployment.
