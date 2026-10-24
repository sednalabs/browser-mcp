import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, Profile } from '../config.mjs';

test('an HTTP worker refuses an inherited explicit browser profile', async()=>{
  await assert.rejects(loadConfig({SEDNA_BROWSER_HTTP_WORKER:'true',SEDNA_BROWSER_PROFILE:'/tmp/shared-browser'}), /private temporary profiles/);
});
test('an HTTP worker refuses a profile introduced by its configuration file', async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'browser-http-config-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'browser.json');
  await fs.writeFile(file,JSON.stringify({profile:path.join(directory,'shared')}),{mode:0o600});
  await assert.rejects(loadConfig({SEDNA_BROWSER_HTTP_WORKER:'true',SEDNA_BROWSER_CONFIG:file}), /private temporary profiles/);
});
test('two HTTP workers acquire distinct private profiles', async t=>{
  const config=await loadConfig({SEDNA_BROWSER_HTTP_WORKER:'true'});
  const a=new Profile(config), b=new Profile(config);
  t.after(async()=>{await a.release();await b.release();});
  const first=await a.acquire(), second=await b.acquire();
  assert.notEqual(first,second);
  assert.equal((await fs.stat(first)).mode & 0o777,0o700);
});
test('stdio retains explicit persistent-profile configuration', async()=>{
  const config=await loadConfig({SEDNA_BROWSER_PROFILE:'/tmp/operator-selected-profile'});
  assert.equal(config.profile,'/tmp/operator-selected-profile');
});
