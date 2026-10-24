// Copyright 2026 Sedna Labs. SPDX-License-Identifier: Apache-2.0
// Adapted and modified from Sedna/OpenAI Codex; see NOTICE and docs/provenance.md.
// Local operator configuration is read once, before accepting any browser calls.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const CONFIG_KEYS = new Set([
  "profile", "executable", "headless", "cdp", "no_sandbox", "viewport",
  "service_auth", "action_timeout_ms", "operation_timeout_ms",
]);
const FORBIDDEN_HEADERS = /^(host|cookie|set-cookie|content-length|connection|transfer-encoding|proxy-.*|sec-.*|origin|referer)$/i;

export function booleanSetting(value, fallback, name) {
  if (value === undefined) return fallback;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  throw new Error(name + " must be true or false.");
}

async function readPrivateJson(filename) {
  const resolved = path.resolve(filename);
  const stat = await fs.lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Configuration must be a regular file.");
  if (stat.size > 65536) throw new Error("Configuration exceeds 64 KiB.");
  if (process.platform !== "win32") {
    if (stat.uid !== process.getuid()) throw new Error("Configuration must belong to the current user.");
    if (stat.mode & 0o022) throw new Error("Configuration must not be writable by group or other users.");
  }
  return JSON.parse(await fs.readFile(resolved, "utf8"));
}

export function parseServiceAuth(value, env = process.env) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("service_auth must be an object.");
  for (const key of Object.keys(value)) {
    if (!["name", "allowed_origins", "headers", "env_headers"].includes(key)) throw new Error("Unknown service_auth setting: " + key);
  }
  if (!Array.isArray(value.allowed_origins) || !value.allowed_origins.length || value.allowed_origins.length > 32) {
    throw new Error("service_auth.allowed_origins requires 1 to 32 exact origins.");
  }
  const origins = new Set(value.allowed_origins.map((origin) => {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.origin !== origin) {
      throw new Error("Service origins must be exact http(s) origins, without credentials, paths or wildcards.");
    }
    return url.origin;
  }));
  const headers = {};
  for (const [source, fromEnvironment] of [[value.headers, false], [value.env_headers, true]]) {
    if (source === undefined) continue;
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Service headers must be an object.");
    for (const [rawName, configuredValue] of Object.entries(source)) {
      const name = rawName.toLowerCase();
      if (!/^[a-z0-9!#$%&'*+.^_|~-]+$/.test(name) || FORBIDDEN_HEADERS.test(name)) {
        throw new Error("Unsupported service header name.");
      }
      const headerValue = fromEnvironment ? env[configuredValue] : configuredValue;
      if (typeof headerValue !== "string" || !headerValue || /[\r\n]/.test(headerValue) || headerValue.length > 8192) {
        throw new Error("Service header value is missing or invalid.");
      }
      if (Object.hasOwn(headers, name)) throw new Error("Duplicate service header name.");
      headers[name] = headerValue;
    }
  }
  if (!Object.keys(headers).length || Object.keys(headers).length > 16) throw new Error("Configure 1 to 16 service headers.");
  return Object.freeze({ name: String(value.name || "configured-service").slice(0, 100), origins, headers: Object.freeze(headers) });
}

export async function loadConfig(env = process.env) {
  const file = env.SEDNA_BROWSER_CONFIG ? await readPrivateJson(env.SEDNA_BROWSER_CONFIG) : {};
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("Configuration must be a JSON object.");
  for (const key of Object.keys(file)) if (!CONFIG_KEYS.has(key)) throw new Error("Unknown browser setting: " + key);
  const viewport = file.viewport || { width: 1280, height: 800 };
  if (!Number.isInteger(viewport.width) || viewport.width < 320 || viewport.width > 1920 ||
      !Number.isInteger(viewport.height) || viewport.height < 240 || viewport.height > 1600) {
    throw new Error("Viewport must be 320..1920 by 240..1600 CSS pixels.");
  }
  if (booleanSetting(env.SEDNA_BROWSER_HTTP_WORKER, false, "HTTP worker") &&
      (Object.hasOwn(file, "profile") || env.SEDNA_BROWSER_PROFILE)) {
    throw new Error("HTTP browser leases require private temporary profiles; shared profile settings are forbidden.");
  }
  const profile = env.SEDNA_BROWSER_PROFILE || file.profile;
  if (profile && (!path.isAbsolute(profile) || typeof profile !== "string")) throw new Error("Profile must be an absolute path to a dedicated automation directory.");
  const actionTimeout = file.action_timeout_ms ?? 5000;
  const operationTimeout = file.operation_timeout_ms ?? 60000;
  if (!Number.isInteger(actionTimeout) || actionTimeout < 100 || actionTimeout > 5000) throw new Error("action_timeout_ms must be 100..5000.");
  if (!Number.isInteger(operationTimeout) || operationTimeout < 1000 || operationTimeout > 90000) throw new Error("operation_timeout_ms must be 1000..90000.");
  const auth = env.SEDNA_BROWSER_AUTH_FILE ? await readPrivateJson(env.SEDNA_BROWSER_AUTH_FILE) : file.service_auth;
  return Object.freeze({
    profile,
    executable: env.SEDNA_BROWSER_EXECUTABLE || file.executable,
    headless: booleanSetting(env.SEDNA_BROWSER_HEADLESS ?? file.headless, true, "headless"),
    cdp: booleanSetting(env.SEDNA_BROWSER_CDP ?? file.cdp, false, "cdp"),
    noSandbox: booleanSetting(env.SEDNA_BROWSER_NO_SANDBOX ?? file.no_sandbox, false, "no_sandbox"),
    viewport: { width: viewport.width, height: viewport.height },
    actionTimeout,
    operationTimeout,
    serviceAuth: parseServiceAuth(auth, env),
  });
}

export function redact(value, auth) {
  let text = String(value);
  for (const secret of Object.values(auth?.headers || {})) text = text.split(secret).join("[redacted]");
  // URL credentials are never useful in observations or diagnostic history.
  return text.replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/gi, "$1[redacted]@");
}

export class Profile {
  constructor(config) { this.config = config; this.directory = null; this.lock = null; this.temporary = !config.profile; }
  async acquire() {
    if (this.directory) return this.directory;
    const directory = this.temporary
      ? await fs.mkdtemp(path.join(os.tmpdir(), "sedna-browser-"))
      : path.resolve(this.config.profile);
    if (!this.temporary) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) {
      throw new Error("Profile must be a real directory without symlink components.");
    }
    if (process.platform !== "win32" && (stat.uid !== process.getuid() || (stat.mode & 0o077))) {
      throw new Error("Profile must be owned by the current user with mode 0700.");
    }
    const marker = path.join(directory, ".sedna-browser-profile.json");
    const entries = await fs.readdir(directory);
    if (!this.temporary && entries.length && !entries.includes(".sedna-browser-profile.json")) {
      throw new Error("Existing directory is not a Sedna automation profile. Choose a new empty directory; normal browser profiles are not accepted.");
    }
    if (entries.includes(".sedna-browser-profile.json")) {
      const markerStat = await fs.lstat(marker);
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error("Invalid automation profile marker.");
      const data = JSON.parse(await fs.readFile(marker, "utf8"));
      if (data.product !== "sedna-browser-mcp") throw new Error("Invalid automation profile marker.");
    }
    const lock = path.join(directory, ".sedna-browser-mcp.lock");
    try {
      await fs.mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("Profile is already locked by a browser provider. Locks are never stolen automatically.");
      throw error;
    }
    this.directory = directory;
    this.lock = lock;
    try {
      await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, nonce: randomUUID(), started_at: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
      if (!entries.includes(".sedna-browser-profile.json")) {
        await fs.writeFile(marker, JSON.stringify({ product: "sedna-browser-mcp", version: 1 }), { mode: 0o600, flag: "wx" });
      }
    } catch (error) { await this.release(); throw error; }
    return directory;
  }
  async release() {
    const directory = this.directory;
    const lock = this.lock;
    this.directory = null;
    this.lock = null;
    if (lock) await fs.rm(lock, { recursive: true, force: true });
    if (directory && this.temporary) await fs.rm(directory, { recursive: true, force: true });
  }
}

// Credentials are used only by route.fetch for one request. They are never
// installed as browser/context headers and never inherited by a redirect.
export async function installServiceAuth(context, auth, onError = () => {}) {
  if (!auth) return;
  await context.route("**/*", async (route) => {
    try {
      const request = route.request();
      const headers = { ...request.headers() };
      for (const name of Object.keys(auth.headers)) delete headers[name];
      if (!auth.origins.has(new URL(request.url()).origin)) {
        await route.continue({ headers });
        return;
      }
      const response = await route.fetch({
        headers: { ...headers, ...auth.headers },
        maxRedirects: 0,
        maxRetries: 0,
        timeout: 5000,
      });
      const size = Number(response.headers()["content-length"] || 0);
      if (size > 16 * 1024 * 1024) {
        await response.dispose();
        await route.abort("failed");
        onError("Service-auth response exceeded the 16 MiB declared-body limit.");
        return;
      }
      await route.fulfill({ response });
      await response.dispose();
    } catch (error) {
      onError("Service-auth request failed: " + redact(error.message, auth));
      await route.abort("failed").catch(() => {});
    }
  });
}
