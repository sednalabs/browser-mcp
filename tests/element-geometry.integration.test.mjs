import test from 'node:test';
import assert from 'node:assert/strict';
import { McpClient, successful, images } from './support/mcp-client.mjs';
import { fixtureServer } from './support/fixture.mjs';

test('compiled MCP advertises and returns bounded geometry beside typed pixels', { timeout: 60000 }, async t => {
  const fixture = await fixtureServer();
  const client = new McpClient();
  t.after(async () => { await client.close(); await fixture.close(); });
  const catalog = await client.request('tools/list');
  assert.equal(catalog.result.tools.find(tool => tool.name === 'browser_observe').inputSchema.properties.element_geometry.properties.selectors.maxItems, 8);
  const step = await client.call('browser_step', { actions: [{ type: 'navigate', url: fixture.url }], element_geometry: { selectors: ['main', '#menu', '#does-not-exist'] } });
  const data = successful(step);
  images(step);
  assert.equal(data.element_geometry.observation_id, data.observation_id);
  assert.equal(data.element_geometry.page_id, data.page_id);
  assert.equal(data.element_geometry.results[0].status, 'matched');
  assert.equal(data.element_geometry.results[1].elements[0].visibility, 'hidden');
  assert.equal(data.element_geometry.results[2].status, 'missing');
  const observed = successful(await client.call('browser_observe', { page_id: data.page_id, element_geometry: { selectors: ['main'], max_matches: 1 } }));
  assert.equal(observed.element_geometry.results[0].elements.length, 1);
});
