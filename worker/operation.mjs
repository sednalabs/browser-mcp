// Copyright 2026 Sedna Labs. SPDX-License-Identifier: Apache-2.0
// Adapted and modified from Sedna/OpenAI Codex; see NOTICE and docs/provenance.md.
export class Cancelled extends Error {
  constructor(message = "Operation cancelled.") { super(message); this.name = "Cancelled"; this.code = "CANCELLED"; }
}
export class Rejected extends Error {
  constructor(message, code = "INVALID_ARGUMENT") { super(message); this.name = "Rejected"; this.code = code; }
}

export class Operation {
  constructor(id, timeoutMs) {
    this.id = id;
    this.controller = new AbortController();
    this.reason = null;
    this.timeoutMs = timeoutMs;
    this.startedAt = null;
    this.deadline = Infinity;
    this.timer = null;
  }
  start() {
    this.startedAt = new Date().toISOString();
    this.deadline = Date.now() + this.timeoutMs;
    this.timer = setTimeout(() => this.cancel("Operation time budget expired."), this.timeoutMs);
    this.timer.unref();
  }
  cancel(reason = "Cancelled by client.") {
    if (this.controller.signal.aborted) return;
    this.reason = reason;
    this.controller.abort(new Cancelled(reason));
  }
  check() {
    if (this.controller.signal.aborted) throw new Cancelled(this.reason);
    if (this.suspendedForDialog) throw new Rejected("The action was interrupted by a native JavaScript dialog.", "DIALOG_OPEN");
  }
  timeout(maximum) { this.check(); return Math.max(1, Math.min(maximum, this.deadline - Date.now())); }
  finish() { clearTimeout(this.timer); }
  async sleep(ms) {
    this.check();
    if (!ms) return;
    await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new Cancelled(this.reason)); };
      const timer = setTimeout(() => { this.controller.signal.removeEventListener("abort", abort); resolve(); }, ms);
      this.controller.signal.addEventListener("abort", abort, { once: true });
    });
  }
}
