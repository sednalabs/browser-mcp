// Copyright 2026 Sedna Labs. SPDX-License-Identifier: Apache-2.0
// Adapted and modified from Sedna/OpenAI Codex; see NOTICE and docs/provenance.md.
// The compact control map derives from Sedna's browser_playwright_review.mjs
// (codex-rs/browser-computer-use/src). This extraction adds ranking, hidden/inert
// filtering and explicit locator objects while retaining label-first field text.

export function inspectDOM({ limit = 24, semantic } = {}) {
  const viewport = { width: innerWidth, height: innerHeight };
  const compact = (value, max = 160) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
  function roleOf(element) {
    if (element.getAttribute("role")) return compact(element.getAttribute("role"), 60).split(/\s+/)[0];
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea" || element.isContentEditable) return "textbox";
    if (tag === "input") {
      if (["checkbox", "radio"].includes(element.type)) return element.type;
      return ["button", "submit", "reset"].includes(element.type) ? "button" : "textbox";
    }
    return tag;
  }
  function labelOf(element, role) {
    const labelledBy = (element.getAttribute("aria-labelledby") || "").split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || "").join(" ");
    const labels = element.labels ? Array.from(element.labels).map((label) => label.textContent).join(" ") : "";
    const explicit = element.getAttribute("aria-label") || compact(labelledBy) || compact(labels);
    if (explicit) return compact(explicit);
    if (role === "textbox" || element.tagName === "SELECT" || element.isContentEditable) {
      return compact(element.getAttribute("placeholder") || element.getAttribute("title") || element.getAttribute("name") || element.id);
    }
    return compact(element.textContent || element.innerText || element.getAttribute("alt") || element.getAttribute("title"));
  }
  function summarize(element) {
    if (element.closest("[hidden],[inert],[aria-hidden='true']")) return null;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility !== "visible" || style.opacity === "0") return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const role = roleOf(element);
    const name = labelOf(element, role);
    const offscreen = rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth;
    const centerX = Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2));
    const centerY = Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2));
    const top = document.elementFromPoint(centerX, centerY);
    const covered = !offscreen && Boolean(top && top !== element && !element.contains(top));
    const disabled = Boolean(element.disabled || element.closest("[aria-disabled='true']"));
    const focused = document.activeElement === element;
    const inDialog = Boolean(element.closest("dialog[open],[role='dialog'],[role='alertdialog']"));
    const locators = [];
    if (element.id && element.id.length <= 240) locators.push({ css: "#" + CSS.escape(element.id) });
    if (element.getAttribute("data-testid") && element.getAttribute("data-testid").length <= 300) locators.push({ test_id: element.getAttribute("data-testid") });
    if (name && !["div", "span", "input"].includes(role)) locators.push({ role, name, exact: true });
    if (element.getAttribute("aria-label") && element.getAttribute("aria-label").length <= 300) locators.push({ label: element.getAttribute("aria-label"), exact: true });
    return {
      role, name, focused, disabled, covered, offscreen, in_dialog: inDialog,
      box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      locators: locators.slice(0, 3),
      rank: (focused ? 100 : 0) + (inDialog ? 30 : 0) + (!offscreen ? 20 : 0) + (!disabled && !covered ? 10 : 0),
    };
  }
  const candidates = Array.from(document.querySelectorAll(
    "button,a[href],input,textarea,select,[role],[tabindex],[contenteditable='true'],[data-testid]"
  )).slice(0, 4000).map(summarize).filter(Boolean);
  candidates.sort((a, b) => b.rank - a.rank);
  const controls = candidates.slice(0, limit).map(({ rank, ...value }) => value);
  const attention = Array.from(document.querySelectorAll("[role='alert'],[role='status'],[aria-live],dialog[open],[role='dialog']"))
    .slice(0, 100).filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !el.closest("[hidden],[inert],[aria-hidden='true']");
    }).slice(0, 8).map((el) => ({ role: roleOf(el), text: compact(el.innerText, 240) }));
  let accessibility;
  if (semantic) {
    const roots = semantic.root_css ? document.querySelectorAll(semantic.root_css) : [document.body];
    if (roots.length !== 1 || !roots[0]) throw new Error("Semantic root must match exactly one element.");
    const nodes = [];
    let visited = 0, truncated = false;
    const maxNodes = semantic.max_nodes ?? 64;
    const maxDepth = semantic.max_depth ?? 8;
    const structural = { BODY: "document", MAIN: "main", NAV: "navigation", HEADER: "banner", FOOTER: "contentinfo", FORM: "form", FIELDSET: "group", UL: "list", OL: "list", LI: "listitem", TABLE: "table", TR: "row", TH: "columnheader", TD: "cell", SECTION: "region", ARTICLE: "article", IMG: "img" };
    function walk(element, parent, depth) {
      if (++visited > 4000 || nodes.length >= maxNodes) { truncated = true; return; }
      if (element.closest("[hidden],[inert],[aria-hidden='true']")) return;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility !== "visible") return;
      const control = summarize(element);
      const heading = /^H[1-6]$/.test(element.tagName);
      const interactive = element.matches("button,a[href],input,textarea,select,[role],[tabindex],[contenteditable='true']");
      const role = (element.hasAttribute("role") ? roleOf(element) : null) || (heading ? "heading" : structural[element.tagName] || (interactive ? roleOf(element) : null));
      let nextParent = parent, nextDepth = depth;
      if (role) {
        if (depth > maxDepth) { truncated = true; return; }
        const ref = "s" + nodes.length;
        const name = role === "document" ? compact(document.title) : (interactive || heading || role === "img" ? labelOf(element, role) : compact(element.getAttribute("aria-label") || element.getAttribute("title")));
        const description = compact((element.getAttribute("aria-describedby") || "").split(/\s+/).map(id => document.getElementById(id)?.textContent || "").join(" "));
        const state = { focused: document.activeElement === element, disabled: Boolean(element.disabled || element.closest("[aria-disabled='true']")) };
        for (const key of ["checked", "expanded", "selected"]) {
          const aria = element.getAttribute("aria-" + key);
          if (["true", "false", ...(key === "checked" ? ["mixed"] : [])].includes(aria)) state[key] = aria;
          else if (key in element && typeof element[key] === "boolean") state[key] = element[key];
        }
        const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
        const sensitive = element.matches("input[type='password']") || autocomplete.some(token => token.startsWith("cc-") || token.includes("password") || token === "one-time-code");
        const value = sensitive ? undefined : (typeof element.value === "string" ? compact(element.value, 160) : undefined);
        nodes.push({ ref, parent, role, name, description, ...state, ...(role === "heading" && heading ? { level: Number(element.tagName[1]) } : {}), ...(value !== undefined ? { value } : {}), ...(interactive && control ? { locators: control.locators, box: control.box, offscreen: control.offscreen } : {}) });
        nextParent = ref; nextDepth = depth + 1;
      }
      // Light DOM only: frame and shadow content are deliberately not implied.
      for (const child of element.children) {
        if (visited >= 4000 || nodes.length >= maxNodes) { truncated = true; break; }
        walk(child, nextParent, nextDepth);
      }
    }
    walk(roots[0], null, 0);
    for (const control of controls) {
      const matches = nodes.filter(node => node.role === control.role && node.name === control.name && JSON.stringify(node.box) === JSON.stringify(control.box));
      if (matches.length === 1) control.semantic_ref = matches[0].ref;
    }
    accessibility = { source: "bounded_dom_semantics", untrusted: true, nodes, truncated, visited_elements: visited, limits: { max_nodes: maxNodes, max_depth: maxDepth, scanned_elements: 4000 }, coverage: "Main-frame light DOM only; not the browser accessibility tree. CSS generated content, shadow roots and iframe documents are excluded. Names approximate HTML/ARIA semantics." };
  }
  return {
    ...(accessibility ? { accessibility } : {}),
    url: location.href,
    title: compact(document.title, 240),
    viewport,
    scroll: { x: scrollX, y: scrollY },
    document: { width: document.documentElement?.scrollWidth || 0, height: document.documentElement?.scrollHeight || 0 },
    device_pixel_ratio: devicePixelRatio,
    controls,
    controls_available: candidates.length,
    controls_truncated: candidates.length > limit,
    attention,
    frames: Array.from(document.querySelectorAll("iframe")).slice(0, 16).map((el) => ({
      name: compact(el.name, 80), title: compact(el.title, 120), src: compact(el.getAttribute("src"), 500),
    })),
  };
}

export function geometryDOM() {
  return {
    url: location.href, viewport: { width: innerWidth, height: innerHeight },
    scroll: { x: scrollX, y: scrollY }, device_pixel_ratio: devicePixelRatio,
    document: { width: document.documentElement?.scrollWidth || 0, height: document.documentElement?.scrollHeight || 0 },
  };
}

export async function evaluateRead(page, fn, arg = {}) {
  // Runtime.evaluate's V8 execution timeout bounds the fixed synchronous reader;
  // arbitrary caller-provided JavaScript is not accepted.
  const session = await page.context().newCDPSession(page);
  try {
    const response = await sendBounded(session, "Runtime.evaluate", {
      expression: "(" + fn.toString() + ")(" + JSON.stringify(arg) + ")",
      returnByValue: true,
      timeout: 1500,
      awaitPromise: false,
    }, 1800);
    if (response.exceptionDetails) throw new Error("Page inspection could not complete.");
    return response.result.value;
  } finally { await session.detach().catch(() => {}); }
}

export async function sendBounded(session, method, params, timeout = 4000) {
  // Detaching this dedicated read session rejects the pending command. The
  // caller awaits that settlement; it never leaves a timed-out command running
  // while a later operation uses the same page.
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void session.detach().catch(() => {});
  }, timeout);
  try {
    const result = await session.send(method, params);
    if (expired) throw new Error(method + " exceeded its read deadline.");
    return result;
  } catch (error) {
    if (expired) throw new Error(method + " exceeded its read deadline.");
    throw error;
  } finally { clearTimeout(timer); }
}

export function sameGeometry(left, right) {
  return left && right && left.url === right.url &&
    left.viewport.width === right.viewport.width && left.viewport.height === right.viewport.height &&
    Math.abs(left.scroll.x - right.scroll.x) < 1 && Math.abs(left.scroll.y - right.scroll.y) < 1 &&
    left.device_pixel_ratio === right.device_pixel_ratio;
}
