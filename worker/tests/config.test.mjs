import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Profile, loadConfig, parseServiceAuth, redact } from "../config.mjs";
import { BrowserRuntime } from "../runtime.mjs";
import { Diagnostics } from "../diagnostics.mjs";
import { tools } from "../schemas.mjs";

test("operator policy is fixed outside tool arguments and rejects malformed authority", async () => {
  assert.throws(() => parseServiceAuth({ allowed_origins: ["https://example.com/path"], headers: { authorization: "secret" } }), /exact/);
  assert.throws(() => parseServiceAuth({ allowed_origins: ["https://example.com"], headers: { host: "evil.example" } }), /Unsupported/);
  assert.throws(() => parseServiceAuth({ allowed_origins: ["https://example.com"], headers: { authorization: "one\r\ntwo" } }), /invalid/);
  assert.throws(() => parseServiceAuth({ allowed_origins: ["https://example.com"], env_headers: { authorization: "ABSENT" } }, {}), /missing/);
  const auth = parseServiceAuth({ allowed_origins: ["https://example.com"], env_headers: { authorization: "TOKEN" } }, { TOKEN: "secret-value" });
  assert.equal(redact("token=secret-value https://user:password@example.com", auth), "token=[redacted] https://[redacted]@example.com");
  const config = await loadConfig({});
  assert.equal(config.headless, true);
  assert.equal(config.noSandbox, false);
  assert.equal(config.cdp, false);
  assert.equal(config.serviceAuth, null);
  assert.equal(tools.find((tool) => tool.name === "browser_step").annotations.destructiveHint, true);
});

test("dedicated profiles have exclusive lifetime locks and normal profiles are refused", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sedna-config-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = path.join(root, "automation");
  const first = new Profile({ profile });
  const second = new Profile({ profile });
  await first.acquire();
  assert.equal((await fs.stat(profile)).mode & 0o777, 0o700);
  await assert.rejects(second.acquire(), /locked/);
  await first.release();
  await second.acquire();
  await second.release();
  assert.equal(JSON.parse(await fs.readFile(path.join(profile, ".sedna-browser-profile.json"))).product, "sedna-browser-mcp");
  const normal = path.join(root, "normal");
  await fs.mkdir(normal, { mode: 0o700 });
  await fs.writeFile(path.join(normal, "Preferences"), "{}");
  await assert.rejects(new Profile({ profile: normal }).acquire(), /normal browser profiles/);
  const link = path.join(root, "linked");
  await fs.symlink(profile, link);
  await assert.rejects(new Profile({ profile: link }).acquire(), /symlink/);
  const temporary = new Profile({});
  const directory = await temporary.acquire();
  await temporary.release();
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});

test("the complete batch is rejected before lazy startup or any earlier effects", async (t) => {
  const runtime = new BrowserRuntime(await loadConfig({}));
  t.after(() => runtime.dispose());
  const decode = (result) => JSON.parse(result.content[0].text);
  const invalid = decode(await runtime.call(1, "browser_step", {
    actions: [{ type: "navigate", url: "https://example.com" }, { type: "fill", target: { css: "#field" }, text: "x", extra: true }],
  }));
  assert.equal(invalid.status, "rejected");
  assert.equal(runtime.status().running, false);
  assert.equal(runtime.status().profile_reserved, false);
  const invalidKey = decode(await runtime.call(2, "browser_step", {
    actions: [{ type: "navigate", url: "https://example.com" }, { type: "press", key: "InvalidKey" }],
  }));
  assert.equal(invalidKey.status, "rejected");
  assert.equal(runtime.status().profile_reserved, false);
  const coordinate = decode(await runtime.call(3, "browser_step", { actions: [{ type: "click", x: 10, y: 10 }] }));
  assert.equal(coordinate.error.code, "OBSERVATION_REQUIRED");
  const stale = decode(await runtime.call(4, "browser_observe", { page_id: "another-provider:p1" }));
  assert.equal(stale.error.code, "PAGE_NOT_FOUND");
  assert.equal(runtime.status().running, false);
});

test("diagnostic completion gets a cursor event and retention is bounded", () => {
  const page = new EventEmitter();
  const history = new Diagnostics(page, null);
  const request = {
    method: () => "GET", url: () => "https://example.com/resource", resourceType: () => "fetch",
    failure: () => ({ errorText: "net::ERR_FAILED" }),
  };
  page.emit("request", request);
  const cursor = history.read().next_seq;
  page.emit("requestfailed", request);
  const completion = history.read({ since_seq: cursor });
  assert.equal(completion.events.length, 1);
  assert.equal(completion.events[0].state, "failed");
  assert.equal(completion.events[0].request_started_seq, cursor);
  for (let i = 0; i < 600; i++) history.push({ kind: "console", text: String(i), level: "log" });
  assert.equal(history.events.length, 512);
  assert.equal(history.read({ limit: 200 }).events.length, 200);
  assert.ok(history.read().dropped_events > 0);
  const expiredCursor = history.read({ since_seq: 0, limit: 200 });
  assert.equal(expiredCursor.coverage.retention_gap, true);
  assert.equal(expiredCursor.coverage.complete, false);
  history.dispose();
  assert.equal(page.listenerCount("request"), 0);
});

test("diagnostics scope navigation and origin, redact URLs, and advance filtered cursors", () => {
  const page = new EventEmitter();
  const mainFrame = {};
  let currentUrl = "https://current.example/start?token=page-secret#page-fragment";
  page.mainFrame = () => mainFrame;
  page.url = () => currentUrl;
  const history = new Diagnostics(page, null);
  const unavailable = history.read({ scope: "current_navigation" });
  assert.equal(unavailable.scope_available, false);
  assert.equal(unavailable.coverage.complete, false);
  const request = (url, { method = "GET", resourceType = "fetch", navigation = false } = {}) => ({
    method: () => method,
    url: () => url,
    resourceType: () => resourceType,
    isNavigationRequest: () => navigation,
    frame: () => mainFrame,
    redirectedFrom: () => null,
    failure: () => null,
  });
  const respond = (req, status) => page.emit("response", { request: () => req, status: () => status });

  const oldNavigation = request("https://prior.example/old?token=old-url-secret#old-url-fragment", { navigation: true });
  page.emit("request", oldNavigation);
  const oldFetch = request("https://prior.example/api/old?token=old-request-secret#old-request-fragment");
  page.emit("request", oldFetch);

  const currentNavigation = request("https://current.example/current?token=navigation-secret#navigation-fragment", { navigation: true });
  page.emit("request", currentNavigation);
  const navigationStartSeq = history.seq;
  page.emit("requestfinished", oldFetch);
  currentUrl = "https://current.example/current?token=page-secret#page-fragment";
  history.push({
    kind: "console", level: "error", text: "service diagnostic /internal?token=runtime-secret#runtime-fragment",
    location: { url: "https://current.example/diagnostic?token=raw-url-secret#raw-url-fragment", line: 1 },
  });
  const currentFetch = request("https://current.example/api/check?token=request-secret#request-fragment", { method: "POST" });
  page.emit("request", currentFetch);
  respond(currentFetch, 201);
  page.emit("requestfinished", currentFetch);
  const externalImage = request("https://ads.example/pixel?token=external-secret#external-fragment", { resourceType: "image" });
  page.emit("request", externalImage);
  respond(externalImage, 200);
  page.emit("requestfinished", externalImage);
  page.emit("console", {
    type: () => "error",
    text: () => "failed https://current.example/debug?token=console-secret#console-fragment",
    location: () => ({ url: "https://current.example/script.js?token=location-secret#location-fragment", lineNumber: 8 }),
  });

  const current = history.read({ scope: "current_navigation", limit: 200 });
  assert.equal(current.scope, "current_navigation");
  assert.equal(current.scope_available, true);
  assert.equal(current.navigation_start_seq, navigationStartSeq);
  assert.equal(current.url_redaction, "query_and_fragment_omitted");
  assert.ok(current.events.some((event) => event.url?.endsWith("/api/check")));
  assert.ok(!current.events.some((event) => event.url?.includes("/api/old")));
  assert.ok(current.events.every((event) => event.navigation_seq === navigationStartSeq));
  assert.doesNotMatch(JSON.stringify(current), /old-url-secret|old-url-fragment|old-request-secret|old-request-fragment|navigation-secret|navigation-fragment|runtime-secret|runtime-fragment|raw-url-secret|raw-url-fragment|request-secret|request-fragment|external-secret|external-fragment|console-secret|console-fragment|location-secret|location-fragment/);
  const injectedEvent = current.events.find((event) => event.text?.startsWith("service diagnostic"));
  assert.equal(injectedEvent.text, "service diagnostic /internal");
  assert.equal(injectedEvent.location.url, "https://current.example/diagnostic");
  const consoleEvent = current.events.find((event) => event.location?.url === "https://current.example/script.js");
  assert.equal(consoleEvent.location.url, "https://current.example/script.js");
  assert.equal(consoleEvent.text, "failed https://current.example/debug");

  const origin = history.read({ scope: "current_origin", limit: 200 });
  assert.equal(origin.scope_available, true);
  assert.equal(origin.scope_origin, "https://current.example");
  assert.ok(!origin.events.some((event) => event.kind === "network" && event.url?.startsWith("https://ads.example")));
  assert.ok(origin.events.some((event) => event.kind === "console"));

  const filtered = history.read({ scope: "current_navigation", method: "post", status: 201, resource_type: "fetch", limit: 200 });
  assert.ok(filtered.events.length > 0);
  assert.ok(filtered.events.every((event) => event.kind === "network" && event.method === "POST" && event.status === 201 && event.resource_type === "fetch"));
  assert.deepEqual(filtered.filters, { method: "POST", status: 201, resource_type: "fetch" });

  const startingCursor = history.seq;
  const unrelated = request("https://current.example/api/unrelated", { method: "GET" });
  page.emit("request", unrelated);
  page.emit("requestfinished", unrelated);
  const noMatch = history.read({ since_seq: startingCursor, scope: "current_navigation", method: "PATCH", limit: 1 });
  assert.deepEqual(noMatch.events, []);
  assert.equal(noMatch.next_seq, history.seq);
  assert.equal(noMatch.has_more, false);
  assert.equal(noMatch.coverage.complete, true);

  const firstPatch = request("https://current.example/api/first", { method: "PATCH" });
  page.emit("request", firstPatch);
  respond(firstPatch, 204);
  const secondPatch = request("https://current.example/api/second", { method: "PATCH" });
  page.emit("request", secondPatch);
  respond(secondPatch, 204);
  const firstPage = history.read({ since_seq: noMatch.next_seq, scope: "current_navigation", method: "PATCH", status: 204, limit: 1 });
  assert.equal(firstPage.events.length, 1);
  assert.equal(firstPage.has_more, true);
  assert.equal(firstPage.coverage.omitted_direction, "newer");
  assert.equal(firstPage.next_seq, firstPage.events[0].seq);
  const secondPage = history.read({ since_seq: firstPage.next_seq, scope: "current_navigation", method: "PATCH", status: 204, limit: 1 });
  assert.equal(secondPage.events.length, 1);
  assert.equal(secondPage.has_more, false);
  assert.equal(secondPage.next_seq, history.seq);
  assert.equal(secondPage.coverage.complete, true);
  history.dispose();
});
