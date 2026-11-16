import test from "node:test";
import assert from "node:assert/strict";
import { runNavigation } from "../actions.mjs";
import { Operation } from "../operation.mjs";

function mockPage(send) {
  const events = [];
  const session = {
    async send(method) { events.push(method); return send?.(method); },
    async detach() { events.push("detach"); },
  };
  return { page: { context: () => ({ newCDPSession: async () => session }) }, events };
}
function operation(t) {
  const op = new Operation("navigation-test", 10000); op.start(); t.after(() => op.finish()); return op;
}

test("navigation cancellation stops loading and awaits the original action before release", async t => {
  const op = operation(t);
  let rejectNavigation;
  const pending = new Promise((_, reject) => { rejectNavigation = reject; });
  const { page, events } = mockPage(() => {
    setTimeout(() => { events.push("navigation-settled"); rejectNavigation(new Error("net::ERR_ABORTED")); }, 20);
  });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const result = runNavigation(page, op, () => { started(); return pending; });
  await ready;
  op.cancel();
  await assert.rejects(result, /ERR_ABORTED/);
  assert.deepEqual(events, ["Page.stopLoading", "navigation-settled", "detach"]);
});

test("navigation failure stops residual loading without retrying the navigation", async t => {
  const op = operation(t);
  const { page, events } = mockPage();
  let attempts = 0;
  await assert.rejects(runNavigation(page, op, async () => { attempts++; throw new Error("Timeout"); }), /Timeout/);
  assert.equal(attempts, 1);
  assert.deepEqual(events, ["Page.stopLoading", "detach"]);
});

test("successful navigation removes cancellation hook and does not stop a later load", async t => {
  const op = operation(t);
  const { page, events } = mockPage();
  await runNavigation(page, op, async () => {});
  op.cancel();
  assert.deepEqual(events, ["detach"]);
});

test("unconfirmed stop remains an uncertain failure, not recovered success", async t => {
  const op = operation(t);
  const { page, events } = mockPage(async () => { throw new Error("connection closed"); });
  await assert.rejects(runNavigation(page, op, async () => { throw new Error("Timeout"); }), /stop could not be confirmed; effects remain uncertain/);
  assert.deepEqual(events, ["Page.stopLoading", "detach"]);
});

test("already cancelled navigation performs no browser operation", async t => {
  const op = operation(t); op.cancel();
  let connected = false;
  await assert.rejects(runNavigation({ context() { connected = true; } }, op, async () => {}), /cancelled/i);
  assert.equal(connected, false);
});

test("cancellation during CDP attachment never starts navigation", async t => {
  const op = operation(t);
  let attach;
  let detached = false;
  let executed = false;
  const attachment = new Promise(resolve => { attach = resolve; });
  const page = { context: () => ({ newCDPSession: () => attachment }) };
  const result = runNavigation(page, op, async () => { executed = true; });
  op.cancel();
  attach({ send() { throw new Error("no stop is needed before navigation starts"); }, async detach() { detached = true; } });
  await assert.rejects(result, /cancelled/i);
  assert.equal(executed, false);
  assert.equal(detached, true);
});

test("real stalled loopback navigation cancels promptly and leaves the runtime usable without replay", { timeout: 30000 }, async t => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { BrowserRuntime } = await import("../runtime.mjs");
  const { loadConfig } = await import("../config.mjs");
  let reached;
  const requestReached = new Promise(resolve => { reached = resolve; });
  let stalledRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/stall") { stalledRequests++; reached(); return; }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>Navigation recovery</title><h1>Ready</h1>");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const runtime = new BrowserRuntime({ ...await loadConfig(process.env), actionTimeout: 5000 });
  t.after(() => runtime.dispose());
  const decode = result => JSON.parse(result.content[0].text);
  const origin = "http://127.0.0.1:" + server.address().port;
  const first = decode(await runtime.call("first", "browser_step", { actions: [{ type: "navigate", url: origin }] }));
  assert.equal(first.status, "completed", JSON.stringify(first));
  const pending = runtime.call("stall", "browser_step", { page_id: first.page_id, actions: [
    { type: "navigate", url: origin + "/stall" },
    { type: "reload" },
  ] });
  await requestReached;
  const cancelledAt = performance.now();
  runtime.cancel("stall");
  const result = decode(await pending);
  assert.ok(performance.now() - cancelledAt < 4000, "cancellation must settle before the original five-second action timeout");
  assert.equal(result.status, "cancelled");
  assert.equal(result.actions[0].status, "uncertain");
  assert.equal(result.actions[1].status, "not_started");
  assert.equal(result.cleanup.held_inputs_released, true);
  assert.equal(stalledRequests, 1);
  const observed = await runtime.call("observe", "browser_observe", { page_id: first.page_id });
  assert.equal(decode(observed).browser_instance_id, first.browser_instance_id);
  assert.ok(observed.content.some(block => block.type === "image"));
  assert.equal(runtime.status().last_operation.operation_id, "stall");
});
