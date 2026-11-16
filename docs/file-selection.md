# Explicit, granted file selection (stdio only)

`set_files` is a mutating action. Selecting a file can **immediately transmit its
bytes** through the page's change handlers, without clicking Submit. Obtain the
user's approval for the specific file contents and destination before calling it.
An operator grant is a capability boundary, not evidence of that consent. Never
retry a selection with an uncertain receipt, automatically submit a form, or use
this feature to work around a confirmation boundary.

The default inventory is empty. An operator may configure up to four exact files
in the private `SEDNA_BROWSER_CONFIG` JSON file:

```json
{"file_grants":[{"path":"/absolute/path/to/approved-fixture.txt","allowed_origins":["https://approved.example"]}]}
```

The worker snapshots each regular file once at startup, at most 1 MiB per file
and 4 MiB total. Both the operator config and source files must be staged under trusted POSIX directories: every path component and
the file must be owned by the effective user or root and must not be writable by
group/other users. Shared temporary directories (including sticky `/tmp`) are
rejected. Do not change system permissions to enable this feature; use a private
staging directory under the operator's trusted home. Observed symlink components,
unsupported platforms and file replacement/change are rejected. The threat model
excludes a malicious same-user or root process changing trusted directories;
before/after path checks are not atomic descriptor-relative directory traversal.
Staging must also not grant other principals write access through ACLs or network
filesystem semantics: these checks are not a universal filesystem ACL auditor.
Use local storage with trusted POSIX ownership and permission semantics. Reads use one non-following, nonblocking file
descriptor with bounded allocation and before/after identity checks. Source paths
and file bytes are never returned in status/errors. Keep this operator config
outside repositories. Do not provision credentials or sensitive files without
separate authorization for the intended transmission.

`browser_session` status lists random worker-local `file_grants` handles, safe
basenames, byte sizes and permitted exact page origins. Tools accept only these
handles, never arbitrary paths, URLs or encoded file bytes. The payload MIME type
is `application/octet-stream`; this slice does not infer or override MIME types.
The granted immutable snapshot is selected even if the source file later changes.
Restart the worker to grant new contents. Close/reset/disconnect/shutdown revoke
all existing handles and wipe retained buffers; grants do not reappear until a
new worker explicitly reads the operator configuration. Handles cannot be used in
another worker. HTTP leases reject any file-grant configuration before reading
files, so global configuration cannot leak operator files across tenants.

```json
{"actions":[{"type":"set_files","target":{"css":"input[type=file]"},"handles":["file_HANDLE_FROM_STATUS"]}]}
```

Targets must be real main-frame file inputs. The action resolves one element,
checks the page origin and single/multiple-file constraints, then selects on that
same element without reopening any local file. Frame-targeted selection is not
supported. Empty `handles: []` explicitly clears the input only while active
grants allow that page origin. Unknown/revoked handles invalidate the entire batch
before earlier actions execute; dynamic target/origin failures stop at that action.

Origin restrictions identify the page receiving the bytes. They are not a network
egress firewall: an authorized page can process, persist or forward received file
contents. Only grant origins you intend to trust with those bytes. No chooser is
opened and no arbitrary page script/File object is injected. This supports the
MCP file-input journey, not OS-native picker automation or durable upload/storage
confirmation. Fixture verification uses only fictional files and loopback pages.
