#!/usr/bin/env node
// Create exactly one new PUBLIC repository and its first PR using an already
// authenticated GitHub CLI. Never changes an existing repository or merges a PR.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const repository='sednalabs/browser-mcp';
const branch='feat/initial-browser-mcp-http';
if(process.argv.length>2) throw new Error('This script accepts no arguments; its target is sednalabs/browser-mcp.');
function command(binary,args,{cwd=root,capture=false,allowFailure=false}={}) {
  const result=spawnSync(binary,args,{cwd,encoding:'utf8',stdio:capture?'pipe':'inherit'});
  if(result.error) throw result.error;
  if(result.status!==0 && !allowFailure) throw new Error(`${binary} failed with exit ${result.status}; no automatic retry.`);
  return result;
}
command('gh',['auth','status']);
// Missing repository is the expected precondition; distinguish it from other
// errors rather than using a failed lookup as permission to overwrite anything.
const probe=command('gh',['api',`repos/${repository}`],{capture:true,allowFailure:true});
if(probe.status===0) throw new Error('Target repository already exists. Refusing to overwrite or reinterpret its history.');
if(!/404|Not Found/i.test((probe.stderr||'')+(probe.stdout||''))) throw new Error('Could not verify that the target repository is absent.');
command(process.execPath,[path.join(root,'scripts/verify.mjs')]);
const evidence=JSON.parse(fs.readFileSync(path.join(root,'docs/verification-run.json'),'utf8'));
if(evidence.status!=='passed' || fs.existsSync(path.join(root,'Cargo.lock.pending'))) throw new Error('Publication requires a complete successful verification run and resolved lockfile.');
// Preparation removes the pending marker from the source inventory before
// verification, so the published tree and its recorded digest remain identical.
const account=JSON.parse(command('gh',['api','user'],{capture:true}).stdout);
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'browser-mcp-publish-'));
// Only the explicit source inventory can be published. No arbitrary new JSON
// files, operator config, working profile or dependency directory is copied.
const manifest=JSON.parse(fs.readFileSync(path.join(root,'SOURCE_MANIFEST.json'),'utf8'));
for(const name of manifest.files) {
  if(name==='Cargo.lock.pending' && !fs.existsSync(path.join(root,name))) continue;
  if(path.isAbsolute(name) || name.split('/').some(p=>p==='..' || p==='.git')) throw new Error('Unsafe source path');
  const source=path.join(root,name);
  if(!fs.lstatSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) throw new Error('Only regular source files may be published: '+name);
}
command('git',['init','-b','main'],{cwd:directory});
command('git',['config','user.name',account.name||account.login],{cwd:directory});
command('git',['config','user.email',`${account.id}+${account.login}@users.noreply.github.com`],{cwd:directory});
for(const name of ['LICENSE','NOTICE','.gitignore']) fs.copyFileSync(path.join(root,name),path.join(directory,name));
fs.writeFileSync(path.join(directory,'README.md'),'# Sedna Browser MCP\n\nPersistent visual browser control over MCP. The initial implementation is proposed in PR #1.\n\nApache-2.0; see LICENSE and NOTICE. No release has been published.\n');
command('git',['add','.'],{cwd:directory});command('git',['commit','-m','Initialize Browser MCP repository and licensing'],{cwd:directory});
command('git',['switch','-c',branch],{cwd:directory});
for(const name of manifest.files) {
  if(name==='Cargo.lock.pending') continue;
  const destination=path.join(directory,name);fs.mkdirSync(path.dirname(destination),{recursive:true});
  fs.copyFileSync(path.join(root,name),destination);
  if(name.startsWith('scripts/')) fs.chmodSync(destination,0o755);
}
command('git',['add','.'],{cwd:directory});command('git',['commit','-m','Implement visual browser MCP with authenticated Streamable HTTP and HTTPS'],{cwd:directory});
command('gh',['repo','create',repository,'--public','--description','Persistent visual browser MCP with typed screenshots, scoped browser leases and Streamable HTTP/HTTPS','--disable-wiki','--source',directory,'--remote','origin'],{cwd:directory});
command('git',['push','-u','origin','main'],{cwd:directory});command('git',['push','-u','origin',branch],{cwd:directory});
const body=fs.readFileSync(path.join(directory,'PULL_REQUEST.md'),'utf8')+'\n\n## Local pre-publication verification\n\n`node scripts/verify.mjs` passed at '+evidence.finished_at+'. See `docs/verification-run.json` for commands and source digest. Hosted checks remain separate.\n';
const bodyFile=path.join(directory,'.git/pr-body.md');fs.writeFileSync(bodyFile,body);
const pr=command('gh',['pr','create','--repo',repository,'--base','main','--head',branch,'--title','Initial Browser MCP with authenticated Streamable HTTP/HTTPS','--body-file',bodyFile,'--draft'],{cwd:directory,capture:true}).stdout.trim();
console.log(JSON.stringify({repository,public:true,pull_request:pr,checkout:directory},null,2));
if(!/\/pull\/1$/.test(pr)) throw new Error('PR was created, but its number is not 1. Inspect the returned URL; nothing was deleted or renumbered.');
