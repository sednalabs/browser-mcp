// Copyright 2026 Sedna Labs. SPDX-License-Identifier: Apache-2.0
// Adapted and modified from Sedna/OpenAI Codex; see NOTICE and docs/provenance.md.
import { redact } from "./config.mjs";

const URL_IN_TEXT = /\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+|\/[^\s<>"']+/gi;

function withoutQueryAndFragment(value) {
  const text = String(value);
  const suffix = text.search(/[?#]/);
  return suffix === -1 ? text : text.slice(0, suffix);
}

function redactUrlsInText(value, auth) {
  return redact(value, auth).replace(URL_IN_TEXT, (url) => {
    const trailing = url.match(/[),.;!?]+$/)?.[0] || "";
    const candidate = trailing ? url.slice(0, -trailing.length) : url;
    return withoutQueryAndFragment(candidate) + trailing;
  }).replace(/([?&][^=&#\s"'<>]+)=([^&#\s"'<>]*)(?:#[^\s"'<>]*)?/g, "$1=[redacted]");
}

function originOf(value) {
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch { return null; }
}

function isMainFrameNavigation(request, page) {
  try { return request.isNavigationRequest() && request.frame() === page.mainFrame(); }
  catch { return false; }
}

export class Diagnostics {
  constructor(page, auth) {
    this.page = page;
    this.auth = auth;
    this.startedAt = new Date().toISOString();
    this.seq = 0;
    this.dropped = 0;
    this.currentNavigationSeq = null;
    this.events = [];
    this.requests = new WeakMap();
    this.listeners = [];
    this.on("console", (message) => this.push({
      kind: "console", level: message.type(), text: message.text(),
      location: { url: message.location().url || "", line: message.location().lineNumber },
    }));
    this.on("pageerror", (error) => this.push({ kind: "console", level: "error", text: error.message }));
    this.on("request", (request) => {
      const mainNavigation = isMainFrameNavigation(request, this.page);
      let navigationSeq = this.currentNavigationSeq;
      if (mainNavigation) {
        let redirectedFrom = null;
        try { redirectedFrom = request.redirectedFrom(); } catch {}
        navigationSeq = this.requests.get(redirectedFrom)?.event.navigation_seq ?? this.seq + 1;
      }
      const event = this.push({
        kind: "network", method: request.method(), url: request.url(),
        resource_type: request.resourceType(), status: null, state: "pending", navigation_seq: navigationSeq,
      });
      if (mainNavigation) this.currentNavigationSeq = navigationSeq;
      this.requests.set(request, { event, started: Date.now() });
    });
    this.on("response", (response) => {
      const entry = this.requests.get(response.request());
      if (entry) { entry.event.status = response.status(); entry.event.state = "response_received"; }
    });
    this.on("requestfinished", (request) => this.finishRequest(request, "finished"));
    this.on("requestfailed", (request) => this.finishRequest(request, "failed"));
  }
  on(name, listener) { this.page.on(name, listener); this.listeners.push([name, listener]); }
  push(event) {
    const sanitized = { ...event };
    if (typeof sanitized.url === "string") sanitized.url = this.safeUrl(sanitized.url, 2000);
    if (typeof sanitized.text === "string") sanitized.text = this.safeText(sanitized.text, 1200);
    if (typeof sanitized.error === "string") sanitized.error = this.safeText(sanitized.error, 300);
    if (typeof sanitized.location?.url === "string") {
      sanitized.location = { ...sanitized.location, url: this.safeUrl(sanitized.location.url, 1000) };
    }
    const entry = { ...sanitized, seq: ++this.seq, at: new Date().toISOString() };
    if (!Object.hasOwn(event, "navigation_seq")) entry.navigation_seq = this.currentNavigationSeq;
    this.events.push(entry);
    if (this.events.length > 512) { this.events.shift(); this.dropped++; }
    return entry;
  }
  finishRequest(request, state) {
    const entry = this.requests.get(request);
    if (!entry) return;
    entry.event.state = state;
    entry.event.duration_ms = Date.now() - entry.started;
    if (state === "failed") entry.event.error = this.safeText(request.failure()?.errorText || "Request failed", 300);
    // Completion gets its own sequence so cursor users do not miss an update to
    // a request that began before their last inspection.
    this.push({ ...entry.event, kind: "network", request_started_seq: entry.event.seq, updated: true });
  }
  read(params = {}) {
    const scope = params.scope ?? "recent";
    const method = params.method?.toUpperCase() ?? null;
    let pageUrl = "";
    try { pageUrl = this.page.url(); } catch {}
    const scopeOrigin = scope === "current_origin" ? originOf(pageUrl) : null;
    const scopeAvailable = scope === "recent" ||
      (scope === "current_navigation" && this.currentNavigationSeq !== null) ||
      (scope === "current_origin" && scopeOrigin !== null);
    const hasNetworkFilter = method !== null || params.status !== undefined || params.resource_type !== undefined;
    const cursor = params.since_seq ?? 0;
    const filtered = this.events.filter((event) =>
      event.seq > cursor && scopeAvailable &&
      (event.kind !== "console" || params.include_console !== false) &&
      (event.kind !== "network" || params.include_network !== false) &&
      (scope !== "current_navigation" || event.navigation_seq === this.currentNavigationSeq) &&
      (scope !== "current_origin" || event.kind !== "network" || originOf(event.url) === scopeOrigin) &&
      (!hasNetworkFilter || event.kind === "network") &&
      (method === null || event.method === method) &&
      (params.status === undefined || event.status === params.status) &&
      (params.resource_type === undefined || event.resource_type === params.resource_type));
    const limit = params.limit ?? 80;
    const events = params.since_seq === undefined ? filtered.slice(-limit) : filtered.slice(0, limit);
    const hasMore = filtered.length > events.length;
    const cursorAhead = params.since_seq !== undefined && params.since_seq > this.seq;
    const oldestRetainedSeq = this.events[0]?.seq ?? null;
    const retentionGap = this.dropped > 0 && (params.since_seq === undefined
      ? scope !== "current_navigation" || this.currentNavigationSeq === null || oldestRetainedSeq === null || this.currentNavigationSeq < oldestRetainedSeq
      : oldestRetainedSeq === null || params.since_seq < oldestRetainedSeq - 1);
    const coverageComplete = scopeAvailable && !cursorAhead && !hasMore && !retentionGap;
    return {
      scope,
      scope_available: scopeAvailable,
      scope_origin: scope === "current_origin" ? scopeOrigin : null,
      navigation_start_seq: scope === "current_navigation" ? this.currentNavigationSeq : null,
      filters: { method, status: params.status ?? null, resource_type: params.resource_type ?? null },
      url_redaction: "query_and_fragment_omitted",
      collection_started_at: this.startedAt,
      latest_seq: this.seq,
      next_seq: params.since_seq === undefined || !hasMore ? this.seq : events.at(-1).seq,
      oldest_retained_seq: oldestRetainedSeq,
      dropped_events: this.dropped,
      has_more: hasMore,
      coverage: {
        mode: params.since_seq === undefined ? "recent_tail" : "forward",
        omitted_direction: hasMore ? (params.since_seq === undefined ? "older" : "newer") : null,
        cursor_ahead: cursorAhead,
        retention_gap: retentionGap,
        complete: coverageComplete,
      },
      events: events.map((event) => ({ ...event })),
    };
  }
  safeText(text, length) { return redactUrlsInText(text, this.auth).slice(0, length); }
  safeUrl(url, length) { return withoutQueryAndFragment(redact(url, this.auth)).slice(0, length); }
  dispose() { for (const [name, listener] of this.listeners) this.page.off(name, listener); this.listeners.length = 0; }
}
