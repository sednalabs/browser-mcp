#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const suffix = process.platform === 'win32' ? '.exe' : '';
const target = process.env.CARGO_TARGET_DIR
  ? path.resolve(root, process.env.CARGO_TARGET_DIR)
  : path.join(root, 'target');
const binary = process.env.SEDNA_BROWSER_BINARY || path.join(target, 'release', `sedna-browser-mcp${suffix}`);
if (!existsSync(binary)) {
  process.stderr.write('Browser MCP binary is missing. Run npm ci && npm run setup first.\n');
  process.exit(1);
}
const child = spawn(binary, ['--worker', path.join(root, 'worker', 'main.mjs'), ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', error => {
  process.stderr.write(`Could not start Browser MCP: ${error.message}\n`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
