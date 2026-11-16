import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { tools } from '../schemas.mjs';
import { BrowserRuntime } from '../runtime.mjs';
import { loadConfig } from '../config.mjs';

const schema = tools.find(tool => tool.name === 'browser_tabs').inputSchema;
const validate = new Ajv({ strict: false }).compile(schema);

test('tab catalogue exposes four complete discriminated object variants', () => {
  assert.equal(schema.type, 'object');
  assert.equal(schema.allOf, undefined);
  assert.deepEqual(schema.oneOf.map(branch => branch.properties.action.const), ['list', 'new', 'select', 'close']);
  for (const branch of schema.oneOf) {
    assert.equal(branch.type, 'object');
    assert.equal(branch.additionalProperties, false);
    assert.ok(branch.required.includes('action'));
  }
  assert.deepEqual(schema.oneOf[2].required, ['action', 'page_id']);
  assert.deepEqual(schema.oneOf[3].required, ['action', 'page_id']);
});

test('tab variants preserve accepted actions and reject unrelated or out-of-bounds fields', () => {
  for (const args of [{action:'list'}, {action:'new'}, {action:'new',url:'about:blank'}, {action:'new',url:'x'.repeat(8000)}, {action:'select',page_id:'x'.repeat(100)}, {action:'close',page_id:'session:p1'}]) {
    assert.equal(validate(args), true, JSON.stringify(validate.errors));
  }
  for (const args of [null, [], {}, {action:'other'}, {action:'select'}, {action:'close'}, {action:'list',url:'x'}, {action:'list',page_id:'p1'}, {action:'new',page_id:'p1'}, {action:'select',page_id:'p1',url:'x'}, {action:'close',page_id:'p1',url:'x'}, {action:'new',url:''}, {action:'new',url:'x'.repeat(8001)}, {action:'close',page_id:''}, {action:'select',page_id:'x'.repeat(101)}, {action:'list',extra:true}]) {
    assert.equal(validate(args), false, JSON.stringify(args));
  }
});

test('invalid tab requests reject before browser startup; stale page IDs still fail', async t => {
  const runtime = new BrowserRuntime(await loadConfig({}));
  t.after(() => runtime.dispose());
  let id = 1;
  for (const args of [{action:'new',page_id:'p1'}, {action:'select'}, {action:'close'}, {action:'list',url:'about:blank'}]) {
    const result = JSON.parse((await runtime.call(id++, 'browser_tabs', args)).content[0].text);
    assert.equal(result.status, 'rejected');
    assert.equal(runtime.status().running, false);
    assert.equal(runtime.status().profile_reserved, false);
  }
  for (const action of ['select', 'close']) {
    const result = JSON.parse((await runtime.call(id++, 'browser_tabs', {action,page_id:'old-session:p1'})).content[0].text);
    assert.equal(result.error.code, 'PAGE_NOT_FOUND');
    assert.equal(runtime.status().running, false);
  }
});
