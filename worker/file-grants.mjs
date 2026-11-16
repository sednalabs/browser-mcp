// Copyright 2026 Sedna Labs. SPDX-License-Identifier: Apache-2.0
import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Rejected } from './operation.mjs';

const MAX_FILES = 4;
const MAX_BYTES = 1024 * 1024;
const reject = (message, code = 'FILE_GRANT_INVALID') => new Rejected(message, code);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
  a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.isFile() && b.isFile();

function exactOrigin(value) {
  if (typeof value !== 'string') throw reject('File grant origins must be exact HTTP(S) origins.');
  let url;
  try { url = new URL(value); } catch { throw reject('File grant origins must be exact HTTP(S) origins.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      value.includes('*') || value !== url.origin) {
    throw reject('File grant origins must be exact HTTP(S) origins.');
  }
  return url.origin;
}

function trusted(stat, euid, directory = false) {
  if ((stat.uid !== euid && stat.uid !== 0n) || (stat.mode & 0o022n) !== 0n ||
      stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) {
    throw reject('File grants require trusted owners and non-writable-to-others source paths.');
  }
}

async function trustedPath(filePath, euid) {
  // These are observed path checks, not an atomic openat traversal. Restricting
  // every directory owner/mode excludes other-UID ancestor replacement. Root
  // and same-euid mutation are outside this trusted-source boundary.
  let directory = path.parse(filePath).root;
  trusted(await lstat(directory, { bigint: true }), euid, true);
  const parts = filePath.slice(directory.length).split(path.sep);
  for (const component of parts.slice(0, -1)) {
    directory = path.join(directory, component);
    trusted(await lstat(directory, { bigint: true }), euid, true);
  }
  const file = await lstat(filePath, { bigint: true });
  trusted(file, euid);
  return file;
}

export async function verifyTrustedGrantConfig(filename) {
  try {
    if (process.platform === 'win32' || typeof process.geteuid !== 'function') throw new Error('unsupported');
    const resolved = path.resolve(filename);
    if (await realpath(resolved) !== resolved) throw new Error('symlink');
    await trustedPath(resolved, BigInt(process.geteuid()));
  } catch {
    throw reject('File grant configuration must use a trusted, non-group/other-writable source path without symbolic links.');
  }
}

async function snapshot(filePath) {
  let fd;
  let scratch;
  try {
    if (await realpath(filePath) !== filePath) throw reject('File grant must not traverse symbolic links.');
    const euid = BigInt(process.geteuid());
    const before = await trustedPath(filePath, euid);
    if (!before.isFile() || before.size > BigInt(MAX_BYTES)) throw reject('File grant must be a regular file of at most 1 MiB.');
    fd = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await fd.stat({ bigint: true });
    trusted(opened, euid);
    if (!same(before, opened)) throw reject('File grant changed while being opened.');
    scratch = Buffer.alloc(MAX_BYTES + 1);
    let count = 0;
    while (count < scratch.length) {
      const { bytesRead } = await fd.read(scratch, count, scratch.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await fd.stat({ bigint: true });
    trusted(after, euid);
    const pathAfter = await trustedPath(filePath, euid);
    if (count > MAX_BYTES || BigInt(count) !== opened.size || !same(opened, after) ||
        !same(after, pathAfter) || await realpath(filePath) !== filePath) {
      throw reject('File grant changed while being read or exceeded its size limit.');
    }
    return Buffer.from(scratch.subarray(0, count));
  } catch {
    // OS exceptions include source paths; never expose them or attach a cause.
    throw reject('Unable to safely snapshot a file grant. Use an unchanged regular file at most 1 MiB, with no symbolic links; every source ancestor and the file must be owned by the effective user or root and not group/other-writable.');
  } finally {
    scratch?.fill(0);
    await fd?.close().catch(() => {});
  }
}

class FileGrants {
  #grants = new Map();
  constructor(grants) { for (const grant of grants) this.#grants.set(grant.handle, grant); }
  describe() {
    return [...this.#grants.values()].map(({ handle, name, buffer, origins }) => ({
      handle, name, size: buffer.length, allowed_origins: [...origins],
    }));
  }
  validateHandles(handles) {
    if (!this.#grants.size || !Array.isArray(handles) || handles.length > MAX_FILES || new Set(handles).size !== handles.length ||
        handles.some(handle => typeof handle !== 'string' || !this.#grants.has(handle))) {
      throw reject('Select at most four unique, currently available file grant handles.', 'FILE_GRANT_UNAVAILABLE');
    }
  }
  prepare(handles, origin) {
    this.validateHandles(handles);
    if (!handles.length) {
      if (![...this.#grants.values()].some(grant => grant.origins.includes(origin))) {
        throw reject('File selection is not permitted for this page origin.', 'FILE_GRANT_ORIGIN_DENIED');
      }
      return [];
    }
    // Validate all destinations before copying any bytes.
    if (handles.some(handle => !this.#grants.get(handle).origins.includes(origin))) {
      throw reject('File selection is not permitted for this page origin.', 'FILE_GRANT_ORIGIN_DENIED');
    }
    return handles.map(handle => {
      const { name, buffer } = this.#grants.get(handle);
      return { name, mimeType: 'application/octet-stream', buffer: Buffer.from(buffer) };
    });
  }
  revoke() {
    for (const grant of this.#grants.values()) grant.buffer.fill(0);
    this.#grants.clear();
  }
}

export async function loadFileGrants(value, httpWorker = false) {
  if (value === undefined) return new FileGrants([]);
  if (httpWorker) throw reject('File grants are not supported for HTTP workers.', 'FILE_GRANT_HTTP_DENIED');
  if (process.platform === 'win32' || typeof process.geteuid !== 'function' || !constants.O_NOFOLLOW || !constants.O_NONBLOCK) {
    throw reject('This platform cannot enforce safe file grant opening.');
  }
  const entries = value;
  if (!Array.isArray(entries) || entries.length > MAX_FILES) throw reject('Configure at most four file grants.');
  const parsed = entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).some(key => !['path', 'allowed_origins'].includes(key)) ||
        typeof entry.path !== 'string' || !path.isAbsolute(entry.path) || entry.path.includes('\0') ||
        !Array.isArray(entry.allowed_origins) || !entry.allowed_origins.length || entry.allowed_origins.length > 8) {
      throw reject('Each file grant requires an absolute file path and one to eight exact origins.');
    }
    const filePath = path.normalize(entry.path);
    const origins = [...new Set(entry.allowed_origins.map(exactOrigin))];
    const name = path.basename(filePath).replace(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069/\\]/g, '_').slice(0, 100) || 'file';
    return { filePath, origins, name };
  });
  const grants = [];
  try {
    for (const entry of parsed) {
      const buffer = await snapshot(entry.filePath);
      grants.push({ handle: 'file_' + randomUUID(), name: entry.name, origins: entry.origins, buffer });
    }
    return new FileGrants(grants);
  } catch (error) {
    for (const grant of grants) grant.buffer.fill(0);
    throw error;
  }
}
