import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../..', import.meta.url));
const suffix = process.platform === 'win32' ? '.exe' : '';
const target = path.resolve(root, process.env.CARGO_TARGET_DIR || 'target');
const binary = process.env.SEDNA_BROWSER_BINARY ||
  [path.join(target, 'debug', `sedna-browser-mcp${suffix}`), path.join(target, 'release', `sedna-browser-mcp${suffix}`)]
    .find(filename => existsSync(filename));

export class McpClient {
  constructor({ legacy = false, env = {} } = {}) {
    assert.ok(binary, 'Build the Rust host first with cargo build --locked, or set SEDNA_BROWSER_BINARY.');
    this.legacy = legacy;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.protocolErrors = [];
    this.child = spawn(binary, ['--worker', path.join(root, 'worker/main.mjs')], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', text => { this.stderr = (this.stderr + text).slice(-24000); });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch {
        const error = new Error('MCP stdout contained a non-JSON line: ' + line.slice(0, 200));
        this.protocolErrors.push(error.message);
        this.failPending(error);
        return;
      }
      if (message.id === undefined) return;
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      pending.resolve(message);
    });
    this.exited = new Promise(resolve => {
      this.child.once('exit', (code, signal) => {
        this.failPending(new Error(`MCP exited (${code ?? signal}): ${this.stderr}`));
        resolve({ code, signal });
      });
    });
    this.child.on('error', error => this.failPending(error));
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  params(params = {}) {
    if (this.legacy) return params;
    return {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'sedna-browser-integration', version: '0.1.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    };
  }

  begin(method, params = {}, timeoutMs = 120000) {
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`MCP ${method} timed out after ${timeoutMs} ms. ${this.stderr}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: this.params(params) }) + '\n');
    });
    return { id, response };
  }

  async request(method, params = {}, timeoutMs) {
    return this.begin(method, params, timeoutMs).response;
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: this.params(params) }) + '\n');
  }

  discardResponse(id) {
    // MCP permits suppressing a response after cancellation. Stop the local
    // request timer; reconciliation happens through browser_session status.
    const pending = this.pending.get(String(id));
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(String(id));
      pending.resolve({ jsonrpc: '2.0', id, cancelledByTestClient: true });
    }
  }

  async initialize() {
    assert.equal(this.legacy, true);
    const response = await this.request('initialize', {
      protocolVersion: '2025-11-25',
      clientInfo: { name: 'sedna-browser-legacy-integration', version: '0.1.0' },
      capabilities: {},
    });
    assert.ok(!response.error, JSON.stringify(response));
    assert.equal(response.result.protocolVersion, '2025-11-25');
    this.notify('notifications/initialized', {});
    return response.result;
  }

  async call(name, args = {}) {
    const response = await this.request('tools/call', { name, arguments: args });
    assert.ok(!response.error, JSON.stringify(response));
    assert.ok(Array.isArray(response.result?.content), JSON.stringify(response));
    assert.equal(response.result.structuredContent, undefined, 'Image blocks must stay in ordinary MCP content.');
    return response.result;
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    let timer;
    await Promise.race([
      this.exited,
      new Promise(resolve => { timer = setTimeout(() => { this.child.kill('SIGTERM'); resolve(); }, 12000); }),
    ]);
    clearTimeout(timer);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      let finalTimer;
      await Promise.race([
        this.exited,
        new Promise(resolve => { finalTimer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 10000); }),
      ]);
      clearTimeout(finalTimer);
    }
    this.lines.close();
    this.failPending(new Error('MCP test client closed.'));
  }
}

export function textPayload(result) {
  const block = result.content.find(item => item.type === 'text');
  assert.ok(block, 'Expected a text receipt alongside tool content.');
  try { return JSON.parse(block.text); } catch {
    throw new Error('Expected a JSON receipt, received: ' + block.text.slice(0, 1500));
  }
}

export function successful(result) {
  assert.notEqual(result.isError, true, result.content.filter(item => item.type === 'text').map(item => item.text).join('\n'));
  return textPayload(result);
}

export function images(result, count = 1) {
  const blocks = result.content.filter(item => item.type === 'image');
  assert.equal(blocks.length, count, JSON.stringify(textPayload(result)).slice(0, 2000));
  for (const block of blocks) {
    assert.ok(['image/png', 'image/jpeg'].includes(block.mimeType));
    const bytes = Buffer.from(block.data, 'base64');
    assert.ok(bytes.length > 100, 'Expected actual screenshot pixels.');
    assert.ok(bytes.length <= 4 * 1024 * 1024, 'Inline screenshot exceeds its size budget.');
    if (block.mimeType === 'image/png') {
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.ok(bytes.readUInt32BE(16) >= 320);
      assert.ok(bytes.readUInt32BE(20) >= 240);
    } else {
      assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8');
    }
  }
  return blocks;
}
