#!/usr/bin/env node
// Resolve the changed dependency graph explicitly; never silently label the
// old stdio-only lockfile as a tested HTTP build.
import { existsSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
const pending=path.join(root,'Cargo.lock.pending');
if(existsSync(pending)) {
  process.stderr.write('Resolving the pending HTTP dependency graph with Cargo.\n');
  const child=spawnSync('cargo',['generate-lockfile'],{cwd:root,stdio:'inherit'});
  if(child.error || child.status!==0) {
    process.stderr.write('Dependency resolution did not complete; the pending marker has been retained.\n');
    process.exit(child.status || 1);
  }
  unlinkSync(pending);
  const inventory = path.join(root, 'SOURCE_MANIFEST.json');
  if (existsSync(inventory)) {
    const manifest = JSON.parse(readFileSync(inventory, 'utf8'));
    manifest.files = manifest.files.filter(name => name !== 'Cargo.lock.pending');
    writeFileSync(inventory, JSON.stringify(manifest, null, 2) + '\n');
  }
}
