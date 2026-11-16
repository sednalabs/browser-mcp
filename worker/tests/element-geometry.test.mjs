import test from "node:test";
import assert from "node:assert/strict";
import { inspectElementGeometry } from "../element-geometry.mjs";
import { tools } from "../schemas.mjs";
import Ajv from "ajv";

function fakeElement({ x = 42.5, y = 0, width = 300, height = 250, hidden = false, parent = null } = {}) {
  return {
    getBoundingClientRect: () => ({ x, y, width, height, top: y, right: x + width, bottom: y + height, left: x }),
    getClientRects: () => hidden ? [] : [{}], checkVisibility: () => !hidden,
    clientWidth: width, clientHeight: height, scrollWidth: width + 40, scrollHeight: height,
    scrollLeft: 0, scrollTop: 0, parentElement: parent,
  };
}
function withDOM(fn) {
  const keys = ["document", "getComputedStyle", "innerWidth", "innerHeight", "scrollX", "scrollY", "devicePixelRatio"];
  const prior = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const parent = fakeElement({ x: 20, width: 280 });
  const entries = { "#ad": [fakeElement({ parent })], "#hidden": [fakeElement({ hidden: true })], "#offscreen": [fakeElement({ y: 900 })], ".many": Array.from({ length: 30 }, () => fakeElement()) };
  Object.assign(globalThis, {
    innerWidth: 320, innerHeight: 640, scrollX: 0, scrollY: 0, devicePixelRatio: 2,
    getComputedStyle: () => ({ visibility: "visible", opacity: "1", overflowX: "hidden", overflowY: "auto" }),
    document: { documentElement: { scrollWidth: 360, scrollHeight: 1500 }, querySelectorAll: (selector) => { if (selector === "[") throw Error("invalid"); return entries[selector] ?? []; } },
  });
  try { fn(); } finally { keys.forEach((key, index) => { if (prior[index]) Object.defineProperty(globalThis, key, prior[index]); else delete globalThis[key]; }); }
}

test("bounded geometry exposes clipping measurements without text or form values", () => withDOM(() => {
  const data = inspectElementGeometry({ selectors: ["#ad", "#hidden", "#offscreen", "#missing", "[", ".many"], max_matches: 2 });
  assert.equal(data.results[0].elements[0].rect.right, 342.5);
  assert.equal(data.results[0].elements[0].parent.client.width, 280);
  assert.equal(data.results[0].elements[0].overflow.x, "hidden");
  assert.equal(data.results[1].elements[0].visibility, "hidden");
  assert.equal(data.results[2].elements[0].visibility, "offscreen");
  assert.equal(data.results[3].status, "missing");
  assert.equal(data.results[4].status, "invalid_selector");
  assert.equal(data.results[5].elements.length, 2);
  assert.equal(data.results[5].truncated, true);
  assert.equal(JSON.stringify(data).includes("#ad"), false);
}));

test("geometry input is bounded and rejects arbitrary evaluation and frame access", () => {
  const ajv = new Ajv({ strict: false });
  for (const name of ["browser_observe", "browser_step"]) {
    const validate = ajv.compile(tools.find((tool) => tool.name === name).inputSchema);
    const base = name === "browser_step" ? { actions: [{ type: "wait", ms: 0 }] } : {};
    const check = (element_geometry) => validate({ ...base, element_geometry });
    assert.equal(check({ selectors: ["#ad"], max_matches: 16 }), true);
    for (const request of [{ selectors: [] }, { selectors: Array(9).fill("div") }, { selectors: ["x".repeat(1001)] }, { selectors: ["div"], max_matches: 17 }, { selectors: ["div"], max_matches: 0 }, { selectors: ["div"], frame: "iframe" }, { selectors: ["div"], script: "document.cookie" }]) assert.equal(check(request), false);
  }
});
