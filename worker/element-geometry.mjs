// Copyright 2026 Sedna Labs. SPDX-License-Identifier: Apache-2.0
// Serializable, read-only main-frame geometry. No page text, values or attributes.
export function inspectElementGeometry({ selectors, max_matches = 8 }) {
  const finite = (value) => Number.isFinite(value) ? value : null;
  const rectangle = (element) => {
    const r = element.getBoundingClientRect();
    return Object.fromEntries(["x", "y", "width", "height", "top", "right", "bottom", "left"].map((key) => [key, finite(r[key])]));
  };
  const measure = (element) => {
    const style = getComputedStyle(element);
    const rect = rectangle(element);
    const hidden = element.getClientRects().length === 0 || style.visibility !== "visible" || style.opacity === "0" ||
      (typeof element.checkVisibility === "function" && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
    const offscreen = rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth;
    return {
      visibility: hidden ? "hidden" : offscreen ? "offscreen" : "visible",
      // Viewport CSS pixels, not screenshot pixels. Visible does not imply unobscured.
      rect,
      client: { width: finite(element.clientWidth), height: finite(element.clientHeight) },
      scroll: { x: finite(element.scrollLeft), y: finite(element.scrollTop), width: finite(element.scrollWidth), height: finite(element.scrollHeight) },
      overflow: { x: style.overflowX, y: style.overflowY },
    };
  };
  const results = selectors.map((selector, selector_index) => {
    let matches;
    try { matches = document.querySelectorAll(selector); }
    catch { return { selector_index, status: "invalid_selector", elements: [], truncated: false }; }
    const elements = [];
    for (let index = 0; index < Math.min(matches.length, max_matches); index++) {
      const element = matches[index];
      elements.push({ match_index: index, ...measure(element), parent: element.parentElement ? measure(element.parentElement) : null });
    }
    return { selector_index, status: elements.length ? "matched" : "missing", elements, truncated: matches.length > max_matches };
  });
  return {
    source: "bounded_element_geometry", untrusted: true, results,
    viewport: { width: innerWidth, height: innerHeight }, scroll: { x: scrollX, y: scrollY },
    document: { width: document.documentElement?.scrollWidth ?? 0, height: document.documentElement?.scrollHeight ?? 0 },
    device_pixel_ratio: devicePixelRatio,
    limits: { selectors: 8, max_matches },
    coverage: "Main-frame light DOM only; selectors do not enter shadow roots or iframe documents. Rectangles are viewport CSS pixels. Visibility excludes occlusion and ancestor clipping; compare parent/scroll/viewport geometry. No scrolling, resizing or navigation.",
  };
}
