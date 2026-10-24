#!/usr/bin/env node
// Run before publication. No network mutation is performed by this script.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root=fileURLToPath(new URL('..',import.meta.url));
const record={status:'running', started_at:new Date().toISOString(), platform:process.platform, architecture:process.arch, commands:[]};
const env={...process.env};
for(const name of Object.keys(env)) if(name.startsWith('SEDNA_BROWSER_')) delete env[name];
const report=path.join(root,'docs/verification-run.json');
function save() {writeFileSync(report,JSON.stringify(record,null,2)+'\n');}
function run(command,args) {
  const start=Date.now(); const child=spawnSync(command,args,{cwd:root,stdio:'inherit',env});
  record.commands.push({command:[command,...args],exit_code:child.status,elapsed_ms:Date.now()-start,error:child.error?.code});
  if(child.error || child.status!==0) {record.status='failed';record.finished_at=new Date().toISOString();save();process.exit(child.status||1);}
}
save();
run(process.execPath,[path.join(root,'scripts/prepare.mjs')]);
run('npm',['ci','--ignore-scripts','--no-audit','--no-fund']);
run('cargo',['fmt','--all']);
run('cargo',['fmt','--all','--','--check']);
run('cargo',['test','--locked','--all-targets']);
run('cargo',['test','--locked','--no-default-features','--lib']);
run('cargo',['clippy','--locked','--all-targets','--','-D','warnings']);
run(process.execPath,[path.join(root,'node_modules/playwright/cli.js'),'install','chromium']);
// Browser tests require the full HTTP build even after stdio-only unit tests.
run('cargo',['build','--locked']);
env.SEDNA_BROWSER_BINARY=path.join(root,env.CARGO_TARGET_DIR || 'target','debug',process.platform === 'win32' ? 'sedna-browser-mcp.exe' : 'sedna-browser-mcp');
run('npm',['test']);
const manifest=JSON.parse(readFileSync(path.join(root,'SOURCE_MANIFEST.json'),'utf8'));
const digest=crypto.createHash('sha256');
for(const name of manifest.files.filter(x=>x!=='docs/verification-run.json' && x!=='Cargo.lock.pending').sort()) {
  const filename=path.join(root,name);
  if(!existsSync(filename)) throw new Error('Missing source: '+name);
  digest.update(name+'\0');digest.update(readFileSync(filename));digest.update('\0');
}
record.status='passed';record.finished_at=new Date().toISOString();record.source_sha256=digest.digest('hex');save();
// Package after saving the test record, so the archive contains that exact
// evidence. package.py itself verifies archive integrity and prints its hash.
const packaged=spawnSync('python3',['scripts/package.py'],{cwd:root,stdio:'inherit',env});
if(packaged.error || packaged.status!==0) {
  record.status='failed';record.packaging_error=packaged.error?.code || `exit ${packaged.status}`;save();process.exit(1);
}
process.stderr.write('Local verification passed. This does not assert hosted CI or Codex image-perception qualification.\n');
