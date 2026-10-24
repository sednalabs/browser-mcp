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
  history.dispose();
  assert.equal(page.listenerCount("request"), 0);
});
