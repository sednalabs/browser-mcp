import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { inspectReadingDOM } from "../reading.mjs";

function element(tag, children = [], attrs = {}, style = {}) {
  const node = {
    nodeType: 1, tagName: tag.toUpperCase(), attrs,
    style: { display: ["span", "a", "em", "strong"].includes(tag) ? "inline" : "block", visibility: "visible", opacity: "1", ...style },
    isContentEditable: attrs.contenteditable === "true",
    getAttribute(key) { return attrs[key] ?? null; },
    hasAttribute(key) { return key in attrs; },
    matches() {
      return ["script", "style", "template", "noscript", "iframe", "object", "embed", "canvas", "svg", "input", "textarea", "select", "option"].includes(tag) ||
        "hidden" in attrs || "inert" in attrs || attrs["aria-hidden"]?.toLowerCase() === "true";
    },
  };
  const nodes = children.map(child => typeof child === "string" ? { nodeType: 3, data: child } : child);
  nodes.forEach((child, i) => { child.parentElement = node; child.nextSibling = nodes[i + 1] || null; });
  node.firstChild = nodes[0] || null;
  return node;
}
function inspect(root, options = {}, scoped = root) {
  const context = vm.createContext({
    URL,
    options,
    document: { body: root, baseURI: "https://example.test/article", querySelector(css) { if (css === "[") throw Error("invalid selector"); return css === "#missing" ? null : scoped; } },
    getComputedStyle(node) { return node.style; },
  });
  // Serialization verifies the page function has no module-scope dependencies.
  return JSON.parse(JSON.stringify(vm.runInContext(`(${inspectReadingDOM.toString()})(options)`, context)));
}

test("reading preserves casing and inline words without repeating nested prose", () => {
  const result = inspect(element("main", [element("h2", ["Mixed CASE"]), element("p", ["Hello ", element("em", ["world"]), "."]), element("div", [element("p", ["Once"])]), element("a", ["Read more"], { href: "/next" })]));
  assert.deepEqual(result.blocks, [
    { type: "heading", text: "Mixed CASE", level: 2 }, { type: "text", text: "Hello world." },
    { type: "text", text: "Once" }, { type: "link", text: "Read more", url: "https://example.test/next" },
  ]);
  assert.equal(result.coverage.truncated, false);
  assert.equal(result.coverage.continuation, false);
});

test("reading excludes hidden content, editable values and embedded documents", () => {
  const root = element("main", ["Public", element("span", ["secret"], { hidden: "" }), element("span", ["secret"], {}, { display: "none" }), element("textarea", ["secret"]), element("div", ["secret"], { contenteditable: "true" }), element("iframe", ["secret"]), element("input", [], { value: "secret" }), element("span", ["secret"], { "aria-hidden": "TRUE" }), element("script", ["secret"])]);
  assert.deepEqual(inspect(root).blocks, [{ type: "text", text: "Public" }]);
  const child = element("p", ["secret"]);
  const hidden = element("div", [child], {}, { opacity: "0" });
  assert.equal(inspect(hidden, { root_css: "#child" }, child).unavailable, "root_not_readable");
});

test("reading has explicit missing/invalid roots and no retained continuation", () => {
  const root = element("main", ["Readable"]);
  assert.equal(inspect(root, { root_css: "#missing" }).unavailable, "root_not_found");
  assert.equal(inspect(root, { root_css: "[" }).unavailable, "invalid_selector");
  assert.equal(inspect(root, { root_css: "x".repeat(1001) }).unavailable, "invalid_selector");
  assert.equal(inspect(root, { root_css: "#main" }).coverage.root_found, true);
});

test("reading bounds text, blocks and scanned nodes with explicit truncation", () => {
  let result = inspect(element("main", ["x".repeat(1000000)]), { max_chars: 20 });
  assert.equal(result.blocks[0].text.length, 20);
  assert.equal(result.coverage.returned_chars, 20);
  assert.equal(result.coverage.truncated, true);
  result = inspect(element("main", [element("p", ["One"]), element("p", ["Two"])]), { max_blocks: 1 });
  assert.equal(result.blocks.length, 1);
  assert.ok(result.coverage.truncation_reasons.includes("max_blocks"));
  result = inspect(element("main", Array.from({ length: 4500 }, () => element("span"))));
  assert.equal(result.coverage.scanned_nodes, 4000);
  assert.ok(result.coverage.truncation_reasons.includes("max_nodes"));
});

test("reading omits unsafe and overlong link URLs and counts URL characters", () => {
  const root = element("main", [element("a", ["A"], { href: "javascript:alert(1)" }), element("a", ["B"], { href: "https://user:password@example.test" }), element("a", ["C"], { href: "https://example.test/" + "x".repeat(1000) }), element("a", ["D"], { href: "/next" })]);
  const result = inspect(root);
  assert.equal(result.blocks.slice(0, 3).some(block => block.url), false);
  assert.equal(result.blocks[3].url, "https://example.test/next");
  assert.equal(result.coverage.returned_chars, result.blocks.reduce((n, block) => n + block.text.length + (block.url?.length || 0), 0));
});

test("closed details exposes only its first direct summary, including scoped roots", () => {
  const summaryText = element("span", ["Visible summary"]);
  const summary = element("summary", [summaryText]);
  const hiddenText = element("span", ["COLLAPSED SECRET"]);
  const hiddenParagraph = element("p", [hiddenText]);
  const secondSummary = element("summary", ["SECOND SUMMARY SECRET"]);
  const details = element("details", ["COLLAPSED TEXT SECRET", summary, hiddenParagraph, secondSummary]);
  const root = element("main", [details]);
  assert.deepEqual(inspect(root).blocks, [{ type: "text", text: "Visible summary" }]);
  assert.equal(inspect(root, { root_css: "#hidden" }, hiddenText).unavailable, "root_not_readable");
  assert.equal(inspect(root, { root_css: "#second" }, secondSummary).unavailable, "root_not_readable");
  assert.deepEqual(inspect(root, { root_css: "#summary" }, summaryText).blocks, [{ type: "text", text: "Visible summary" }]);
  assert.deepEqual(inspect(root, { root_css: "#details" }, details).blocks, [{ type: "text", text: "Visible summary" }]);
  details.attrs.open = "";
  assert.match(JSON.stringify(inspect(root).blocks), /COLLAPSED SECRET/);
});

test("closed details summary search respects the node-work budget", () => {
  const details = element("details", [...Array.from({ length: 4100 }, () => element("span")), element("summary", ["Unreached"])]);
  const result = inspect(element("main", [details]));
  assert.deepEqual(result.blocks, []);
  assert.equal(result.coverage.scanned_nodes, 4000);
  assert.ok(result.coverage.truncation_reasons.includes("max_nodes"));
});
