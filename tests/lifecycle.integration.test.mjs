import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { McpClient, successful, textPayload, images } from './support/mcp-client.mjs';
import { fixtureServer } from './support/fixture.mjs';

async function until(predicate, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(50);
  }
  return false;
}

test('MCP cancellation settles input and preserves a receipt even when the protocol suppresses its response', { timeout: 45000 }, async t => {
  const fixture = await fixtureServer();
  const client = new McpClient({ env: { SEDNA_BROWSER_CDP: 'true' } });
  let companion;
  t.after(async () => { if (companion) await companion.close().catch(() => {}); await client.close(); await fixture.close(); });
  const first = successful(await client.call('browser_step', { actions: [{ type: 'navigate', url: fixture.url }] }));
  const status = successful(await client.call('browser_session', { action: 'status' }));
  companion = await chromium.connectOverCDP(status.cdp_endpoint);
  const page = companion.contexts()[0].pages().find(candidate => candidate.url() === fixture.url);
  assert.ok(page);
  const pending = client.begin('tools/call', {
    name: 'browser_step', arguments: { page_id: first.page_id, actions: [
      { type: 'click', target: { css: '#increment' } },
      { type: 'key_down', key: 'Shift' },
      { type: 'wait', ms: 1000 },
      { type: 'click', target: { css: '#increment' } },
    ] },
  });
  await page.waitForFunction(() => window.fixture.count === 1 && window.fixture.keyEvents.some(event => event.type === 'keydown' && event.key === 'Shift'));
  client.notify('notifications/cancelled', { requestId: pending.id, reason: 'Integration cancellation after a known applied action.' });
  client.discardResponse(pending.id);
  const reconciled = successful(await client.call('browser_session', { action: 'status' }));
  assert.equal(reconciled.last_operation.status, 'cancelled');
  assert.equal(reconciled.last_operation.method, 'browser_step');
  assert.equal(reconciled.last_operation.actions[0].status, 'completed');
  assert.equal(reconciled.last_operation.actions[3].status, 'not_started');
  assert.equal(reconciled.last_operation.cleanup.held_inputs_released, true);
  assert.equal(reconciled.last_operation.images_retained, false);
  assert.equal(await page.evaluate(() => window.fixture.count), 1);
  assert.equal(await page.evaluate(() => window.fixture.keyEvents.filter(event => event.key === 'Shift').at(-1).type), 'keyup');
  images(await client.call('browser_observe', { page_id: first.page_id }));
  const stillReconciled = successful(await client.call('browser_session', { action: 'status' }));
  assert.equal(stillReconciled.last_operation.operation_id, reconciled.last_operation.operation_id);
  successful(await client.call('browser_step', { page_id: first.page_id, actions: [{ type: 'click', target: { css: '#increment' } }] }));
  assert.equal(await page.evaluate(() => window.fixture.count), 2, 'A cancelled action must never be automatically replayed.');
});

test('an unexpected Chromium exit requires an explicit reset and never silently replaces live state', { timeout: 45000 }, async t => {
  const client = new McpClient({ env: { SEDNA_BROWSER_CDP: 'true' } });
  let companion;
  t.after(async () => { if (companion) await companion.close().catch(() => {}); await client.close(); });
  const first = successful(await client.call('browser_observe'));
  const before = successful(await client.call('browser_session', { action: 'status' }));
  companion = await chromium.connectOverCDP(before.cdp_endpoint);
  const session = await companion.newBrowserCDPSession();
  await session.send('Browser.close').catch(() => {});
  assert.ok(await until(async () => successful(await client.call('browser_session', { action: 'status' })).running === false));
  const status = successful(await client.call('browser_session', { action: 'status' }));
  assert.equal(status.lifecycle, 'lost');
  assert.equal(status.reset_required, true);
  const rejected = await client.call('browser_observe');
  assert.equal(rejected.isError, true);
  assert.equal(textPayload(rejected).status, 'rejected');
  const reset = successful(await client.call('browser_session', { action: 'reset' }));
  assert.equal(reset.running, true);
  assert.notEqual(reset.browser_instance_id, first.browser_instance_id);
  images(await client.call('browser_observe'));
});

async function childPids(pid) {
  // task/<pid>/children is optional in Linux proc implementations (including
  // some containers). stat's parent PID provides the same ownership check.
  const entries = (await fs.readdir('/proc')).filter(name => /^\d+$/.test(name));
  const processes = await Promise.all(entries.map(async name => {
    try { return { pid: Number(name), ...await processStat(Number(name)) }; }
    catch (error) {
      if (['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) return null;
      throw error;
    }
  }));
  return processes.filter(entry => entry?.parentPid === pid).map(entry => entry.pid);
}

async function processStat(pid) {
  const text = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { state: fields[0], parentPid: Number(fields[1]), groupId: Number(fields[2]), startedAt: fields[19] };
}

async function commandLine(pid) {
  try { return (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0'); } catch { return []; }
}

async function alive(pid) {
  try {
    return !['Z', 'X'].includes((await processStat(pid)).state);
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return false;
    throw error;
  }
}

test('abrupt worker death closes its real Chromium even though Playwright uses a separate browser process group', {
  timeout: 35000, skip: process.platform !== 'linux' ? 'Linux /proc ownership check' : false,
}, async t => {
  const client = new McpClient();
  let browserPid;
  let browserIdentity;
  t.after(async () => {
    await client.close();
    // This fallback is restricted to the exact test child and its observed
    // debugging-pipe command line; it prevents a failing test leaving Chrome.
    if (browserPid && await alive(browserPid) &&
        (await processStat(browserPid)).startedAt === browserIdentity?.startedAt &&
        browserIdentity.groupId === browserPid &&
        (await commandLine(browserPid)).includes('--remote-debugging-pipe')) {
      try { process.kill(-browserPid, 'SIGTERM'); } catch {}
    }
  });
  successful(await client.call('browser_observe'));
  const workers = await childPids(client.child.pid);
  assert.equal(workers.length, 1, 'The host should own one Node worker.');
  const workerPid = workers[0];
  for (const child of await childPids(workerPid)) {
    if ((await commandLine(child)).includes('--remote-debugging-pipe')) browserPid = child;
  }
  assert.ok(browserPid, 'Could not identify the exact owned Chromium process.');
  browserIdentity = await processStat(browserPid);
  assert.equal(browserIdentity.groupId, browserPid, 'Playwright should own a separate Chromium process group.');
  assert.notEqual(browserIdentity.groupId, (await processStat(workerPid)).groupId);
  assert.equal(await alive(browserPid), true);
  process.kill(workerPid, 'SIGKILL');
  const exited = await until(async () => !await alive(browserPid), 8000);
  assert.equal(exited, true, 'Chromium survived the death of its owning Node worker.');
  const failed = await client.call('browser_session', { action: 'status' });
  assert.equal(failed.isError, true);
  const again = await client.call('browser_observe');
  assert.equal(again.isError, true);
  assert.match(again.content.find(block => block.type === 'text').text, /unavailable|never replayed|new server/i);
});
