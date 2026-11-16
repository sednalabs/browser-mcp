import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { parseManagedEndpoint, readManagedEndpoint } from '../cdp-endpoint.mjs';

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-cdp-fixture-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('managed endpoint parser accepts only a local port and browser path', () => {
  assert.equal(parseManagedEndpoint('34567\n/devtools/browser/abc-123\n'), 'ws://127.0.0.1:34567/devtools/browser/abc-123');
  for (const text of ['', '0\n/devtools/browser/id', '65536\n/devtools/browser/id', '22.1\n/devtools/browser/id', '0x123\n/devtools/browser/id', '123\nws://example.com/', '123\n/devtools/page/id', '123\n/devtools/browser/id\nextra']) assert.equal(parseManagedEndpoint(text), null);
});

test('CDP readiness tolerates initially missing and partial file without relaunching', async t => {
  const dir = await directory(t);
  const pending = readManagedEndpoint(dir, { timeoutMs: 1000 });
  await pause(30);
  await fs.writeFile(path.join(dir, 'DevToolsActivePort'), '34567\n');
  await pause(30);
  await fs.writeFile(path.join(dir, 'DevToolsActivePort'), '34567\n/devtools/browser/abc-123\n');
  assert.equal(await pending, 'ws://127.0.0.1:34567/devtools/browser/abc-123');
});

test('missing or malformed endpoint fails within a bounded deadline, without file contents', async t => {
  const dir = await directory(t);
  const start = performance.now();
  await assert.rejects(readManagedEndpoint(dir, { timeoutMs: 60 }), /bounded readiness deadline/);
  assert.ok(performance.now() - start < 1000);
  await fs.writeFile(path.join(dir, 'DevToolsActivePort'), 'secret-invalid-endpoint');
  await assert.rejects(readManagedEndpoint(dir, { timeoutMs: 60 }), error => {
    assert.match(error.message, /bounded readiness deadline/);
    assert.doesNotMatch(error.message, /secret-invalid-endpoint/);
    return true;
  });
});

test('unrelated filesystem failures are not silently retried', async t => {
  const dir = await directory(t);
  await fs.writeFile(path.join(dir, 'not-directory'), 'fixture');
  await assert.rejects(readManagedEndpoint(path.join(dir, 'not-directory'), { timeoutMs: 60 }), { code: 'ENOTDIR' });
});

 test('early browser closure stops readiness without replacement', async t => {
  const dir = await directory(t);
  let alive = true;
  const pending = readManagedEndpoint(dir, { timeoutMs: 500, isAlive: () => alive });
  const rejected = assert.rejects(pending, /Browser closed before/);
  await pause(30);
  alive = false;
  await rejected;
});
