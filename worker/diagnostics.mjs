// Copyright 2026 Sedna Labs. SPDX-License-Identifier: Apache-2.0
// Adapted and modified from Sedna/OpenAI Codex; see NOTICE and docs/provenance.md.
import { redact } from "./config.mjs";

export class Diagnostics {
  constructor(page, auth) {
    this.page = page;
    this.auth = auth;
    this.startedAt = new Date().toISOString();
    this.seq = 0;
    this.dropped = 0;
    this.events = [];
    this.requests = new WeakMap();
    this.listeners = [];
    this.on("console", (message) => this.push({
      kind: "console", level: message.type(), text: this.safe(message.text(), 1200),
      location: { url: this.safe(message.location().url || "", 1000), line: message.location().lineNumber },
    }));
    this.on("pageerror", (error) => this.push({ kind: "console", level: "error", text: this.safe(error.message, 1200) }));
    this.on("request", (request) => {
      const event = this.push({
        kind: "network", method: request.method(), url: this.safe(request.url(), 2000),
        resource_type: request.resourceType(), status: null, state: "pending",
      });
      this.requests.set(request, { event, started: Date.now() });
    });
    this.on("response", (response) => {
      const entry = this.requests.get(response.request());
      if (entry) { entry.event.status = response.status(); entry.event.state = "response_received"; }
    });
    this.on("requestfinished", (request) => this.finishRequest(request, "finished"));
    this.on("requestfailed", (request) => this.finishRequest(request, "failed"));
  }
  safe(text, length) { return redact(text, this.auth).slice(0, length); }
  on(name, listener) { this.page.on(name, listener); this.listeners.push([name, listener]); }
  push(event) {
    const entry = { ...event, seq: ++this.seq, at: new Date().toISOString() };
    this.events.push(entry);
    if (this.events.length > 512) { this.events.shift(); this.dropped++; }
    return entry;
  }
  finishRequest(request, state) {
    const entry = this.requests.get(request);
    if (!entry) return;
    entry.event.state = state;
    entry.event.duration_ms = Date.now() - entry.started;
    if (state === "failed") entry.event.error = this.safe(request.failure()?.errorText || "Request failed", 300);
    // Completion gets its own sequence so cursor users do not miss an update to
    // a request that began before their last inspection.
    this.push({ ...entry.event, kind: "network", request_started_seq: entry.event.seq, updated: true });
  }
  read(params = {}) {
    const filtered = this.events.filter((event) =>
      event.seq > (params.since_seq ?? 0) &&
      (event.kind !== "console" || params.include_console !== false) &&
      (event.kind !== "network" || params.include_network !== false));
    const limit = params.limit ?? 80;
    const events = params.since_seq === undefined ? filtered.slice(-limit) : filtered.slice(0, limit);
    return {
      collection_started_at: this.startedAt,
      latest_seq: this.seq,
      next_seq: events.length ? events[events.length - 1].seq : (params.since_seq ?? this.seq),
      oldest_retained_seq: this.events[0]?.seq ?? null,
      dropped_events: this.dropped,
      has_more: filtered.length > events.length,
      events: events.map((event) => ({ ...event })),
    };
  }
  dispose() { for (const [name, listener] of this.listeners) this.page.off(name, listener); this.listeners.length = 0; }
}
