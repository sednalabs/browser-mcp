import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../config.mjs';
import { BrowserRuntime } from '../runtime.mjs';
const payload = result => JSON.parse(result.content[0].text);

test('file selection denies unknown grants and frames before earlier batch effects', async t => {
  const runtime = new BrowserRuntime(await loadConfig({})); t.after(() => runtime.dispose());
  for (const [id, action] of [
    { type: 'set_files', target: { css: 'input' }, handles: ['ungranted'] },
    { type: 'set_files', target: { css: 'input', frame: 'iframe' }, handles: [] },
    { type: 'set_files', target: { css: 'input' }, handles: [] },
  ].entries()) {
    const result = payload(await runtime.call(id, 'browser_step', { actions: [{ type: 'navigate', url: 'https://example.com' }, action] }));
    assert.equal(result.status, 'rejected');
    assert.equal(runtime.status().profile_reserved, false);
  }
});

test('HTTP refuses file grants before attempting any configured file read', async t => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.file-selection-http-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'config.json');
  await fs.writeFile(config, JSON.stringify({ file_grants: [{ path: '/never/read/private-secret', allowed_origins: ['https://example.com'] }] }), { mode: 0o600 });
  await assert.rejects(loadConfig({ SEDNA_BROWSER_CONFIG: config, SEDNA_BROWSER_HTTP_WORKER: 'true' }), error => /HTTP/.test(error.message) && !error.message.includes('private-secret'));
});

test('malformed operator JSON does not echo file grant paths', async t => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.file-selection-json-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'config.json');
  await fs.writeFile(config, '{"file_grants": ["/private/path-marker" broken}', { mode: 0o600 });
  await assert.rejects(loadConfig({ SEDNA_BROWSER_CONFIG: config }), error => /valid JSON/.test(error.message) && !error.message.includes('path-marker'));
});

test('grant config in a shared temporary ancestor is rejected before source files', async t => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.file-grant-untrusted-config-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const shared = path.join(dir, 'shared');
  const setup = spawnSync(process.execPath, ['--input-type=module', '-e', 'import fs from "node:fs/promises"; process.umask(0); await fs.mkdir(process.argv[1], {mode:0o777});', shared]);
  assert.equal(setup.status, 0);
  const config = path.join(shared, 'config.json');
  await fs.writeFile(config, JSON.stringify({ file_grants: [{ path: '/must-not-read-source', allowed_origins: ['https://example.com'] }] }), { mode: 0o600 });
  await assert.rejects(loadConfig({ SEDNA_BROWSER_CONFIG: config }), error => /configuration must use a trusted/.test(error.message) && !error.message.includes('must-not-read-source'));
});

test('real file selection uses immutable grants, checks destination and preserves uncertain receipts', async t => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.file-selection-browser-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<input id="single" type="file"><input id="many" type="file" multiple><script>window.selections=0;document.querySelector("#single").addEventListener("change",async e=>{window.selections++;window.chosen=await e.target.files[0]?.text();});</script>'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const first = path.join(dir, 'first.txt'), second = path.join(dir, 'second.txt'), config = path.join(dir, 'config.json');
  await fs.writeFile(first, 'fictional immutable content'); await fs.writeFile(second, 'second fictional file');
  await fs.writeFile(config, JSON.stringify({ file_grants: [first, second].map(file => ({ path: file, allowed_origins: [origin] })) }), { mode: 0o600 });
  const runtime = new BrowserRuntime(await loadConfig({ ...process.env, SEDNA_BROWSER_CONFIG: config })); t.after(() => runtime.dispose());
  const grants = runtime.status().file_grants; assert.equal(grants.length, 2);
  assert.ok(!JSON.stringify(grants).includes(dir));
  await fs.writeFile(first, 'replacement must not be selected');
  const nav = payload(await runtime.call('nav', 'browser_step', { actions: [{ type: 'navigate', url: origin }] }));
  const page = runtime.pages.get(nav.page_id).page;
  const chosen = payload(await runtime.call('select', 'browser_step', { actions: [{ type: 'set_files', target: { css: '#single' }, handles: [grants[0].handle] }] }));
  assert.equal(chosen.actions[0].status, 'completed');
  assert.equal(await page.evaluate(() => window.chosen), 'fictional immutable content');
  assert.equal(await page.evaluate(() => window.selections), 1);
  const tooMany = payload(await runtime.call('multiple', 'browser_step', { actions: [{ type: 'set_files', target: { css: '#single' }, handles: grants.map(g => g.handle) }] }));
  assert.equal(tooMany.actions[0].status, 'rejected');
  assert.equal(await page.evaluate(() => window.selections), 1);
  const locate = page.locator.bind(page);
  page.locator = (...args) => {
    const locator = locate(...args), get = locator.elementHandle.bind(locator);
    locator.elementHandle = async options => {
      const element = await get(options), select = element.setInputFiles.bind(element);
      element.setInputFiles = async (...input) => { await select(...input); throw new Error('Injected lost acknowledgment after selection'); };
      return element;
    };
    return locator;
  };
  const uncertain = payload(await runtime.call('uncertain', 'browser_step', { actions: [{ type: 'set_files', target: { css: '#single' }, handles: [grants[1].handle] }, { type: 'wait', ms: 1 }] }));
  page.locator = locate;
  assert.equal(uncertain.actions[0].status, 'uncertain'); assert.equal(uncertain.actions[1].status, 'not_started');
  assert.equal(await page.evaluate(() => window.selections), 2);
  const cleared = payload(await runtime.call('clear', 'browser_step', { actions: [{ type: 'set_files', target: { css: '#many' }, handles: [] }] }));
  assert.equal(cleared.actions[0].status, 'completed');
  await page.goto('about:blank'); await page.setContent('<input type="file">');
  const denied = payload(await runtime.call('wrong-origin', 'browser_step', { actions: [{ type: 'set_files', target: { css: 'input' }, handles: [grants[0].handle] }] }));
  assert.equal(denied.actions[0].status, 'rejected');
  assert.equal(await page.locator('input').evaluate(el => el.files.length), 0);
  await runtime.call('close', 'browser_session', { action: 'close' });
  assert.deepEqual(runtime.status().file_grants, []);
  const revoked = payload(await runtime.call('revoked', 'browser_step', { actions: [{ type: 'set_files', target: { css: 'input' }, handles: [grants[0].handle] }] }));
  assert.equal(revoked.status, 'rejected');
});
