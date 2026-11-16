import test from "node:test";
import assert from "node:assert/strict";
import { captureViewport } from "../capture.mjs";

function fixture(failures) {
  let epoch = 0, reads = 0, captures = 0, detached = 0, closed = false, dialog = false;
  const geometry = () => ({ url: "https://example.test/", viewport: { width: 320, height: 640 }, scroll: { x: 0, y: 0 }, device_pixel_ratio: 1 });
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(320, 16); png.writeUInt32BE(640, 20);
  const state = {
    navigate() { epoch++; }, close() { closed = true; }, dialog() { dialog = true; },
    counts: () => ({ reads, captures, detached }),
  };
  const page = {
    isClosed: () => closed,
    context: () => ({ newCDPSession: async () => ({
      async send() {
        const number = ++reads;
        if (failures[number]) { failures[number](state); throw new Error("read interrupted"); }
        return { result: { value: geometry() } };
      },
      async detach() { detached++; },
    }) }),
    async screenshot() { captures++; return png; },
  };
  return { state, run: () => captureViewport(page, { navigationEpoch: () => epoch, hasDialog: () => dialog }) };
}

test("capture recovers one pre-image read interrupted by navigation without replaying capture", async () => {
  const f = fixture({ 1: state => state.navigate() });
  const result = await f.run();
  assert.deepEqual(f.state.counts(), { reads: 3, captures: 1, detached: 3 });
  assert.equal(result.geometry.stable_geometry, true);
  assert.ok(result.warnings.some(w => /retried once/.test(w)));
  assert.equal(result.image.type, "image");
});

test("post-image same-URL navigation recovery keeps image but invalidates coordinate geometry", async () => {
  const f = fixture({ 2: state => state.navigate() });
  const result = await f.run();
  assert.equal(result.geometry.stable_geometry, false);
  assert.deepEqual(f.state.counts(), { reads: 3, captures: 1, detached: 3 });
});

test("capture never retries unchanged epoch, closed pages, or native dialogs", async () => {
  for (const fail of [() => {}, state => { state.navigate(); state.close(); }, state => { state.navigate(); state.dialog(); }]) {
    const f = fixture({ 1: fail });
    await assert.rejects(f.run(), /read interrupted/);
    assert.deepEqual(f.state.counts(), { reads: 1, captures: 0, detached: 1 });
  }
});

test("capture recovery shares one retry budget across both geometry reads", async () => {
  const f = fixture({ 1: state => state.navigate(), 3: state => state.navigate() });
  await assert.rejects(f.run(), /read interrupted/);
  assert.deepEqual(f.state.counts(), { reads: 3, captures: 1, detached: 3 });
});

test("a failed recovery read terminates without another retry", async () => {
  const f = fixture({ 1: state => state.navigate(), 2: state => state.navigate() });
  await assert.rejects(f.run(), /read interrupted/);
  assert.deepEqual(f.state.counts(), { reads: 2, captures: 0, detached: 2 });
});

test("real navigation-interrupted capture preserves completed click receipt and fresh image without replay", { timeout: 30000 }, async t => {
  const { BrowserRuntime } = await import("../runtime.mjs");
  const { loadConfig } = await import("../config.mjs");
  const runtime = new BrowserRuntime(await loadConfig(process.env));
  t.after(() => runtime.dispose());
  const decode = result => JSON.parse(result.content[0].text);
  const initial = decode(await runtime.call("initial", "browser_observe", {}));
  assert.ok(initial.page_id, JSON.stringify(initial));
  const record = runtime.pages.get(initial.page_id);
  const page = record.page;
  await page.setContent('<button onclick="window.clicked=(window.clicked||0)+1">Continue</button>');
  const context = page.context();
  const originalSession = context.newCDPSession.bind(context);
  const originalScreenshot = page.screenshot.bind(page);
  let injected = false, clickCount = 0, screenshots = 0;
  page.screenshot = async (...args) => { screenshots++; return originalScreenshot(...args); };
  context.newCDPSession = async (...args) => {
    const session = await originalSession(...args);
    const send = session.send.bind(session);
    session.send = async (method, params) => {
      if (!injected && method === "Runtime.evaluate" && params.expression?.includes("function geometryDOM(")) {
        injected = true;
        clickCount = await page.evaluate(() => window.clicked);
        await page.goto("data:text/html,<title>After navigation</title><h1>Destination</h1>");
        throw new Error("Execution context was destroyed during navigation");
      }
      return send(method, params);
    };
    return session;
  };
  try {
    const result = await runtime.call("click", "browser_step", {
      page_id: initial.page_id, actions: [{ type: "click", target: { role: "button", name: "Continue", exact: true } }],
    });
    const data = decode(result);
    assert.equal(data.actions[0].status, "completed");
    assert.equal(clickCount, 1);
    assert.equal(injected, true);
    assert.equal(screenshots, 1);
    assert.equal(data.observation_unavailable, undefined);
    assert.equal(data.page.title, "After navigation");
    assert.equal(data.actionable, false, "navigation during overall observation cannot authorize coordinates");
    assert.ok(data.warnings.some(w => /retried once/.test(w)));
    assert.ok(result.content.some(block => block.type === "image"));
  } finally { context.newCDPSession = originalSession; page.screenshot = originalScreenshot; }
});
