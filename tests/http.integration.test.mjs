// Real Rust HTTP host + local OIDC/JWKS issuer + real Chromium. No public service
// or credential is required. These tests intentionally fail when not built.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { root, successful, textPayload, images } from './support/mcp-client.mjs';
import { fixtureServer } from './support/fixture.mjs';

function run(command, args, timeout=20000) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:['ignore','pipe','pipe']}); let stdout='',stderr='';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data',s=>{stdout=(stdout+s).slice(-1024*1024);}); child.stderr.on('data',s=>{stderr=(stderr+s).slice(-16000);});
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(command+' timed out'));},timeout);
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('exit',status=>{clearTimeout(timer);resolve({status,stdout,stderr});});
  });
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function reservePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
async function issuerFixture() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
  let issuer;
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/jwks') { res.end(JSON.stringify({ keys: [jwk] })); return; }
    if (req.url === '/.well-known/openid-configuration' || req.url === '/.well-known/oauth-authorization-server') {
      res.end(JSON.stringify({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks', code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code','refresh_token'] }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${server.address().port}`;
  return {
    issuer,
    token(subject, audience, extra = {}) {
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ typ:'at+jwt', alg:'RS256', kid:'fixture-key' })).toString('base64url');
      const claims = Buffer.from(JSON.stringify({ iss:issuer, aud:audience, sub:subject, azp:'browser-http-tests', scope:'browser:use', iat:now, nbf:now-5, exp:now+300, jti:crypto.randomUUID(), ...extra })).toString('base64url');
      const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), privateKey).toString('base64url');
      return `${header}.${claims}.${signature}`;
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
async function startHost(t, { limits = {}, tls = false } = {}) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const target = path.resolve(root, process.env.CARGO_TARGET_DIR || 'target');
  const binary = process.env.SEDNA_BROWSER_BINARY || [path.join(target, 'debug', `sedna-browser-mcp${suffix}`), path.join(target, 'release', `sedna-browser-mcp${suffix}`)].find(existsSync);
  assert.ok(binary, 'Build the Rust host with HTTP enabled before running HTTP tests.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-http-test-'));
  const issuer = await issuerFixture();
  const port = await reservePort();
  const base = `${tls ? 'https' : 'http'}://127.0.0.1:${port}`;
  const browserConfig = path.join(directory, 'browser.json');
  await fs.writeFile(browserConfig, JSON.stringify({ headless:true, no_sandbox:process.getuid?.() === 0 || process.env.SEDNA_BROWSER_NO_SANDBOX === 'true', ...(process.env.SEDNA_BROWSER_EXECUTABLE ? { executable:process.env.SEDNA_BROWSER_EXECUTABLE } : {}) }), { mode:0o600 });
  const config = {
    bind:`127.0.0.1:${port}`, resource_url:base+'/mcp', allowed_hosts:[`127.0.0.1:${port}`, `localhost:${port}`],
    allowed_origins:[base], allow_loopback_http:true, browser_config:browserConfig,
    auth:{issuer:issuer.issuer, allowed_client_ids:['browser-http-tests'], required_scopes:['browser:use']}, limits,
  };
  let ca;
  if (tls) {
    const cert = path.join(directory, 'cert.pem'); const key = path.join(directory, 'key.pem');
    const result = spawnSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'], { stdio:'pipe' });
    assert.equal(result.status, 0, 'OpenSSL is required for the real TLS test.');
    await fs.chmod(key, 0o600); ca = cert; config.tls = { certificate:cert, private_key:key };
  }
  const configPath = path.join(directory, 'http.json');
  await fs.writeFile(configPath, JSON.stringify(config), { mode:0o600 });
  const child = spawn(binary, ['--transport','http','--http-config',configPath,'--worker',path.join(root,'worker/main.mjs')], { stdio:['ignore','pipe','pipe'] });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', s => { stderr = (stderr+s).slice(-32000); });
  const exited = new Promise(resolve => { child.once('error', resolve); child.once('exit', resolve); });
  t.after(async () => {
    child.kill('SIGTERM');
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},85000); })]);
    clearTimeout(timer); await issuer.close(); await fs.rm(directory,{recursive:true,force:true});
  });
  if (!tls) {
    let ready = false;
    for (let n=0; n<150; n++) {
      if (child.exitCode !== null) break;
      try { ready = (await fetch(base+'/healthz')).status === 204; } catch {}
      if (ready) break; await pause(100);
    }
    assert.equal(ready,true,stderr);
  } else {
    // curl explicitly trusts this fixture's CA; do not disable TLS validation.
    let ready = false;
    for(let n=0;n<150;n++) {
      const status = await run('curl',['--silent','--fail','--cacert',ca,base+'/healthz']);
      if(status.status === 0) {ready=true;break;}
      if(child.exitCode !== null) break; await pause(100);
    }
    assert.ok(ready,stderr);
  }
  let nextId=0;
  async function request(subject, method, params={}, options={}) {
    const legacy = options.legacy ?? false;
    const headers = { accept:'application/json, text/event-stream','content-type':'application/json' };
    if (subject !== null) headers.authorization = 'Bearer '+issuer.token(subject, options.audience || base+'/mcp', options.claims || {});
    if (!legacy) { headers['mcp-protocol-version']='2026-07-28'; headers['mcp-method']=method; }
    if(options.session) headers['mcp-session-id']=options.session;
    Object.assign(headers,options.headers || {});
    const body = {jsonrpc:'2.0', ...(options.notification ? {} : {id:++nextId}), method, params:legacy?params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'browser-http-tests',version:'0.1.0'},'io.modelcontextprotocol/clientCapabilities':{}}}};
    const response = await fetch(base+'/mcp', { method:'POST',headers,body:JSON.stringify(body),signal:options.signal });
    const text = await response.text();
    let value = null;
    if(text.trim()) {
      if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
        const messages = text.split(/\r?\n\r?\n/).flatMap(frame => { const data=frame.split(/\r?\n/).filter(s=>s.startsWith('data:')).map(s=>s.slice(5).trimStart()).join('\n'); try{return data?[JSON.parse(data)]:[];}catch{return [];} });
        value = messages.find(message=>message.id===body.id) || messages.at(-1);
      } else { try {value=JSON.parse(text);}catch {value=text;} }
    }
    return { status:response.status, headers:response.headers, value };
  }
  async function call(subject, name, args={}, options={}) {
    const response=await request(subject,'tools/call',{name,arguments:args},options);
    assert.equal(response.status,200,JSON.stringify(response.value));
    assert.ok(!response.value?.error,JSON.stringify(response.value));
    assert.ok(Array.isArray(response.value?.result?.content),JSON.stringify(response.value));
    return response.value.result;
  }
  async function create(subject='alice') { return successful(await call(subject,'browser_session',{action:'create'})).browser_session.browser_session_id; }
  return { base, issuer, child, configPath, request, call, create, ca, get stderr(){return stderr;} };
}

test('HTTP authenticates, isolates leases, and preserves real browser state across independent requests', {timeout:180000}, async t=>{
  const host=await startHost(t); const fixture=await fixtureServer(); t.after(()=>fixture.close());
  await t.test('rejects absent auth, wrong audience, missing scope and hostile Origin',async()=>{
    assert.equal((await host.request(null,'tools/list')).status,401);
    assert.equal((await host.request('alice','tools/list',{}, {audience:'https://other.invalid/mcp'})).status,401);
    assert.ok([401,403].includes((await host.request('alice','tools/list',{}, {claims:{scope:'other:scope'}})).status));
    assert.ok([400,403].includes((await host.request('alice','tools/list',{}, {headers:{origin:'https://hostile.invalid'}})).status));
  });
  let id, observation;
  await t.test('requires explicit handles and returns real inline PNG blocks',async()=>{
    const absent=await host.call('alice','browser_observe'); assert.equal(absent.isError,true);
    id=await host.create();
    const reply=await host.call('alice','browser_step',{browser_session_id:id,actions:[{type:'navigate',url:fixture.url}]},{headers:{connection:'close'}});
    observation=successful(reply); images(reply);
    assert.equal(observation.browser_session_id,id);
    assert.equal(reply.structuredContent,undefined);
    assert.deepEqual(observation.geometry.image,{width:1280,height:800});
  });
  await t.test('keeps menu, focus and browser identity with a freshly issued token on every call',async()=>{
    const first=successful(await host.call('alice','browser_step',{browser_session_id:id,actions:[{type:'click',target:{css:'#toggle'}},{type:'fill',target:{css:'#draft'},text:'Unsubmitted draft'},{type:'focus',target:{css:'#draft'}}]}));
    const next=successful(await host.call('alice','browser_observe',{browser_session_id:id}));
    assert.equal(first.browser_instance_id,next.browser_instance_id);
    assert.ok(next.page.controls.some(c=>c.name==='Menu action'));
    assert.ok(next.page.controls.some(c=>c.focused&&c.name==='Unsaved draft'));
  });
  await t.test('cannot inspect or close another owner’s lease',async()=>{
    const response=await host.call('bob','browser_observe',{browser_session_id:id}); assert.equal(response.isError,true);
    assert.equal((await host.call('bob','browser_session',{action:'close',browser_session_id:id})).isError,true);
    assert.equal(successful(await host.call('bob','browser_session',{action:'list'})).browser_sessions.length,0);
    assert.equal(successful(await host.call('alice','browser_observe',{browser_session_id:id})).browser_instance_id,observation.browser_instance_id);
  });
  await t.test('does not default two same-owner leases onto one browser',async()=>{
    const second=await host.create(); const next=successful(await host.call('alice','browser_observe',{browser_session_id:second}));
    assert.notEqual(next.browser_instance_id,observation.browser_instance_id); assert.equal(next.page.url,'about:blank');
    await host.call('alice','browser_session',{action:'close',browser_session_id:second});
  });
  await t.test('retains diagnostics between requests and marks responses non-cacheable',async()=>{
    await host.call('alice','browser_step',{browser_session_id:id,actions:[{type:'click',target:{css:'#network'}}],settle_ms:300});
    const response=await host.request('alice','tools/call',{name:'browser_inspect',arguments:{browser_session_id:id}});
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    const data=successful(response.value.result); assert.ok(data.events.some(event=>JSON.stringify(event).includes('retained-console-error')));
  });
  await t.test('aborting an HTTP stream cancels the operation without destroying its browser lease',async()=>{
    const marker='/?http-cancel-marker=1'; const abort=new AbortController();
    const pending=host.request('alice','tools/call',{name:'browser_step',arguments:{browser_session_id:id,actions:[{type:'navigate',url:fixture.url+marker.slice(1)},{type:'wait_for',target:{css:'#not-present'},timeout_ms:5000}]}},{signal:abort.signal}).then(()=>({completed:true}),error=>({error}));
    let sent=false;
    for(let n=0;n<80;n++) {if(fixture.requests.some(r=>r.url===marker)) {sent=true;break;} await pause(50);}
    assert.ok(sent,'Navigation must be observed before cancellation is sent.');
    abort.abort(); await pending;
    const status=successful(await host.call('alice','browser_session',{action:'status',browser_session_id:id}));
    assert.equal(status.last_operation.status,'cancelled');
    images(await host.call('alice','browser_observe',{browser_session_id:id}));
    assert.equal(fixture.requests.filter(r=>r.url===marker).length,1,'The cancelled navigation must not be replayed.');
  });
  await t.test('legacy transport custody rejects reuse by a different authenticated owner',async()=>{
    const initialized=await host.request('alice','initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'legacy-test',version:'0.1.0'}},{legacy:true});
    assert.equal(initialized.status,200); const session=initialized.headers.get('mcp-session-id'); assert.ok(session);
    await host.request('alice','notifications/initialized',{}, {legacy:true,session,notification:true});
    assert.equal((await host.request('alice','tools/list',{}, {legacy:true,session})).status,200);
    assert.equal((await host.request('bob','tools/list',{}, {legacy:true,session})).status,404);
    // A current request must not be forced through old session lookup.
    assert.equal((await host.request('alice','tools/list',{}, {session:'stale-legacy-id'})).status,200);
  });
});

test('HTTP quota and close are explicit and never evict an owned browser', {timeout:120000}, async t=>{
  const host=await startHost(t,{limits:{max_browsers:1,max_browsers_per_owner:1}});
  const id=await host.create(); assert.equal((await host.call('alice','browser_session',{action:'create'})).isError,true);
  successful(await host.call('alice','browser_session',{action:'close',browser_session_id:id}));
  const replacement=await host.create(); assert.notEqual(replacement,id);
  assert.equal((await host.call('alice','browser_observe',{browser_session_id:id})).isError,true);
});

test('native HTTPS rejects untrusted certificates and serves with explicit fixture CA trust', {timeout:120000}, async t=>{
  const host=await startHost(t,{tls:true});
  const untrusted=await run('curl',['--silent','--fail',host.base+'/healthz']); assert.notEqual(untrusted.status,0);
  const token=host.issuer.token('alice',host.base+'/mcp');
  const body={jsonrpc:'2.0',id:1,method:'tools/list',params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'tls-test',version:'0.1'},'io.modelcontextprotocol/clientCapabilities':{}}}};
  const response=await run('curl',['--silent','--fail','--cacert',host.ca,'-H','content-type: application/json','-H','accept: application/json, text/event-stream','-H','mcp-protocol-version: 2026-07-28','-H','mcp-method: tools/list','-H',`authorization: Bearer ${token}`,'--data-binary',JSON.stringify(body),host.base+'/mcp']);
  assert.equal(response.status,0,response.stderr); assert.match(response.stdout,/browser_observe/);
  assert.ok(!host.stderr.includes(token));
});
