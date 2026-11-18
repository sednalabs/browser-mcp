// Copyright 2026 Sedna Labs. SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

export function parseManagedEndpoint(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length !== 2 || !/^\d{1,5}$/.test(lines[0])) return null;
  const port = Number(lines[0]);
  if (port < 1 || port > 65535 || !/^\/devtools\/browser\/[a-z0-9-]+$/i.test(lines[1])) return null;
  return 'ws://127.0.0.1:' + port + lines[1];
}

// Playwright readiness can precede Chromium's debugging-port file publication.
// Wait only for that file, never relaunch the browser or replay an operation.
export async function readManagedEndpoint(directory, { timeoutMs = 1500, isAlive = () => true } = {}) {
  const deadline = performance.now() + timeoutMs;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!isAlive()) throw new Error('Browser closed before managed debugging endpoint readiness.');
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) break;
    try {
      const text = await fs.readFile(path.join(directory, 'DevToolsActivePort'), {
        encoding: 'utf8', signal: AbortSignal.timeout(remaining),
      });
      if (!isAlive()) throw new Error('Browser closed before managed debugging endpoint readiness.');
      const endpoint = parseManagedEndpoint(text);
      if (endpoint) return endpoint;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.name !== 'AbortError') throw error;
    }
    const delay = Math.min(25, deadline - performance.now());
    if (delay > 0) await pause(delay);
  }
  throw new Error('Chrome did not report a valid managed debugging endpoint before the bounded readiness deadline.');
}
