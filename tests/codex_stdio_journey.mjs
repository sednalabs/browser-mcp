import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { fixtureServer } from './support/fixture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const codexVersion = '0.163.0';
const fakeKey = 'browser-mcp-disposable-ci-key';
const browserBinary = process.env.SEDNA_BROWSER_BINARY || path.join(root, 'target/debug/sedna-browser-mcp');
const tmpRoot = await mkdtemp(path.join(tmpdir(), 'browser-mcp-codex-consumer-'));
const codexHome = path.join(tmpRoot, 'codex-home');
const codexCwd = path.join(tmpRoot, 'workspace');
await mkdir(codexHome);
await mkdir(codexCwd);

const sse = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const responseCreated = id => ({ type: 'response.created', response: { id } });
const responseCompleted = id => ({
  type: 'response.completed',
  response: { id, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } },
});
const toolCall = (responseId, callId, args) => sse([
  responseCreated(responseId),
  { type: 'response.output_item.done', item: { type: 'function_call', call_id: callId, namespace: 'mcp__browser', name: 'browser_step', arguments: JSON.stringify(args) } },
  responseCompleted(responseId),
]);
const finalMessage = responseId => sse([
  responseCreated(responseId),
  { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `${responseId}-message`, content: [{ type: 'output_text', text: 'Browser MCP stdio journey completed.' }] } },
  responseCompleted(responseId),
]);

function receiptFrom(body, callId) {
  const call = body.input?.find(item => item.type === 'function_call_output' && item.call_id === callId);
  assert.ok(call && Array.isArray(call.output), `Missing model-facing output for ${callId}.`);
  const receipt = call.output.find(item => {
    if (item.type !== 'input_text') return false;
    try { return Boolean(JSON.parse(item.text).operation_id); } catch { return false; }
  });
  assert.ok(receipt, `Missing action receipt for ${callId}.`);
  return { items: call.output, receipt: JSON.parse(receipt.text) };
}

function assertTypedPng(items) {
  const images = items.filter(item => item.type === 'input_image');
  assert.equal(images.length, 1, 'Expected one typed screenshot in model input.');
  assert.equal(images[0].detail, 'high');
  assert.ok(/^data:image\/png;base64,/.test(images[0].image_url), 'Screenshot was not forwarded as a PNG data URL.');
  const pixels = Buffer.from(images[0].image_url.slice('data:image/png;base64,'.length), 'base64');
  assert.equal(pixels.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(pixels.length > 100, 'Screenshot did not contain real image bytes.');
}

let fixture;
let api;
let codex;
let apiFailure;
let requestCount = 0;
let initialReceipt;
let stderr = '';

try {
  const version = spawnSync('codex', ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH || '', HOME: process.env.HOME } });
  assert.equal(version.status, 0, 'The pinned Codex CLI did not start.');
  assert.match(version.stdout, new RegExp(`\\b${codexVersion.replaceAll('.', '\\.')}\\b`), `Expected Codex CLI ${codexVersion}.`);

  fixture = await fixtureServer();
  api = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.2', object: 'model', created: 0, owned_by: 'fixture' }] }));
        return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/responses');
      if (request.headers.authorization !== `Bearer ${fakeKey}`) throw new Error('Only the fixture API key may reach the local mock provider.');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      let bytes = Buffer.concat(chunks);
      const encoding = String(request.headers['content-encoding'] || '').toLowerCase();
      if (encoding === 'zstd') bytes = zstdDecompressSync(bytes);
      else if (encoding && encoding !== 'identity') throw new Error(`Unexpected request encoding: ${encoding}`);
      const body = JSON.parse(bytes.toString('utf8'));
      requestCount++;

      let stream;
      if (requestCount === 1) {
        const browser = body.tools?.find(tool => tool.type === 'namespace' && tool.name === 'mcp__browser');
        assert.deepEqual(browser?.tools?.map(tool => tool.name).sort(), ['browser_step']);
        stream = toolCall('browser-mcp-resp-1', 'browser-mcp-call-1', {
          actions: [{ type: 'navigate', url: fixture.url }], settle_ms: 100,
        });
      } else if (requestCount === 2) {
        const result = receiptFrom(body, 'browser-mcp-call-1');
        assertTypedPng(result.items);
        initialReceipt = result.receipt;
        assert.equal(initialReceipt.status, 'completed');
        assert.equal(initialReceipt.page?.url, fixture.url);
        assert.equal(typeof initialReceipt.page_id, 'string');
        assert.equal(typeof initialReceipt.browser_instance_id, 'string');
        assert.equal(typeof initialReceipt.observation_id, 'string');
        stream = toolCall('browser-mcp-resp-2', 'browser-mcp-call-2', {
          page_id: initialReceipt.page_id,
          observation_id: initialReceipt.observation_id,
          actions: [{ type: 'resize', width: 390, height: 844 }], settle_ms: 100,
        });
      } else if (requestCount === 3) {
        const result = receiptFrom(body, 'browser-mcp-call-2');
        assertTypedPng(result.items);
        const resized = result.receipt;
        assert.equal(resized.status, 'completed');
        assert.equal(resized.page?.url, fixture.url);
        assert.equal(resized.page_id, initialReceipt.page_id, 'Second call did not retain the same page.');
        assert.equal(resized.browser_instance_id, initialReceipt.browser_instance_id, 'Second call did not retain the same browser session.');
        assert.deepEqual(resized.geometry?.viewport, { width: 390, height: 844 });
        assert.deepEqual(resized.geometry?.image, { width: 390, height: 844 });
        stream = finalMessage('browser-mcp-resp-3');
      } else {
        throw new Error(`Unexpected extra Responses API request ${requestCount}.`);
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      response.end(stream);
    } catch (error) {
      apiFailure ??= new Error(`Mock-provider assertion failed: ${error.message}`);
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('Disposable Codex consumer fixture assertion failed.');
    }
  });
  await new Promise((resolve, reject) => {
    api.once('error', reject);
    api.listen(0, '127.0.0.1', resolve);
  });

  const config = [
    'model = "gpt-5.2"', 'model_provider = "browser_fixture"', 'model_context_window = 128000',
    'approval_policy = "on-request"', 'sandbox_mode = "read-only"', '',
    '[model_providers.browser_fixture]', 'name = "Disposable Browser MCP test provider"',
    `base_url = ${JSON.stringify(`http://127.0.0.1:${api.address().port}/v1`)}`,
    'env_key = "BROWSER_MCP_TEST_API_KEY"', 'wire_api = "responses"', 'requires_openai_auth = false',
    'request_max_retries = 0', 'stream_max_retries = 0', '',
    '[mcp_servers.browser]', `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(path.join(root, 'scripts/start.mjs'))}]`, 'required = true',
    'startup_timeout_sec = 20', 'tool_timeout_sec = 30', 'enabled_tools = ["browser_step"]',
    'default_tools_approval_mode = "approve"', '', '[mcp_servers.browser.env]',
    `SEDNA_BROWSER_BINARY = ${JSON.stringify(browserBinary)}`, 'SEDNA_BROWSER_NO_SANDBOX = "true"', '',
  ].join('\n');
  await writeFile(path.join(codexHome, 'config.toml'), config, { mode: 0o600 });

  codex = spawn('codex', [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--model', 'gpt-5.2',
    '--sandbox', 'read-only', '--color', 'never', '--cd', codexCwd,
    'Use only the configured browser MCP server. Open the local fixture, then set its CSS viewport to 390 by 844 pixels. Do not use shell tools or other servers.',
  ], {
    cwd: codexCwd,
    env: { PATH: process.env.PATH || '', HOME: process.env.HOME, CODEX_HOME: codexHome, BROWSER_MCP_TEST_API_KEY: fakeKey },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  codex.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
  const exit = await new Promise((resolve, reject) => {
    let hardKill;
    const softKill = setTimeout(() => {
      codex.kill('SIGTERM');
      hardKill = setTimeout(() => codex.kill('SIGKILL'), 10000);
    }, 150000);
    codex.once('error', reject);
    codex.once('close', (code, signal) => resolve({ code, signal }));
    codex.once('close', () => { clearTimeout(softKill); clearTimeout(hardKill); });
  });
  assert.equal(apiFailure, undefined, apiFailure?.message);
  assert.equal(exit.code, 0, `Codex CLI exited ${exit.code ?? exit.signal}: ${stderr.replaceAll(fakeKey, '[redacted]').slice(-1200)}`);
  assert.equal(requestCount, 3, 'Expected an initial action, a same-session viewport action, and a final response.');
  process.stdout.write('Codex 0.163.0 stdio journey passed: tool discovered, typed PNG forwarded, same page/session resized to 390x844.\n');
} finally {
  if (codex && codex.exitCode === null && codex.signalCode === null) {
    codex.kill('SIGTERM');
    await new Promise(resolve => codex.once('close', resolve));
  }
  if (api?.listening) {
    api.closeAllConnections?.();
    await new Promise(resolve => api.close(resolve));
  }
  if (fixture) await fixture.close();
  await rm(tmpRoot, { recursive: true, force: true });
}
