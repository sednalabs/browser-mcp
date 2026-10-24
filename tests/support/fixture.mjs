import http from 'node:http';

const app = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sedna browser integration fixture</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 18px system-ui; color: #142c2a; background: #eff7f5; }
  header { padding: 20px 32px; background: #123d37; color: white; }
  main { padding: 28px 32px; max-width: 960px; }
  h1 { font-size: 28px; margin: 0; }
  button, input, select { font: inherit; padding: 10px; margin: 8px; }
  button { cursor: pointer; border: 1px solid #497b71; border-radius: 7px; background: #fff; }
  label { display: block; }
  #menu { padding: 16px; background: #d1e8df; border: 2px solid #3b7c63; }
  #drag { width: 140px; height: 70px; margin: 14px 8px; background: #ebbc56; padding: 18px; touch-action: none; }
  .spacer { height: 1500px; border-left: 4px solid #aecdc4; margin: 25px; }
  footer { padding: 24px; background: #cfdfd9; }
  @media(max-width:600px) { main { padding: 14px; } header { padding: 20px 14px; } input { max-width: 280px; } }
</style>
<header><h1>Sedna Browser MCP</h1></header>
<main>
  <p>Deterministic local browser fixture. No external services.</p>
  <button id="toggle" aria-expanded="false" aria-controls="menu">Open menu</button>
  <section id="menu" hidden><button id="menu-action">Menu action</button><span>Menu stays open between calls.</span></section>
  <label for="draft">Unsaved draft</label><input id="draft" autocomplete="off" placeholder="Type without submitting">
  <button id="increment">Increment</button><output id="count" role="status">Count: 0</output>
  <button id="network">Run diagnostics</button>
  <button id="popup">Open popup</button>
  <button id="dialog">Open dialog</button>
  <label><input id="check" type="checkbox">Selected option</label>
  <label for="color">Color</label><select id="color"><option value="green">Green</option><option value="blue">Blue</option></select>
  <div id="drag" role="button" tabindex="0" aria-label="Drag pad">Drag pad</div>
  <p id="events" role="status">Ready</p>
  <div class="spacer"></div>
</main><footer><button id="footer-action">Footer action</button></footer>
<script>
  window.fixture = { count: 0, clicks: [], inputEvents: [], keyEvents: [], pointerEvents: [], loaded: Date.now(), resizeEvents: 0 };
  const byId = id => document.getElementById(id);
  const log = value => { byId('events').textContent = value; console.log('fixture:' + value); };
  byId('toggle').onclick = () => { const open = byId('menu').hidden; byId('menu').hidden = !open; byId('toggle').setAttribute('aria-expanded', String(open)); };
  byId('increment').onclick = () => { window.fixture.count++; byId('count').textContent = 'Count: ' + window.fixture.count; window.fixture.clicks.push(Date.now()); };
  byId('draft').oninput = event => window.fixture.inputEvents.push(event.target.value);
  byId('network').onclick = () => { console.error('fixture:retained-console-error'); fetch('/api/check').then(r => r.json()).then(() => log('network-complete')); };
  byId('popup').onclick = () => window.open('/?popup=1', '_blank');
  byId('dialog').onclick = () => { window.fixture.dialogResult = confirm('Fixture confirmation'); };
  document.addEventListener('keydown', e => { window.fixture.keyEvents.push({ type: e.type, key: e.key, shift: e.shiftKey }); });
  document.addEventListener('keyup', e => { window.fixture.keyEvents.push({ type: e.type, key: e.key, shift: e.shiftKey }); });
  document.addEventListener('pointerdown', e => { window.fixture.pointerEvents.push({ type: e.type, buttons: e.buttons }); });
  document.addEventListener('pointerup', e => { window.fixture.pointerEvents.push({ type: e.type, buttons: e.buttons }); });
  document.addEventListener('pointermove', e => { window.fixture.lastButtons = e.buttons; });
  addEventListener('resize', () => window.fixture.resizeEvents++);
  console.log('fixture:loaded');
</script></html>`;

export async function fixtureServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    if (req.url.startsWith('/api/check')) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(app);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    requests,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
