import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadFileGrants } from '../file-grants.mjs';

const origin = 'https://upload.example.test';
async function fixture(t) {
  const dir = await mkdtemp(path.join(process.cwd(), '.file-grant-fixture-'));
  // Trusted fixtures live beneath the checkout, never a writable shared /tmp ancestor.
  const { realpath } = await import('node:fs/promises');
  const root = await realpath(dir);
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'fixture.txt');
  await writeFile(file, 'disposable fixture bytes');
  return { root, file, entry: { path: file, allowed_origins: [origin] } };
}

function scrubbed(error, source) {
  assert.equal(error.code, 'FILE_GRANT_INVALID');
  assert.ok(!error.message.includes(source));
  assert.equal(error.cause, undefined);
  return true;
}

test('file grants deny by default and revoke all selection including clear', async t => {
  const empty = await loadFileGrants();
  assert.deepEqual(empty.describe(), []);
  assert.throws(() => empty.prepare([], 'about:blank'), { code: 'FILE_GRANT_UNAVAILABLE' });
  assert.throws(() => empty.validateHandles(['arbitrary-path']), { code: 'FILE_GRANT_UNAVAILABLE' });
  const { entry } = await fixture(t);
  const grants = await loadFileGrants([entry]);
  const [{ handle }] = grants.describe();
  grants.revoke();
  grants.revoke();
  assert.deepEqual(grants.describe(), []);
  assert.throws(() => grants.prepare([handle], origin), { code: 'FILE_GRANT_UNAVAILABLE' });
  assert.throws(() => grants.prepare([], origin), { code: 'FILE_GRANT_UNAVAILABLE' });
});

test('HTTP rejects every supplied config before parsing or file IO', async () => {
  for (const supplied of [null, [], '', 'not json', [{ path: '/never/read', allowed_origins: [origin] }]]) {
    await assert.rejects(loadFileGrants(supplied, true), { code: 'FILE_GRANT_HTTP_DENIED' });
  }
  const malicious = new Proxy([], { get() { throw new Error('must not inspect config'); } });
  await assert.rejects(loadFileGrants(malicious, true), { code: 'FILE_GRANT_HTTP_DENIED' });
  assert.deepEqual((await loadFileGrants(undefined, true)).describe(), []);
});

test('snapshots and metadata cannot be mutated by consumers or later file changes', async t => {
  const { entry, file } = await fixture(t);
  const grants = await loadFileGrants([entry]);
  const metadata = grants.describe();
  const [{ handle, name, size }] = metadata;
  assert.match(handle, /^file_[0-9a-f-]{36}$/);
  assert.equal(name, 'fixture.txt');
  assert.equal(size, 24);
  assert.ok(!JSON.stringify(metadata).includes(file));
  metadata[0].allowed_origins.push('https://evil.example');
  metadata[0].handle = 'fake';
  entry.allowed_origins.push('https://evil.example');
  assert.throws(() => grants.prepare([handle], 'https://evil.example'), { code: 'FILE_GRANT_ORIGIN_DENIED' });
  const first = grants.prepare([handle], origin)[0];
  assert.equal(first.mimeType, 'application/octet-stream');
  first.buffer.fill(0);
  await writeFile(file, 'replacement bytes');
  assert.equal(grants.prepare([handle], origin)[0].buffer.toString(), 'disposable fixture bytes');
  grants.revoke();
});

test('file grants constrain exact origins and handles before preparing any payload', async t => {
  const { entry } = await fixture(t);
  const grants = await loadFileGrants([entry]);
  const [{ handle }] = grants.describe();
  assert.deepEqual(grants.prepare([], origin), []);
  assert.throws(() => grants.prepare([], 'https://evil.example'), { code: 'FILE_GRANT_ORIGIN_DENIED' });
  for (const handles of [null, handle, [handle, handle], ['missing'], Array(5).fill(handle)]) {
    assert.throws(() => grants.prepare(handles, origin), { code: 'FILE_GRANT_UNAVAILABLE' });
  }
  for (const site of [origin + '/', origin + '/upload', 'https://sub.upload.example.test', 'http://upload.example.test', null]) {
    assert.throws(() => grants.prepare([handle], site), { code: 'FILE_GRANT_ORIGIN_DENIED' });
  }
  for (const site of ['https://*.example.test', 'https://user:pass@example.test', 'https://example.test/path', 'https://example.test/', 'file:///tmp/a', 'null', 'https://example.test?x=1']) {
    await assert.rejects(loadFileGrants([{ ...entry, allowed_origins: [site] }]), { code: 'FILE_GRANT_INVALID' });
  }
  grants.revoke();
});

test('reject malformed configuration and enforce four files and one MiB per file', async t => {
  const { entry, file } = await fixture(t);
  for (const config of [null, '[]', {}, [{ ...entry, path: 'relative' }], [{ ...entry, allowed_origins: [] }], [{ ...entry, unknown: true }], Array(5).fill(entry)]) {
    await assert.rejects(loadFileGrants(config), { code: 'FILE_GRANT_INVALID' });
  }
  await writeFile(file, Buffer.alloc(1024 * 1024, 65));
  const grants = await loadFileGrants(Array(4).fill(entry));
  assert.equal(grants.describe().reduce((total, file) => total + file.size, 0), 4 * 1024 * 1024);
  assert.equal(new Set(grants.describe().map(file => file.handle)).size, 4);
  grants.revoke();
  await writeFile(file, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(loadFileGrants([entry]), error => scrubbed(error, file));
});

test('reject final and ancestor symlinks, directories, missing files and FIFOs without path leakage', async t => {
  const { root, file, entry } = await fixture(t);
  const link = path.join(root, 'link');
  await symlink(file, link);
  const nested = path.join(root, 'nested'); await mkdir(nested);
  await writeFile(path.join(nested, 'child'), 'test');
  const linkedDir = path.join(root, 'linked-dir'); await symlink(nested, linkedDir);
  const fifo = path.join(root, 'fifo');
  const result = spawnSync('mkfifo', [fifo]); assert.equal(result.status, 0);
  for (const target of [link, path.join(linkedDir, 'child'), nested, path.join(root, 'missing'), fifo]) {
    await assert.rejects(loadFileGrants([{ ...entry, path: target }]), error => scrubbed(error, root));
  }
});

test('display names are bounded and exclude control/path-direction characters', async t => {
  const { root, entry } = await fixture(t);
  const file = path.join(root, 'a\n\\\u202e' + 'b'.repeat(110));
  await writeFile(file, 'x');
  const grants = await loadFileGrants([{ ...entry, path: file }]);
  const [{ name }] = grants.describe();
  assert.equal(name.length, 100);
  assert.ok(!/[\n\\\u202e/]/.test(name));
  grants.revoke();
});


test('reject group/other-writable ancestors and files without repairing permissions', async t => {
  const { root, entry } = await fixture(t);
  // Set a permissive mask only in a child creating disposable negative fixtures;
  // never chmod an existing source, the checkout, or a shared directory.
  const setup = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { mkdir, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    process.umask(0);
    const root = process.argv[1];
    await mkdir(path.join(root, 'writable-ancestor'), { mode: 0o777 });
    await writeFile(path.join(root, 'writable-ancestor', 'child'), 'negative fixture', { mode: 0o600 });
    await writeFile(path.join(root, 'writable-file'), 'negative fixture', { mode: 0o666 });
    await mkdir(path.join(root, 'sticky-ancestor'), { mode: 0o1777 });
    await writeFile(path.join(root, 'sticky-ancestor', 'child'), 'negative fixture', { mode: 0o600 });
  `, root]);
  assert.equal(setup.status, 0, setup.stderr?.toString());
  for (const target of [path.join(root, 'writable-ancestor', 'child'), path.join(root, 'writable-file'), path.join(root, 'sticky-ancestor', 'child')]) {
    await assert.rejects(loadFileGrants([{ ...entry, path: target }]), error => scrubbed(error, root));
  }
});
