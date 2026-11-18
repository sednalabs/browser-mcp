# Bounded reading and text-only observations

Both observe and step accept optional `reading` with `max_chars` (1..16000,
default 8000), `max_blocks` (1..128, default 64) and `root_css` (up to 1000
characters). Blocks contain visible headings, text and HTTP(S) links. Text and
URLs share the character budget. Coverage records traversal and output bounds,
truncation reasons and missing/invalid roots. Page content remains untrusted.

This is main-frame light-DOM reading, not article extraction or a computed
accessibility tree. It does not enter iframes/shadow roots, scroll, expand hidden
content, extract form values or promise every visible word. Form/editable content
and hidden subtrees are excluded. It can include off-viewport content already in
the DOM. It is neither a network fetch nor a retained page snapshot.

There is deliberately no continuation cursor. To read a different section, make
a fresh scoped request using `root_css`. Every response has a new observation ID;
a new read after a page change must not be concatenated as if it continued the
previous state. Screenshot observations with reading compare bounded reads before
and after capture and withhold changed/unavailable reading. Matching reads do not
prove atomicity or absence of transient changes.

Screenshots remain the default native MCP image blocks. `screenshot: false` skips
image capture and enables reading by default. Its response declares
`screenshot_captured: false`, `images: []`, and `actionable: false`; no image geometry
is fabricated. Optional semantic, element-geometry and readable sections are separate bounded reads,
not an atomic document snapshot. Text-only observation invalidates earlier pixel
observations. Use semantic targets **without** `observation_id`, or request a fresh
screenshot before coordinate actions. Passing a text-only observation ID rejects
the action batch before effects, including semantic actions with that ID.

Step preserves ordered action receipts, partial failure/cancellation and input
cleanup in either mode. Optional text extraction failure never replays actions.
Native dialogs can make text inspection unavailable; the action receipt and
dialog recovery information are retained. Text-only observation is not permission
to ignore a challenge or other user-approval boundary.
