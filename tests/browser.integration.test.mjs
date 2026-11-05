import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { McpClient, successful, textPayload, images } from './support/mcp-client.mjs';
import { fixtureServer } from './support/fixture.mjs';

const toolNames = ['browser_inspect', 'browser_observe', 'browser_review', 'browser_session', 'browser_step', 'browser_tabs'];

async function attachedPage(browser, targetId) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const session = await context.newCDPSession(page);
      try {
        const { targetInfo } = await session.send('Target.getTargetInfo');
        if (targetInfo.targetId === targetId) return page;
      } finally { await session.detach(); }
    }
  }
  throw new Error('The advertised Chrome target ID did not identify a live page.');
}

test('modern MCP controls a continuous real browser with typed images and honest receipts', { timeout: 180000 }, async t => {
  const fixture = await fixtureServer();
  const client = new McpClient({ env: { SEDNA_BROWSER_CDP: 'true' } });
  let companion;
  t.after(async () => {
    if (companion) await companion.close().catch(() => {});
    await client.close();
    await fixture.close();
  });

  await t.test('discovers and lists all tools without a legacy initialize or a browser launch', async () => {
    const discovery = await client.request('server/discover');
    assert.ok(!discovery.error, JSON.stringify(discovery));
    const catalog = await client.request('tools/list');
    assert.deepEqual(catalog.result.tools.map(tool => tool.name).sort(), toolNames);
    assert.equal(catalog.result.ttlMs, 0);
    assert.equal(catalog.result.cacheScope, 'private');
    assert.equal(catalog.result.resultType, 'complete');
    assert.equal(catalog.result.tools.find(tool => tool.name === 'browser_step').annotations.destructiveHint, true);
    const status = successful(await client.call('browser_session', { action: 'status' }));
    assert.equal(status.running, false);
    assert.equal(status.browser_instance_id, null);
  });

  let pageId;
  let page;
  let latest;
  await t.test('navigates and returns an inline screenshot with correct image geometry', async () => {
    const result = await client.call('browser_step', { actions: [{ type: 'navigate', url: fixture.url }] });
    latest = successful(result);
    images(result);
    pageId = latest.page_id;
    assert.equal(latest.page.url, fixture.url);
    assert.equal(latest.actions[0].status, 'completed');
    assert.equal(latest.actionable, true);
    assert.deepEqual(latest.geometry.viewport, { width: 1280, height: 800 });
    assert.deepEqual(latest.geometry.image, { width: 1280, height: 800 });
    assert.equal(result.content[latest.images[0].content_index].type, 'image');
    const status = successful(await client.call('browser_session', { action: 'status' }));
    assert.match(status.cdp_endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
    companion = await chromium.connectOverCDP(status.cdp_endpoint);
    page = await attachedPage(companion, latest.target_id);
    // A Playwright companion otherwise auto-dismisses native dialogs. This
    // observer must remain passive while the MCP owner exercises dialog input.
    page.on('dialog', () => {});
  });

  await t.test('keeps an open menu, unsaved input, focus and the same loaded document across observe calls', async () => {
    latest = successful(await client.call('browser_step', {
      page_id: pageId,
      actions: [
        { type: 'click', target: { role: 'button', name: 'Open menu' } },
        { type: 'fill', target: { label: 'Unsaved draft' }, text: 'This exists only in the live DOM.' },
        { type: 'focus', target: { css: '#draft' } },
      ],
    }));
    const snapshot = () => page.evaluate(() => ({
      draft: document.getElementById('draft').value,
      menuHidden: document.getElementById('menu').hidden,
      focused: document.activeElement.id,
      loaded: window.fixture.loaded,
      resizes: window.fixture.resizeEvents,
      scroll: [scrollX, scrollY],
    }));
    const before = await snapshot();
    assert.equal(before.menuHidden, false);
    assert.equal(before.focused, 'draft');
    for (let index = 0; index < 2; index++) {
      const result = await client.call('browser_observe', { page_id: pageId });
      latest = successful(result);
      images(result);
      assert.ok(latest.page.controls.some(control => control.focused && control.name === 'Unsaved draft'));
    }
    assert.deepEqual(await snapshot(), before);
  });

  await t.test('rejects a statically invalid later action before any earlier action has effects', async () => {
    const count = await page.evaluate(() => window.fixture.count);
    const result = await client.call('browser_step', {
      page_id: pageId,
      actions: [
        { type: 'click', target: { css: '#increment' } },
        { type: 'navigate', url: 'javascript:document.body.remove()' },
      ],
    });
    assert.equal(result.isError, true);
    assert.equal(textPayload(result).status, 'rejected');
    assert.equal(await page.evaluate(() => window.fixture.count), count);
  });

  await t.test('returns completed and unstarted action receipts after a runtime failure without replay', async () => {
    const count = await page.evaluate(() => window.fixture.count);
    const result = await client.call('browser_step', {
      page_id: pageId,
      actions: [
        { type: 'click', target: { css: '#increment' } },
        { type: 'wait_for', target: { css: '#does-not-exist' }, timeout_ms: 200 },
        { type: 'click', target: { css: '#increment' } },
      ],
    });
    assert.equal(result.isError, true);
    const receipt = textPayload(result);
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.actions[0].status, 'completed');
    assert.notEqual(receipt.actions[1].status, 'completed');
    assert.equal(receipt.actions[2].status, 'not_started');
    assert.equal(receipt.cleanup.held_inputs_released, true);
    images(result);
    latest = successful(await client.call('browser_observe', { page_id: pageId }));
    assert.equal(await page.evaluate(() => window.fixture.count), count + 1);
  });

  await t.test('requires a fresh observation for coordinate input and performs the indicated click', async () => {
    const oldObservation = latest.observation_id;
    latest = successful(await client.call('browser_observe', { page_id: pageId }));
    const rejected = await client.call('browser_step', {
      page_id: pageId, observation_id: oldObservation, actions: [{ type: 'click', x: 1, y: 1 }],
    });
    assert.equal(rejected.isError, true);
    assert.equal(textPayload(rejected).error.code, 'STALE_OBSERVATION');
    latest = successful(await client.call('browser_observe', { page_id: pageId }));
    const control = latest.page.controls.find(item => item.name === 'Increment');
    assert.ok(control);
    const count = await page.evaluate(() => window.fixture.count);
    latest = successful(await client.call('browser_step', {
      page_id: pageId, observation_id: latest.observation_id,
      actions: [{ type: 'click', x: control.box.x + control.box.width / 2, y: control.box.y + control.box.height / 2 }],
    }));
    assert.equal(await page.evaluate(() => window.fixture.count), count + 1);
  });

  await t.test('releases operation-owned keys and buttons after a later action fails', async () => {
    latest = successful(await client.call('browser_observe', { page_id: pageId }));
    const result = await client.call('browser_step', {
      page_id: pageId, observation_id: latest.observation_id,
      actions: [
        { type: 'key_down', key: 'Shift' },
        { type: 'mouse_move', x: 40, y: 40 },
        { type: 'mouse_down', button: 'left' },
        { type: 'wait_for', target: { css: '#does-not-exist' }, timeout_ms: 200 },
      ],
    });
    assert.equal(result.isError, true);
    assert.equal(textPayload(result).cleanup.held_inputs_released, true);
    const state = await page.evaluate(() => ({ keys: window.fixture.keyEvents, pointers: window.fixture.pointerEvents }));
    assert.equal(state.keys.filter(event => event.key === 'Shift').at(-1).type, 'keyup');
    assert.equal(state.pointers.at(-1).type, 'pointerup');
    assert.equal(state.pointers.at(-1).buttons, 0);
  });

  await t.test('retains console and network diagnostics across separate calls with a working cursor', async () => {
    successful(await client.call('browser_step', { page_id: pageId, actions: [{ type: 'click', target: { css: '#network' } }] }));
    await page.waitForFunction(() => document.getElementById('events').textContent === 'network-complete');
    const history = successful(await client.call('browser_inspect', { page_id: pageId, limit: 200 }));
    assert.ok(history.events.some(event => event.kind === 'console' && event.text.includes('retained-console-error')));
    assert.ok(history.events.some(event => event.kind === 'network' && event.url.endsWith('/api/check') && event.status === 200));
    const next = successful(await client.call('browser_inspect', { page_id: pageId, since_seq: history.next_seq, limit: 200 }));
    assert.ok(next.events.every(event => event.seq > history.next_seq));
    assert.equal(next.collection_started_at, history.collection_started_at);
  });

  await t.test('captures labeled responsive images and reports actual viewport and scroll restoration', async () => {
    successful(await client.call('browser_step', { page_id: pageId, actions: [{ type: 'scroll', delta_y: 420 }], settle_ms: 250 }));
    const before = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, x: scrollX, y: scrollY }));
    const result = await client.call('browser_review', {
      page_id: pageId,
      captures: [
        { label: 'phone', width: 375, height: 667, scroll: 'top' },
        { label: 'desktop-bottom', width: 1280, height: 800, scroll: 'bottom' },
      ],
    });
    const review = successful(result);
    images(result, 2);
    assert.deepEqual(review.captures.map(capture => capture.label), ['phone', 'desktop-bottom']);
    assert.deepEqual(review.captures.map(capture => capture.geometry.image), [{ width: 375, height: 667 }, { width: 1280, height: 800 }]);
    for (const capture of review.captures) assert.equal(result.content[capture.content_index].type, 'image');
    assert.equal(review.restoration.viewport_restored, true);
    assert.equal(review.restoration.scroll_restored, true);
    assert.equal(review.restoration.application_state_restored, false);
    assert.deepEqual(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, x: scrollX, y: scrollY })), before);
    latest = successful(await client.call('browser_observe', { page_id: pageId }));
    assert.equal(latest.actionable, true);
  });

  await t.test('selector click returns the destination and a typed screenshot', async () => {
    const destination = new URL('/topics/cybersecurity/', fixture.url).href;
    const result = await client.call('browser_step', {
      page_id: pageId,
      actions: [
        { type: 'navigate', url: fixture.url },
        { type: 'click', target: { role: 'link', name: 'Cybersecurity' } },
      ],
    });
    latest = successful(result);
    images(result);
    assert.deepEqual(latest.actions.map(action => action.status), ['completed', 'completed']);
    assert.equal(latest.page.url, destination);
    assert.ok(latest.page.controls.some(control => control.name === 'Cybersecurity'));
    assert.equal(result.content[latest.images[0].content_index].type, 'image');
  });

  await t.test('resize persists a measured CSS viewport, scroll position and responsive layout', async () => {
    const destination = new URL('/topics/cybersecurity/', fixture.url).href;
    const result = await client.call('browser_step', {
      page_id: pageId,
      actions: [{ type: 'resize', width: 390, height: 844, scroll_y: 120 }],
    });
    latest = successful(result);
    images(result);
    assert.equal(latest.page.url, destination);
    assert.equal(latest.actions[0].status, 'completed');
    assert.deepEqual(latest.geometry.viewport, { width: 390, height: 844 });
    assert.deepEqual(latest.geometry.image, { width: 390, height: 844 });
    assert.equal(latest.geometry.scroll.y, 120);
    assert.equal(result.content[latest.images[0].content_index].type, 'image');
    assert.equal(await page.locator('main').evaluate(element => getComputedStyle(element).paddingLeft), '14px');
    assert.deepEqual(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollY })), {
      width: 390, height: 844, scrollY: 120,
    });

    const observed = await client.call('browser_observe', { page_id: pageId });
    latest = successful(observed);
    images(observed);
    assert.deepEqual(latest.geometry.viewport, { width: 390, height: 844 });
    assert.equal(latest.geometry.scroll.y, 120);
  });

  await t.test('uses distinct page and Chrome target identities for duplicate-URL tabs', async () => {
    const duplicateUrl = latest.page.url;
    const created = successful(await client.call('browser_tabs', { action: 'new', url: duplicateUrl }));
    assert.notEqual(created.page_id, pageId);
    const tabs = successful(await client.call('browser_tabs', { action: 'list' }));
    const duplicates = tabs.pages.filter(tab => tab.url === duplicateUrl);
    assert.equal(duplicates.length, 2);
    assert.notEqual(duplicates[0].target_id, duplicates[1].target_id);
    successful(await client.call('browser_tabs', { action: 'select', page_id: pageId }));
    successful(await client.call('browser_tabs', { action: 'close', page_id: created.page_id }));
    const stale = await client.call('browser_observe', { page_id: created.page_id });
    assert.equal(textPayload(stale).error.code, 'PAGE_NOT_FOUND');
  });

  await t.test('reports a native dialog, fences ordinary input and explicitly recovers its pending action', async () => {
    const count = await page.evaluate(() => window.fixture.count);
    const blocked = await client.call('browser_step', { page_id: pageId, actions: [{ type: 'click', target: { css: '#dialog' } }] });
    assert.equal(blocked.isError, true);
    const receipt = textPayload(blocked);
    assert.equal(receipt.status, 'blocked');
    assert.equal(receipt.actions[0].status, 'pending_dialog');
    assert.equal(receipt.dialog.type, 'confirm');
    assert.ok(receipt.observation_unavailable);
    assert.equal(blocked.content.filter(block => block.type === 'image').length, 0);
    const fenced = await client.call('browser_step', { page_id: pageId, actions: [{ type: 'click', target: { css: '#increment' } }] });
    assert.equal(textPayload(fenced).error.code, 'DIALOG_OPEN');
    const recovered = await client.call('browser_step', { page_id: pageId, actions: [{ type: 'dialog', action: 'accept' }] });
    const recovery = successful(recovered);
    images(recovered);
    assert.equal(recovery.cleanup.held_inputs_released, true);
    assert.equal(await page.evaluate(() => window.fixture.dialogResult), true);
    assert.equal(await page.evaluate(() => window.fixture.count), count);
  });

  await t.test('browser_inspect scopes diagnostics and never exposes URL query or fragment values', async () => {
    const otherOrigin = await fixtureServer();
    try {
      const priorUrl = new URL(fixture.url);
      priorUrl.search = '?token=prior-page-secret';
      priorUrl.hash = '#prior-page-fragment';
      successful(await client.call('browser_step', { page_id: pageId, actions: [{ type: 'navigate', url: priorUrl.toString() }] }));
      await page.evaluate(async () => {
        console.error('prior URL https://diagnostic.invalid/page?token=prior-console-secret#prior-console-fragment');
        await fetch('/api/old?token=prior-request-secret#prior-request-fragment');
      });
      const prior = successful(await client.call('browser_inspect', { page_id: pageId, scope: 'current_navigation', limit: 200 }));
      assert.ok(prior.events.some(event => event.kind === 'network' && event.url.endsWith('/api/old')));

      const currentUrl = new URL(fixture.url);
      currentUrl.pathname = '/current-navigation';
      currentUrl.search = '?token=current-navigation-secret';
      currentUrl.hash = '#current-navigation-fragment';
      successful(await client.call('browser_step', { page_id: pageId, actions: [{ type: 'navigate', url: currentUrl.toString() }] }));
      await page.evaluate(async foreignUrl => {
        console.error('current URL ' + location.href);
        await fetch('/api/check?token=current-request-secret#current-request-fragment', { method: 'POST' });
        const image = new Image();
        image.src = foreignUrl + '?token=foreign-origin-secret#foreign-origin-fragment';
        document.body.append(image);
        await new Promise(resolve => { image.onload = resolve; image.onerror = resolve; });
      }, otherOrigin.url);

      const current = successful(await client.call('browser_inspect', { page_id: pageId, scope: 'current_navigation', limit: 200 }));
      assert.equal(current.scope, 'current_navigation');
      assert.equal(current.scope_available, true);
      assert.ok(current.navigation_start_seq > prior.navigation_start_seq);
      assert.equal(current.url_redaction, 'query_and_fragment_omitted');
      assert.ok(current.events.some(event => event.kind === 'network' && event.url.endsWith('/api/check')));
      assert.ok(current.events.some(event => event.kind === 'network' && event.url.startsWith(new URL(otherOrigin.url).origin)));
      assert.ok(!current.events.some(event => event.kind === 'network' && event.url.endsWith('/api/old')));
      assert.doesNotMatch(JSON.stringify(current), /prior-page-secret|prior-page-fragment|prior-console-secret|prior-console-fragment|prior-request-secret|prior-request-fragment|current-navigation-secret|current-navigation-fragment|current-request-secret|current-request-fragment|foreign-origin-secret|foreign-origin-fragment/);

      const filtered = successful(await client.call('browser_inspect', {
        page_id: pageId, scope: 'current_navigation', method: 'post', status: 200, resource_type: 'fetch', limit: 200,
      }));
      assert.ok(filtered.events.length > 0);
      assert.ok(filtered.events.every(event => event.kind === 'network' && event.method === 'POST' && event.status === 200 && event.resource_type === 'fetch'));

      const origin = successful(await client.call('browser_inspect', { page_id: pageId, scope: 'current_origin', limit: 200 }));
      assert.equal(origin.scope_origin, new URL(fixture.url).origin);
      assert.ok(!origin.events.some(event => event.kind === 'network' && event.url.startsWith(new URL(otherOrigin.url).origin)));
      assert.equal(origin.url_redaction, 'query_and_fragment_omitted');

      const recent = successful(await client.call('browser_inspect', { page_id: pageId, scope: 'recent', limit: 200 }));
      assert.doesNotMatch(JSON.stringify(recent), /prior-page-secret|prior-console-secret|prior-request-secret|current-navigation-secret|current-request-secret|foreign-origin-secret/);
      assert.equal(recent.next_seq, recent.latest_seq);
      assert.equal(recent.coverage.mode, 'recent_tail');
    } finally {
      await otherOrigin.close();
    }
  });

  await t.test('survives an optional diagnostic companion disconnect without changing its owner or page', async () => {
    const before = successful(await client.call('browser_session', { action: 'status' }));
    await companion.close();
    companion = null;
    const result = await client.call('browser_observe', { page_id: pageId });
    const observed = successful(result);
    images(result);
    assert.equal(observed.browser_instance_id, before.browser_instance_id);
    assert.equal(observed.page_id, pageId);
    assert.equal(client.protocolErrors.length, 0);
  });
});

test('legacy MCP initialize and actual image content remain compatible', { timeout: 45000 }, async t => {
  const client = new McpClient({ legacy: true });
  t.after(() => client.close());
  const initialize = await client.initialize();
  assert.equal(initialize.serverInfo.name, 'sedna-browser-mcp');
  const catalog = await client.request('tools/list');
  assert.deepEqual(catalog.result.tools.map(tool => tool.name).sort(), toolNames);
  const result = await client.call('browser_observe');
  images(result);
  const observation = successful(result);
  assert.equal(observation.page.url, 'about:blank');
  assert.equal(result.resultType, undefined);
});

test('two MCP owners have independent live browser instances and default state', { timeout: 60000 }, async t => {
  const fixture = await fixtureServer();
  const first = new McpClient();
  const second = new McpClient();
  t.after(async () => { await first.close(); await second.close(); await fixture.close(); });
  const a = successful(await first.call('browser_step', { actions: [{ type: 'navigate', url: fixture.url }] }));
  const b = successful(await second.call('browser_observe'));
  assert.notEqual(a.browser_instance_id, b.browser_instance_id);
  assert.notEqual(a.page_id, b.page_id);
  assert.equal(b.page.url, 'about:blank');
  const wrongOwner = await second.call('browser_observe', { page_id: a.page_id });
  assert.equal(textPayload(wrongOwner).error.code, 'PAGE_NOT_FOUND');
  successful(await first.call('browser_session', { action: 'reset' }));
  const oldPage = await first.call('browser_observe', { page_id: a.page_id });
  assert.equal(textPayload(oldPage).error.code, 'PAGE_NOT_FOUND');
  const stillB = successful(await second.call('browser_observe', { page_id: b.page_id }));
  assert.equal(stillB.browser_instance_id, b.browser_instance_id);
});
