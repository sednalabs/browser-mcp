import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { chromium } from "playwright";
import { BrowserRuntime } from "../runtime.mjs";
import { loadConfig, parseServiceAuth } from "../config.mjs";
import { imageDimensions } from "../capture.mjs";

const html = "<!doctype html><html><head><title>Worker fixture</title><style>body{margin:20px;min-height:2400px;font:18px sans-serif}button,input,textarea,select{font:inherit;margin:8px;padding:10px}#menu{background:#cff;padding:12px}footer{margin-top:1700px}</style></head><body>" +
  "<h1>Persistent fixture</h1><label for='draft'>Draft</label><textarea id='draft'></textarea>" +
  "<button id='menu-toggle' onclick='document.querySelector(\"#menu\").hidden=!document.querySelector(\"#menu\").hidden'>Toggle menu</button>" +
  "<div id='menu' hidden>Open menu content</div><button id='count' onclick='window.count++;this.textContent=\"Count \"+window.count'>Count</button>" +
  "<button id='confirm' onclick='window.confirmed=confirm(\"Keep this draft?\")'>Confirm</button>" +
  "<label><input id='check' type='checkbox'>Enabled</label><select id='choice'><option value='a'>Alpha</option><option value='b'>Beta</option></select>" +
  "<a href='/next'>Next page</a><footer>Bottom</footer><script>window.count=0;window.confirmed=null;window.held=new Set;window.lastButtons=0;" +
  "addEventListener('keydown',e=>window.held.add(e.key));addEventListener('keyup',e=>window.held.delete(e.key));addEventListener('mouseup',e=>window.lastButtons=e.buttons);" +
  "console.log('fixture initialized');</script></body></html>";

async function fixture(handler) {
  const server = http.createServer(handler || ((request, response) => {
    if (request.url === "/api") { response.writeHead(503, { "content-type": "text/plain" }); response.end("fixture failure"); }
    else { response.writeHead(200, { "content-type": "text/html" }); response.end(html); }
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}
const textOf = (result) => JSON.parse(result.content[0].text);
const imagesOf = (result) => result.content.filter((block) => block.type === "image");
async function makeRuntime(t, overrides = {}) {
  const runtime = new BrowserRuntime({ ...await loadConfig(process.env), actionTimeout: 800, ...overrides });
  t.after(() => runtime.dispose());
  return runtime;
}

test("sandbox startup failure is reported without disabling Chromium sandboxing", async (t) => {
  const runtime = await makeRuntime(t);
  runtime.ensureBrowser = async () => {
    throw new Error("Chromium sandboxing failed / No usable sandbox, zygote_host_impl_linux.cc:130, SIGTRAP");
  };
  const result = await runtime.call("sandbox-preflight", "browser_observe", {});
  const data = textOf(result);
  assert.equal(result.isError, true);
  assert.equal(data.error.code, "CHROMIUM_SANDBOX_UNAVAILABLE");
  assert.match(data.error.message, /sandbox was not disabled/i);
  assert.match(data.error.message, /root-owned per-executable AppArmor/i);
  assert.match(data.error.message, /do not use --no-sandbox for open-web browsing/i);
});

test("real browser preserves state, receipts, cancellation and review geometry", { timeout: 60000 }, async (t) => {
  const server = await fixture();
  t.after(() => server.close());
  const runtime = await makeRuntime(t);
  let id = 0;
  const call = (method, params) => runtime.call(++id, method, params);
  const step = (actions, extra = {}) => call("browser_step", { actions, settle_ms: 0, ...extra });
  const navigate = async () => {
    const result = await step([{ type: "navigate", url: server.origin }]);
    assert.equal(textOf(result).status, "completed", result.content[0].text);
    return runtime.pages.get(textOf(result).page_id).page;
  };
  assert.equal(textOf(await call("browser_session", { action: "status" })).running, false);
  let page = await navigate();

  await t.test("inline observation is current and leaves unsaved state and focus intact", async () => {
    const edited = await step([
      { type: "fill", target: { label: "Draft" }, text: "UNSAVED-private-value" },
      { type: "click", target: { role: "button", name: "Toggle menu" } },
      { type: "focus", target: { css: "#draft" } },
      { type: "check", target: { css: "#check" }, checked: true },
      { type: "select", target: { css: "#choice" }, values: ["b"] },
      { type: "focus", target: { css: "#draft" } },
    ]);
    assert.equal(textOf(edited).status, "completed", edited.content[0].text);
    const before = await page.evaluate(() => ({ text: document.querySelector("#draft").value, menu: document.querySelector("#menu").hidden, focus: document.activeElement.id }));
    const observed = await call("browser_observe", {});
    const data = textOf(observed);
    assert.equal(data.actionable, true);
    assert.equal(imagesOf(observed).length, 1);
    assert.deepEqual(imageDimensions(Buffer.from(imagesOf(observed)[0].data, "base64")), data.geometry.image);
    assert.deepEqual(await page.evaluate(() => ({ text: document.querySelector("#draft").value, menu: document.querySelector("#menu").hidden, focus: document.activeElement.id })), before);
    assert.equal(before.menu, false);
    assert.equal(before.focus, "draft");
    assert.equal(data.page.controls[0].name, "Draft");
    assert.ok(!JSON.stringify(data.page.controls).includes("UNSAVED-private-value"));
  });

  await t.test("late validation and execution failure have different honest receipts", async () => {
    const rejected = await step([
      { type: "click", target: { css: "#count" } },
      { type: "wait", ms: 1001 },
    ]);
    assert.equal(textOf(rejected).status, "rejected");
    assert.equal(await page.evaluate(() => window.count), 0);
    const partial = await step([
      { type: "click", target: { css: "#count" } },
      { type: "click", target: { css: "#missing" } },
      { type: "fill", target: { css: "#draft" }, text: "must not run" },
    ]);
    assert.equal(partial.isError, true);
    assert.deepEqual(textOf(partial).actions.map((action) => action.status), ["completed", "uncertain", "not_started"]);
    assert.equal(imagesOf(partial).length, 1);
    assert.equal(await page.evaluate(() => window.count), 1);
    assert.equal(await page.locator("#draft").inputValue(), "UNSAVED-private-value");
  });

  await t.test("coordinate input is bound to the exact current observation", async () => {
    const observed = textOf(await call("browser_observe", {}));
    const box = await page.locator("#count").boundingBox();
    const clicked = await step([{ type: "click", x: box.x + box.width / 2, y: box.y + box.height / 2 }], { observation_id: observed.observation_id, page_id: observed.page_id });
    assert.equal(textOf(clicked).status, "completed", clicked.content[0].text);
    const stale = await step([{ type: "click", x: box.x + 2, y: box.y + 2 }], { observation_id: observed.observation_id });
    assert.equal(textOf(stale).error.code, "STALE_OBSERVATION");
    assert.equal(await page.evaluate(() => window.count), 2);
  });

  await t.test("cancellation keeps FIFO ownership through cleanup and final capture", async () => {
    const originalObserve = runtime.observe.bind(runtime);
    let releaseCapture;
    const captureGate = new Promise((resolve) => { releaseCapture = resolve; });
    let reachedCapture;
    const captureReached = new Promise((resolve) => { reachedCapture = resolve; });
    let gateNext = true;
    runtime.observe = async (...args) => {
      const result = await originalObserve(...args);
      if (gateNext) { gateNext = false; reachedCapture(); await captureGate; }
      return result;
    };
    const operationId = ++id;
    const cancelled = runtime.call(operationId, "browser_step", { actions: [
      { type: "key_down", key: "Shift" },
      { type: "wait", ms: 1000 },
      { type: "fill", target: { css: "#draft" }, text: "cancelled mutation" },
    ], settle_ms: 0 });
    await page.waitForFunction(() => window.held.has("Shift"));
    const queued = step([{ type: "fill", target: { css: "#draft" }, text: "later operation" }]);
    assert.equal(runtime.cancel(operationId).accepted, true);
    await captureReached;
    assert.equal(await page.locator("#draft").inputValue(), "UNSAVED-private-value");
    assert.equal(await page.evaluate(() => window.held.has("Shift")), false);
    releaseCapture();
    const cancelledResult = textOf(await cancelled);
    assert.equal(cancelledResult.status, "cancelled");
    assert.equal(cancelledResult.actions[2].status, "not_started");
    assert.equal(cancelledResult.cleanup.held_inputs_released, true);
    assert.equal(textOf(await queued).status, "completed");
    assert.equal(await page.locator("#draft").inputValue(), "later operation");
    runtime.observe = originalObserve;
    const receipt = textOf(await call("browser_session", { action: "status" })).last_operation;
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.images_retained, false);
  });

  await t.test("a native confirm dialog can be inspected and resolved on the next call", async () => {
    const started = Date.now();
    const blocked = await step([{ type: "click", target: { css: "#confirm" } }]);
    assert.ok(Date.now() - started < 9000);
    assert.equal(textOf(blocked).dialog.type, "confirm");
    assert.match(textOf(blocked).dialog.message, /Keep this draft/);
    const accepted = await step([{ type: "dialog", action: "accept" }]);
    assert.equal(textOf(accepted).status, "completed", accepted.content[0].text);
    assert.equal(await page.evaluate(() => window.confirmed), true);
    assert.equal(imagesOf(accepted).length, 1);
  });

  await t.test("a keyboard-triggered dialog retains its pending input and fences other mutations", async () => {
    await step([{ type: "focus", target: { css: "#confirm" } }]);
    const opened = textOf(await step([
      { type: "key_down", key: "Enter" },
      { type: "fill", target: { css: "#draft" }, text: "must not continue after dialog" },
    ]));
    assert.equal(opened.status, "blocked");
    assert.equal(opened.actions[0].status, "pending_dialog");
    assert.equal(opened.actions[1].status, "not_started");
    assert.equal(opened.cleanup.pending_dialog_resolution, true);
    await call("browser_tabs", { action: "list" });
    const inspectStarted = Date.now();
    const inspected = textOf(await call("browser_inspect", {}));
    assert.equal(inspected.status, "completed");
    assert.ok(Date.now() - inspectStarted < 1500);
    const status = textOf(await call("browser_session", { action: "status" }));
    assert.equal(status.last_operation.operation_id, opened.operation_id);
    assert.equal(status.pending_dialogs[0].pending_operation_id, opened.operation_id);
    const rejected = textOf(await call("browser_tabs", { action: "new" }));
    assert.equal(rejected.error.code, "DIALOG_OPEN");
    const resolved = textOf(await step([{ type: "dialog", action: "dismiss" }]));
    assert.equal(resolved.status, "completed");
    assert.equal(resolved.actions[0].recovery.operation_id, opened.operation_id);
    assert.equal(resolved.actions[0].recovery.original_action_settled, true);
    assert.equal(resolved.actions[0].recovery.held_inputs_released, true);
    assert.equal(await page.evaluate(() => window.held.has("Enter")), false);
    assert.equal(await page.locator("#draft").inputValue(), "later operation");
  });

  await t.test("review images carry individual dimensions and restore viewport and scroll", async () => {
    await page.evaluate(() => window.scrollTo(0, 450));
    const observed = textOf(await call("browser_observe", {}));
    const reviewed = await call("browser_review", { captures: [
      { label: "mobile top", width: 390, height: 844, scroll: "top", settle_ms: 30 },
      { label: "tablet", width: 768, height: 1024, settle_ms: 30 },
      { label: "desktop bottom", width: 1280, height: 800, scroll: "bottom", settle_ms: 30 },
    ] });
    const data = textOf(reviewed);
    assert.equal(data.status, "completed", reviewed.content[0].text);
    assert.equal(data.restoration.viewport_restored, true);
    assert.equal(data.restoration.scroll_restored, true);
    assert.equal(data.captures.length, 3);
    for (const capture of data.captures) {
      const image = reviewed.content[capture.content_index];
      assert.equal(image.type, "image");
      assert.deepEqual(imageDimensions(Buffer.from(image.data, "base64")), capture.geometry.image);
      assert.equal(capture.geometry.viewport.width, capture.requested.width);
    }
    assert.equal(await page.evaluate(() => scrollY), 450);
    const stale = textOf(await step([{ type: "mouse_move", x: 10, y: 10 }], { observation_id: observed.observation_id }));
    assert.equal(stale.error.code, "STALE_OBSERVATION");
  });

  await t.test("network and console history includes real completion metadata", async () => {
    await page.evaluate(async () => { console.error("synthetic diagnostic"); await fetch("/api"); });
    const result = textOf(await call("browser_inspect", { limit: 200 }));
    assert.ok(result.events.some((event) => event.kind === "console" && event.text.includes("synthetic diagnostic")));
    assert.ok(result.events.some((event) => event.kind === "network" && event.url.endsWith("/api") && event.status === 503));
    assert.ok(result.events.every((event) => !Object.hasOwn(event, "headers") && !Object.hasOwn(event, "body")));
  });

  await t.test("unverified restoration is reported as failure", async () => {
    await page.evaluate(() => {
      window.scrollTo(0, 500);
      addEventListener("resize", () => {
        if (innerWidth < 400) { document.body.style.minHeight = "0"; document.querySelector("footer").remove(); }
      }, { once: true });
    });
    const result = await call("browser_review", { captures: [{ label: "shrinking app", width: 390, height: 844, settle_ms: 40 }] });
    assert.equal(textOf(result).restoration.scroll_restored, false);
    assert.equal(textOf(result).status, "failed");
    assert.equal(result.isError, true);
  });

  await t.test("unexpected browser loss never silently creates a replacement session", async () => {
    const old = runtime.status().browser_instance_id;
    await runtime.context.close();
    const status = textOf(await call("browser_session", { action: "status" }));
    assert.equal(status.lifecycle, "lost");
    assert.equal(status.reset_required, true);
    const rejected = textOf(await call("browser_observe", {}));
    assert.equal(rejected.error.code, "BROWSER_DISCONNECTED");
    assert.equal(runtime.status().running, false);
    const reset = textOf(await call("browser_session", { action: "reset" }));
    assert.equal(reset.running, true);
    assert.notEqual(reset.browser_instance_id, old);
    page = await navigate();
    assert.equal(await page.locator("#draft").inputValue(), "");
  });
});

test("an external CDP client's automatic dialog dismissal settles owned input and clears the fence", { timeout: 20000 }, async (t) => {
  const server = await fixture();
  t.after(() => server.close());
  const runtime = await makeRuntime(t, { cdp: true });
  let id = 0;
  const call = (method, params) => runtime.call(++id, method, params);
  const navigated = textOf(await call("browser_step", { actions: [{ type: "navigate", url: server.origin }], settle_ms: 0 }));
  const companion = await chromium.connectOverCDP(runtime.status().cdp_endpoint);
  t.after(() => companion.close().catch(() => {}));
  const page = companion.contexts()[0].pages().find((candidate) => candidate.url() === server.origin + "/");
  assert.ok(page);
  // Deliberately register no companion dialog listener: Playwright will dismiss
  // native dialogs automatically, which is a real multi-client interference case.
  await call("browser_step", { actions: [{ type: "focus", target: { css: "#confirm" } }], settle_ms: 0 });
  const interrupted = textOf(await call("browser_step", { actions: [
    { type: "key_down", key: "Enter" },
    { type: "fill", target: { css: "#draft" }, text: "must not run" },
  ], settle_ms: 0 }));
  assert.ok(["blocked", "failed"].includes(interrupted.status));
  await page.waitForFunction(() => window.confirmed === false);
  const status = textOf(await call("browser_session", { action: "status" }));
  assert.deepEqual(status.pending_dialogs, []);
  assert.equal(status.last_operation.dialog_recovery.original_action_settled, true);
  assert.equal(status.last_operation.dialog_recovery.held_inputs_released, true);
  assert.equal(status.last_operation.dialog_recovery.dialog_resolution.source, "external");
  assert.equal(await page.evaluate(() => window.held.has("Enter")), false);
  assert.equal(await page.locator("#draft").inputValue(), "");
  const observed = await call("browser_observe", { page_id: navigated.page_id });
  assert.equal(textOf(observed).status, "completed");
  assert.equal(imagesOf(observed).length, 1);
  const alreadyClosed = textOf(await call("browser_step", { actions: [{ type: "dialog", action: "accept" }], settle_ms: 0 }));
  assert.equal(alreadyClosed.error.code, "NO_DIALOG");
  const normal = textOf(await call("browser_step", { actions: [{ type: "fill", target: { css: "#draft" }, text: "after external dismissal" }], settle_ms: 0 }));
  assert.equal(normal.status, "completed");
  assert.equal(await page.locator("#draft").inputValue(), "after external dismissal");
});

test("configured service headers authenticate exact origins and do not leak across redirects", { timeout: 30000 }, async (t) => {
  const requests = [];
  const other = await fixture((request, response) => {
    requests.push({ destination: "other", url: request.url, header: request.headers["x-service-key"] });
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>Other origin</title><p>Redirect destination</p>");
  });
  const allowed = await fixture((request, response) => {
    requests.push({ destination: "allowed", url: request.url, header: request.headers["x-service-key"] });
    if (request.url === "/redirect") {
      response.writeHead(302, { location: other.origin + "/destination" });
      response.end();
    } else {
      response.writeHead(request.headers["x-service-key"] === "synthetic-service-secret" ? 200 : 401, { "content-type": "text/html" });
      response.end("<title>Authenticated fixture</title><script>console.log('synthetic-service-secret')</script><p>Service protected page</p>");
    }
  });
  t.after(() => Promise.all([allowed.close(), other.close()]));
  const runtime = await makeRuntime(t, {
    actionTimeout: 5000,
    serviceAuth: parseServiceAuth({ allowed_origins: [allowed.origin], headers: { "x-service-key": "synthetic-service-secret" } }),
  });
  const first = await runtime.call(1, "browser_step", { actions: [{ type: "navigate", url: allowed.origin }], settle_ms: 0 });
  assert.equal(textOf(first).status, "completed", first.content[0].text);
  assert.ok(requests.some((request) => request.destination === "allowed" && request.header === "synthetic-service-secret"));
  const history = await runtime.call(2, "browser_inspect", {});
  assert.ok(!JSON.stringify(history).includes("synthetic-service-secret"));
  assert.ok(textOf(history).events.some((event) => event.text?.includes("[redacted]")));
  const redirect = await runtime.call(3, "browser_step", { actions: [{ type: "navigate", url: allowed.origin + "/redirect" }], settle_ms: 0 });
  assert.equal(textOf(redirect).status, "completed", redirect.content[0].text);
  assert.equal(textOf(redirect).geometry.url, other.origin + "/destination");
  assert.ok(requests.some((request) => request.destination === "other"));
  assert.ok(requests.filter((request) => request.destination === "other").every((request) => request.header === undefined));
});
