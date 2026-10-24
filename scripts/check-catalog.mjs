#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tools } from '../worker/schemas.mjs';

const embedded = JSON.parse(await fs.readFile(new URL('../worker/tools.json', import.meta.url), 'utf8'));
assert.deepEqual(embedded, tools, 'Tool schemas changed. Run node worker/schemas.mjs before building the Rust host.');
process.stdout.write(`Tool catalog matches all ${tools.length} runtime schemas.\n`);
