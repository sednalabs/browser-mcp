import test from "node:test";
import assert from "node:assert/strict";
import { BrowserRuntime } from "../runtime.mjs";
import { loadConfig } from "../config.mjs";
const textOf = (result) => JSON.parse(result.content[0].text);

test("geometry observation measures non-controls, stays read-only and is page-scoped", { timeout: 30000 }, async (t) => {
  const runtime = new BrowserRuntime(await loadConfig(process.env));
  t.after(() => runtime.dispose());
  const initial = textOf(await runtime.call("start", "browser_observe", {}));
  assert.ok(initial.page_id, JSON.stringify(initial));
  const page = runtime.pages.get(initial.page_id).page;
  await page.setViewportSize({ width: 320, height: 640 });
  await page.setContent(`<style>body{margin:0;height:2000px}#container{margin-left:42.5px;width:250px;overflow:hidden}#ad{width:300px;height:250px}</style><div id="container"><div id="ad"></div></div><div id="hidden" hidden></div><div style="opacity:0"><div id="transparent">transparent ancestor</div></div><input id="secret" type="password" value="never-emit-this"><iframe srcdoc="<div id='inside'>inside</div>"></iframe>`);
  await page.locator("#secret").focus();
  const before = await page.evaluate(() => ({ x: scrollX, y: scrollY, focus: document.activeElement.id }));
  const observed = textOf(await runtime.call("geometry", "browser_observe", { page_id: initial.page_id, element_geometry: { selectors: ["#ad", "#hidden", "#missing", "#inside", "#secret", "#transparent"] } }));
  assert.equal(observed.element_geometry.page_id, initial.page_id);
  assert.equal(observed.element_geometry.observation_id, observed.observation_id);
  assert.equal(observed.element_geometry.results[0].elements[0].rect.right, 342.5);
  assert.equal(observed.element_geometry.results[0].elements[0].parent.scroll.width, 300);
  assert.equal(observed.element_geometry.results[1].elements[0].visibility, "hidden");
  assert.equal(observed.element_geometry.results[2].status, "missing");
  assert.equal(observed.element_geometry.results[3].status, "missing");
  assert.equal(observed.element_geometry.results[5].elements[0].visibility, "hidden");
  assert.equal(JSON.stringify(observed.element_geometry).includes("never-emit-this"), false);
  assert.deepEqual(await page.evaluate(() => ({ x: scrollX, y: scrollY, focus: document.activeElement.id })), before);
  // Deterministic mutation after the screenshot and before the second geometry
  // read: prove stale rectangles are withheld without discarding action receipts.
  const context = page.context();
  const originalSession = context.newCDPSession.bind(context);
  let geometryReads = 0;
  context.newCDPSession = async (...args) => {
    const session = await originalSession(...args);
    const send = session.send.bind(session);
    session.send = async (method, params) => {
      if (method === "Runtime.evaluate" && params.expression?.includes("bounded_element_geometry") && ++geometryReads === 2) {
        await page.evaluate(() => { document.querySelector("#ad").style.width = "301px"; });
      }
      return send(method, params);
    };
    return session;
  };
  try {
    const changed = textOf(await runtime.call("changed", "browser_step", { page_id: initial.page_id, actions: [{ type: "wait", ms: 0 }], element_geometry: { selectors: ["#ad"] } }));
    assert.equal(changed.actions[0].status, "completed");
    assert.equal(changed.element_geometry, undefined);
    assert.equal(changed.actionable, false);
    assert.equal(changed.images.length, 1);
    assert.ok(changed.warnings.some(warning => /geometry withheld/.test(warning)));
  } finally { context.newCDPSession = originalSession; }
  const second = textOf(await runtime.call("new", "browser_tabs", { action: "new" }));
  const other = textOf(await runtime.call("other", "browser_observe", { page_id: second.page_id, element_geometry: { selectors: ["#ad"] } }));
  assert.equal(other.element_geometry.results[0].status, "missing");
  const stepped = textOf(await runtime.call("step", "browser_step", { page_id: initial.page_id, actions: [{ type: "wait", ms: 0 }], element_geometry: { selectors: ["#ad"] } }));
  assert.equal(stepped.element_geometry.results[0].status, "matched");
});
