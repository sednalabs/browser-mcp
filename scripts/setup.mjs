#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = new Set(process.argv.slice(2));
const allowed = new Set(['--skip-browser']);
for (const arg of args) {
  if (!allowed.has(arg)) {
    process.stderr.write(`Unknown setup argument: ${arg}\n`);
    process.exit(2);
  }
}
function run(command, argv) {
  const child = spawnSync(command, argv, { cwd: root, stdio: 'inherit', env: process.env });
  if (child.error) {
    process.stderr.write(`${command}: ${child.error.message}\n`);
    process.exit(1);
  }
  if (child.status !== 0) process.exit(child.status || 1);
}
run(process.execPath, [path.join(root, 'scripts/prepare.mjs')]);
run('cargo', ['build', '--locked', '--release']);
if (!args.has('--skip-browser')) {
  run(process.execPath, [path.join(root, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium']);
}
process.stderr.write('Browser MCP setup complete. Use node scripts/start.mjs as your MCP stdio command.\n');
