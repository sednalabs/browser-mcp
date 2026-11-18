// Copyright 2026 Sedna Labs. SPDX-License-Identifier: Apache-2.0
// Bounded, fresh light-DOM reading. Kept self-contained for evaluateRead.
export function inspectReadingDOM(options = {}) {
  const bound = (value, fallback, maximum) => Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
  const maxChars = bound(options.max_chars, 8000, 16000);
  const maxBlocks = bound(options.max_blocks, 64, 128);
  const maxNodes = 4000;
  const blocks = [];
  const reasons = new Set();
  let scanned = 0, returnedChars = 0, buffer = "", owner = null, stopped = false;
  const coverage = () => ({
    scope: "main_frame_light_dom", root_found: Boolean(root),
    max_chars: maxChars, max_blocks: maxBlocks, max_nodes: maxNodes,
    scanned_nodes: scanned, returned_chars: returnedChars, returned_blocks: blocks.length,
    truncated: reasons.size > 0, truncation_reasons: [...reasons],
    continuation: false,
  });
  let root;
  if (options.root_css !== undefined && (typeof options.root_css !== "string" || options.root_css.length > 1000)) {
    return { blocks, unavailable: "invalid_selector", coverage: coverage() };
  }
  try { root = options.root_css === undefined ? document.body : document.querySelector(options.root_css); }
  catch { return { blocks, unavailable: "invalid_selector", coverage: coverage() }; }
  if (!root) return { blocks, unavailable: "root_not_found", coverage: coverage() };

  function stop(reason) { reasons.add(reason); stopped = true; }
  function visit() {
    if (scanned >= maxNodes) { stop("max_nodes"); return false; }
    scanned++;
    return true;
  }
  function excluded(element, style) {
    return element.matches("script,style,template,noscript,iframe,object,embed,canvas,svg,input,textarea,select,option,[hidden],[inert],[aria-hidden='true' i]") ||
      element.isContentEditable || style.display === "none" || style.visibility !== "visible" ||
      style.opacity === "0" || style.contentVisibility === "hidden";
  }
  function closedDetails(element) {
    return element.tagName === "DETAILS" && !element.hasAttribute("open");
  }
  function firstSummary(details) {
    // Only the first direct summary is rendered when details is closed. Bound
    // this search too; never query or enumerate an arbitrary descendant list.
    for (let child = details.firstChild; child; child = child.nextSibling) {
      if (!visit()) return null;
      if (child.nodeType === 1 && child.tagName === "SUMMARY") return child;
    }
    return null;
  }
  // A scoped descendant cannot escape an excluded ancestor. Count this work too.
  let branchChild = root;
  for (let ancestor = root.parentElement; ancestor; branchChild = ancestor, ancestor = ancestor.parentElement) {
    if (!visit()) return { blocks, coverage: coverage() };
    if (excluded(ancestor, getComputedStyle(ancestor))) return { blocks, unavailable: "root_not_readable", coverage: coverage() };
    if (closedDetails(ancestor)) {
      const summary = firstSummary(ancestor);
      if (stopped) return { blocks, coverage: coverage() };
      if (branchChild !== summary) return { blocks, unavailable: "root_not_readable", coverage: coverage() };
    }
  }
  function flush() {
    const text = buffer.trim();
    buffer = "";
    if (!text) return;
    if (blocks.length >= maxBlocks) { stop("max_blocks"); return; }
    const available = maxChars - returnedChars;
    if (available <= 0) { stop("max_chars"); return; }
    const block = { type: owner.type, text: text.slice(0, available) };
    if (owner.level) block.level = owner.level;
    returnedChars += block.text.length;
    if (text.length > available) stop("max_chars");
    if (owner.url) {
      if (owner.url.length <= maxChars - returnedChars) {
        block.url = owner.url;
        returnedChars += owner.url.length;
      } else reasons.add("link_url_budget");
    }
    blocks.push(block);
  }
  function append(value, descriptor) {
    if (owner !== descriptor) { flush(); owner = descriptor; }
    if (stopped) return;
    // Bound normalization even for a single adversarial multi-megabyte text node.
    const remaining = Math.max(0, maxChars - returnedChars - buffer.length);
    const raw = value.slice(0, remaining + 1);
    const compact = raw.replace(/\s+/g, " ");
    buffer = (buffer + compact).replace(/ {2,}/g, " ");
    if (value.length > raw.length) stop("text_node_scan_limit");
    if (buffer.trim().length > maxChars - returnedChars) stop("max_chars");
  }
  function linkURL(element) {
    const raw = element.getAttribute("href");
    if (!raw) return undefined;
    if (raw.length > 1000) { reasons.add("link_url_length"); return undefined; }
    try {
      const url = new URL(raw, document.baseURI);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
      if (url.href.length > 1000) { reasons.add("link_url_length"); return undefined; }
      return url.href;
    } catch { return undefined; }
  }
  const ordinary = { type: "text" };
  // Explicit enter/exit frames avoid recursion and unbounded child-node arrays.
  const stack = [{ node: root, descriptor: ordinary, entered: false }];
  while (stack.length && !stopped) {
    const frame = stack[stack.length - 1];
    if (!frame.entered) {
      frame.entered = true;
      const node = frame.node;
      if (!visit()) break;
      if (node.nodeType !== 1 && node.nodeType !== 3) { stack.pop(); continue; }
      if (node.nodeType === 3) { append(node.data, frame.descriptor); stack.pop(); continue; }
      const style = getComputedStyle(node);
      if (excluded(node, style)) {
        if (node === root) return { blocks, unavailable: "root_not_readable", coverage: coverage() };
        stack.pop(); continue;
      }
      const tag = node.tagName.toLowerCase();
      if (tag === "br") { append(" ", frame.descriptor); stack.pop(); continue; }
      const heading = /^h[1-6]$/.test(tag);
      const link = tag === "a" && node.hasAttribute("href");
      frame.boundary = heading || link || !["inline", "inline-block", "inline-flex", "inline-grid", "contents"].includes(style.display);
      if (frame.boundary) {
        flush();
        frame.descriptor = heading ? { type: "heading", level: Number(tag[1]) } : link ? { type: "link", url: linkURL(node) } : frame.descriptor.type === "text" ? { type: "text" } : frame.descriptor;
      }
      frame.onlyChild = closedDetails(node);
      frame.child = frame.onlyChild ? firstSummary(node) : node.firstChild;
    } else if (frame.child) {
      const child = frame.child;
      frame.child = frame.onlyChild ? null : child.nextSibling;
      stack.push({ node: child, descriptor: frame.descriptor, entered: false });
    } else {
      if (frame.boundary) flush();
      stack.pop();
    }
  }
  flush();
  return { blocks, coverage: coverage() };
}
