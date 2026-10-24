# MCP and worker protocol

## Public transport

The public MCP transport is newline-delimited JSON-RPC on stdin/stdout, provided
by RMCP through the toolkit's stdio builder. Server diagnostics go to stderr.
There is no separate HTTP listener and no browser-launch side effect in tool
discovery.

The target is [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28),
whose current mode uses per-request version/client metadata and `server/discover`.
For example, a current tool-list request is:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "example-client", "version": "0.1.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

The legacy path accepts `initialize` with `protocolVersion: "2025-11-25"`, followed
by `notifications/initialized`. RMCP performs the version-specific envelope
projection. The tests exercise actual tool calls and images through both paths,
not just an initialization response.

Current tool-list results set `ttlMs: 0`, `cacheScope: "private"` and
`resultType: "complete"`. Tool-call results are complete ordinary `content`
results. The host does not invent unsupported no-cache fields on tool-call
results, and contains no observation/result cache.

## Result content

The first content block is a JSON text receipt. Subsequent image blocks are
actual base64-encoded PNG or JPEG images with the corresponding MCP MIME type.
The text receipt identifies each image by its `content_index` and own geometry.
It does not embed image base64 in prose.

```json
{
  "content": [
    { "type": "text", "text": "{...receipt and image manifest...}" },
    { "type": "image", "mimeType": "image/png", "data": "BASE64_IMAGE_BYTES" }
  ],
  "isError": false
}
```

`isError` is present when the result represents a failure; clients should also
read the operation and per-action status. A failure can contain a useful current
image. Failure to capture a final observation does not erase already completed
actions from the receipt.

If a native dialog blocks Chromium capture, the text result explicitly includes
the dialog and `observation_unavailable` and has no image block. Resolve that
dialog or reset/close the session; ordinary mutations remain fenced while its
tracked input continuation is pending.

`structuredContent` is deliberately omitted. In a client Code Mode wrapper,
forward each image as image content and each text block as text. For example:

```javascript
const result = await tools.browser_observe({});
for (const block of result.content) {
  if (block.type === 'image') image(block);
  else if (block.type === 'text') text(block.text);
}
```

The exact tool function name depends on the client's registration namespace.
Printing the base64 string as ordinary text does not expose the screenshot to
the model's visual input.

## Internal worker framing

The worker is an operator-selected implementation component, not a second MCP
server. The Rust actor sends one bounded newline-delimited request at a time:

```json
{ "id": "op-3", "method": "browser_observe", "params": {} }
```

The worker replies with that ID and either `result` containing MCP-style content,
or `error` containing a code/message. Cancellation is a separate control message:

```json
{ "id": "cancel-op-3", "method": "cancel", "params": { "operation_id": "op-3" } }
```

Its acknowledgment does not complete or free the original operation. The actor
waits for the original receipt or the cleanup deadline. Known late control
acknowledgments are ignored without being mistaken for the next operation's
response. Unknown/mismatched operation IDs and invalid/oversized frames retire
the worker rather than risking request/response confusion.

`shutdown` closes the browser and releases the profile reservation. Stdin EOF and
ordinary termination signals use the same cleanup path. The Rust supervisor
then applies bounded termination if cooperative cleanup does not finish.

## Bounds

| Boundary | Limit/default |
| --- | --- |
| Host tool-argument payload | 128 KiB |
| Host admission queue | 32 pending operations |
| Worker response frame | 32 MiB |
| Action batch | 1–16 actions |
| Review | 1–4 images |
| Viewport | 320–1920 wide, 240–1600 high, CSS pixels |
| Individual image | 4 MiB before base64 encoding |
| Action timeout | 5 seconds by default; configurable 100–5000 ms |
| Worker operation budget | 60 seconds by default; configurable 1–90 seconds |
| Host call budget | 120 seconds by default, followed by 30-second cancellation grace |
| Last operation receipt | Bounded text, no retained image data |
| Diagnostic ring | 512 events per page; up to 200 events per inspection |

Operations check their worker budget between effects and during cooperative
waits. These are bounds on work and cleanup, not a promise to reverse an action
that has already reached the browser.
