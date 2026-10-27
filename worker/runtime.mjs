// Copyright 2026 Sedna Labs. SPDX-License-Identifier: Apache-2.0
// Adapted and modified from Sedna/OpenAI Codex; see NOTICE and docs/provenance.md.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Ajv from "ajv";
import { chromium } from "playwright";
import { tools } from "./schemas.mjs";
import { Profile, redact, installServiceAuth } from "./config.mjs";
import { Operation, Cancelled, Rejected } from "./operation.mjs";
import { captureViewport } from "./capture.mjs";
import { inspectDOM, geometryDOM, evaluateRead, sameGeometry } from "./dom.mjs";
import { Diagnostics } from "./diagnostics.mjs";
import { validateActions, validateUrl, runAction, inputState, releaseInput, assertObservation } from "./actions.mjs";
import { DialogBlocked, runWithDialogFence, settleDialogInput } from "./modal.mjs";

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map(tools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));
const jsonResult = (value, images = [], isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(value) }, ...images],
  ...(isError ? { isError: true } : {}),
});

export class BrowserRuntime {
  constructor(config) {
    this.config = config;
    this.profile = new Profile(config);
    this.processId = randomUUID().slice(0, 12);
    this.generation = 0;
    this.context = null;
    this.pages = new Map();
    this.pageByObject = new WeakMap();
    this.currentPageId = null;
    this.endpoint = null;
    this.version = null;
    this.nextPage = 0;
    this.nextObservation = 0;
    this.operations = new Map();
    this.queue = Promise.resolve();
    this.shuttingDown = false;
    this.lifecycle = "not_started";
    this.expectedClosures = new WeakSet();
    this.lastOperation = null;
  }

  get instanceId() { return this.generation ? this.processId + ":" + this.generation : null; }
  safe(value, max = 1600) {
    const text = redact(value, this.config.serviceAuth).replace(/\u001b\[[0-9;]*m/g, "");
    if (text.length <= max) return text;
    if (!text.includes("\n")) return text.slice(0, max);
    const head = Math.min(300, Math.floor(max / 3));
    return text.slice(0, head) + "\n[details omitted]\n" + text.slice(-(max - head - 20));
  }
  safeData(value) {
    if (typeof value === "string") return redact(value, this.config.serviceAuth);
    if (Array.isArray(value)) return value.map((item) => this.safeData(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.safeData(item)]));
    return value;
  }
  status() {
    return {
      running: Boolean(this.context),
      lifecycle: this.lifecycle,
      reset_required: this.lifecycle === "lost",
      browser_instance_id: this.instanceId,
      current_page_id: this.currentPageId,
      cdp_endpoint: this.endpoint,
      chromium_version: this.version,
      node_version: process.version,
      profile_kind: this.profile.temporary ? "private_temporary" : "explicit_persistent",
      profile_reserved: Boolean(this.profile.directory),
      service_auth: this.config.serviceAuth ? { name: this.config.serviceAuth.name, origin_count: this.config.serviceAuth.origins.size } : null,
      last_operation: this.lastOperation,
      pending_dialogs: [...this.pages.values()].filter((record) => record.dialog || record.pendingInput).map((record) => ({
        page_id: record.id,
        type: record.dialog?.type() || null,
        message: record.dialog ? this.safe(record.dialog.message(), 600) : null,
        pending_operation_id: record.pendingInput?.operationId ?? null,
        input_cleanup_pending: Boolean(record.pendingInput),
      })),
    };
  }

  cancel(id) {
    const operation = this.operations.get(String(id));
    if (operation) operation.cancel();
    return { accepted: Boolean(operation), operation_id: id };
  }

  call(id, method, params = {}) {
    const key = String(id);
    if (this.operations.has(key)) return Promise.reject(new Rejected("Duplicate operation ID.", "DUPLICATE_ID"));
    if (this.shuttingDown && method !== "shutdown") return Promise.reject(new Rejected("Worker is shutting down.", "SHUTTING_DOWN"));
    if (method === "shutdown") this.shuttingDown = true;
    const operation = new Operation(id, this.config.operationTimeout);
    this.operations.set(key, operation);
    const result = this.queue.then(async () => {
      operation.start();
      let response;
      try { response = await this.execute(operation, method, params); }
      catch (error) {
        const sandboxUnavailable = /(?:no usable sandbox|chromium sandboxing failed)/i.test(String(error?.message || ""));
        const code = error.code || (sandboxUnavailable ? "CHROMIUM_SANDBOX_UNAVAILABLE" : "BROWSER_ERROR");
        const message = this.safe(error.message);
        response = jsonResult({
          operation_id: id,
          status: error instanceof Cancelled ? "cancelled" : error instanceof Rejected ? "rejected" : "failed",
          error: {
            code,
            message: sandboxUnavailable
              ? message + " Chromium's sandbox was not disabled. On Ubuntu, use the root-owned per-executable AppArmor guidance in docs/operations.md; do not use --no-sandbox for open-web browsing."
              : message,
          },
          session: this.status(),
        }, [], true);
      } finally { operation.finish(); this.operations.delete(key); }
      if (["browser_step", "browser_review"].includes(method) || (method === "browser_tabs" && params?.action !== "list")) this.remember(method, response);
      return response;
    });
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  remember(method, response) {
    const data = JSON.parse(response.content[0].text);
    const keys = ["operation_id", "status", "actions", "error", "cancellation", "cleanup", "page_id",
      "browser_instance_id", "observation_id", "observation_unavailable", "captures", "restoration", "created_page_id"];
    const receipt = Object.fromEntries(keys.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
    receipt.method = method;
    receipt.completed_at = new Date().toISOString();
    receipt.images_retained = false;
    if (Buffer.byteLength(JSON.stringify(receipt)) > 32768) {
      for (const action of receipt.actions || []) if (action.error) action.error.message = action.error.message.slice(0, 240);
      delete receipt.captures;
      receipt.truncated = true;
    }
    this.lastOperation = receipt;
  }

  async execute(operation, method, params) {
    if (["check", "shutdown"].includes(method)) {
      if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length) {
        throw new Rejected(method + " takes an empty object.");
      }
    } else {
      const validate = validators.get(method);
      if (!validate) throw new Rejected("Unknown browser method.", "UNKNOWN_METHOD");
      if (!validate(params)) {
        const message = validate.errors.slice(0, 4).map((error) => error.instancePath + " " + error.message).join("; ");
        throw new Rejected("Invalid arguments: " + message);
      }
      if (method === "browser_step") validateActions(params.actions, params);
      if (method === "browser_tabs" && params.action === "new" && params.url) validateUrl(params.url);
    }
    if (method === "shutdown") {
      await this.closeBrowser();
      await this.profile.release();
      return jsonResult({ operation_id: operation.id, status: "completed", closed: true });
    }
    operation.check();
    await this.reconcileClosedDialogs();
    const blocked = [...this.pages.values()].find((record) => record.dialog || record.pendingInput);
    if (blocked) {
      const canRecover = method === "browser_step" && params.actions[0]?.type === "dialog" &&
        (params.page_id || this.currentPageId) === blocked.id;
      const canInspect = ["browser_inspect", "browser_observe", "browser_session"].includes(method) ||
        (method === "browser_tabs" && params.action === "list");
      if (!canRecover && !canInspect) {
        throw new Rejected("A native dialog or pending input recovery fences browser mutations. Resolve the dialog on page " + blocked.id + ", or reset/close the session.", "DIALOG_OPEN");
      }
    }
    if (method === "browser_session") {
      if (params.action === "close") await this.closeBrowser();
      if (params.action === "reset") {
        await this.closeBrowser();
        operation.check();
        await this.ensureBrowser();
      }
      return jsonResult({ operation_id: operation.id, status: "completed", ...this.status() });
    }
    if (method === "browser_tabs") return this.tabs(operation, params);
    const record = await this.getPage(params.page_id);
    operation.check();
    if (method === "check") {
      const screenshot = await captureViewport(record.page);
      return jsonResult({
        operation_id: operation.id, status: "completed", check: "browser_started_and_screenshot_captured",
        screenshot: { mime_type: screenshot.image.mimeType, ...screenshot.geometry.image }, ...this.status(),
      });
    }
    if (method === "browser_inspect") {
      return jsonResult({ operation_id: operation.id, status: "completed", page_id: record.id, browser_instance_id: this.instanceId, ...record.diagnostics.read(params) });
    }
    if (method === "browser_step") return this.step(operation, record, params);
    if (method === "browser_review") return this.review(operation, record, params);
    const observation = await this.tryObserve(record, params.controls_limit);
    operation.check();
    return jsonResult({
      operation_id: operation.id,
      status: observation.data.observation_unavailable ? record.dialog ? "blocked" : "failed" : "completed",
      ...observation.data,
    }, observation.images, Boolean(observation.data.observation_unavailable));
  }

  async ensureBrowser() {
    if (this.context) return this.context;
    if (this.lifecycle === "lost") {
      throw new Rejected("The owned browser disconnected unexpectedly. Live page state was lost; call browser_session with action reset to start a new browser explicitly.", "BROWSER_DISCONNECTED");
    }
    const directory = await this.profile.acquire();
    const args = this.config.cdp ? ["--remote-debugging-port=0"] : [];
    if (this.config.noSandbox) args.push("--no-sandbox");
    const context = await chromium.launchPersistentContext(directory, {
      headless: this.config.headless,
      viewport: this.config.viewport,
      deviceScaleFactor: 1,
      executablePath: this.config.executable,
      chromiumSandbox: !this.config.noSandbox,
      args,
      timeout: 20000,
      acceptDownloads: false,
      serviceWorkers: this.config.serviceAuth ? "block" : "allow",
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    });
    this.context = context;
    this.lifecycle = "running";
    this.generation++;
    this.nextPage = 0;
    this.pages.clear();
    this.currentPageId = null;
    this.version = context.browser()?.version() || "unknown";
    context.setDefaultTimeout(this.config.actionTimeout);
    context.setDefaultNavigationTimeout(this.config.actionTimeout);
    context.on("page", (page) => this.registerPage(page));
    context.on("close", () => {
      if (this.context === context) {
        this.lifecycle = this.expectedClosures.has(context) ? "closed" : "lost";
        this.context = null;
        this.endpoint = null;
        for (const record of this.pages.values()) record.diagnostics.dispose();
        this.pages.clear();
        this.currentPageId = null;
      }
    });
    try {
      await installServiceAuth(context, this.config.serviceAuth, (message) => {
        const record = this.pages.get(this.currentPageId);
        record?.diagnostics.push({ kind: "console", level: "error", text: this.safe(message) });
      });
      for (const page of context.pages()) this.registerPage(page);
      if (!context.pages().length) this.registerPage(await context.newPage());
      await Promise.all([...this.pages.values()].map((record) => record.ready));
      if (this.config.cdp) {
        const lines = (await fs.readFile(path.join(directory, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
        const port = Number(lines[0]);
        if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[a-z0-9-]+$/i.test(lines[1])) {
          throw new Error("Chrome did not report a valid managed debugging endpoint.");
        }
        this.endpoint = "ws://127.0.0.1:" + port + lines[1];
      }
      return context;
    } catch (error) { await this.closeBrowser(); throw error; }
  }

  registerPage(page) {
    const existing = this.pageByObject.get(page);
    if (existing) return existing;
    const id = this.instanceId + ":p" + (++this.nextPage);
    const record = {
      id, page, targetId: null, navigation: 0, lastObservation: null, dialog: null,
      dialogWaiters: new Set(), pendingInput: null,
      publicDialogSequence: 0, monitoredDialogSequence: 0, closedDialogSequence: 0,
      lastDialogResolution: null, monitorSession: null, initializationError: null,
      diagnostics: new Diagnostics(page, this.config.serviceAuth),
    };
    this.pageByObject.set(page, record);
    this.pages.set(id, record);
    if (!this.currentPageId) this.currentPageId = id;
    page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) { record.navigation++; record.lastObservation = null; } });
    page.on("dialog", (dialog) => {
      record.publicDialogSequence++;
      record.dialog = record.closedDialogSequence >= record.publicDialogSequence ? null : dialog;
      for (const notify of record.dialogWaiters) notify();
    });
    page.on("close", () => {
      record.diagnostics.dispose();
      this.pages.delete(id);
      if (this.currentPageId === id) this.currentPageId = null;
    });
    record.ready = (async () => {
      let session;
      try {
        session = await page.context().newCDPSession(page);
        session.on("Page.javascriptDialogOpening", () => { record.monitoredDialogSequence++; });
        session.on("Page.javascriptDialogClosed", (event) => {
          record.closedDialogSequence = record.monitoredDialogSequence;
          record.lastDialogResolution = {
            accepted: event.result, source: record.resolvingDialog ? "provider_requested" : "external",
            observed_at: new Date().toISOString(),
          };
          record.dialog = null;
          // External clients can close native dialogs. Reconcile the retained
          // input inside our FIFO queue, never from this asynchronous event.
          this.queue = this.queue.then(() => this.reconcileClosedDialogs()).catch(() => {});
        });
        await session.send("Page.enable");
        const info = await session.send("Target.getTargetInfo");
        record.targetId = info.targetInfo.targetId;
        record.monitorSession = session;
      } catch (error) {
        if (!page.isClosed()) record.initializationError = error;
        await session?.detach().catch(() => {});
      }
    })();
    return record;
  }

  async getPage(id) {
    if (id && !this.pages.has(id)) throw new Rejected("Page ID is stale or does not belong to this session.", "PAGE_NOT_FOUND");
    await this.ensureBrowser();
    if (id) {
      const record = this.pages.get(id);
      if (!record || record.page.isClosed()) throw new Rejected("Requested page is closed.", "PAGE_NOT_FOUND");
      await record.ready;
      if (record.initializationError) throw record.initializationError;
      return record;
    }
    let record = this.pages.get(this.currentPageId);
    if (!record && this.pages.size === 1) {
      record = this.pages.values().next().value;
      this.currentPageId = record.id;
    }
    if (!record && this.pages.size > 1) throw new Rejected("No page is selected. Select an explicit page_id.", "PAGE_REQUIRED");
    if (!record) {
      record = this.registerPage(await this.context.newPage());
      this.currentPageId = record.id;
    }
    await record.ready;
    if (record.initializationError) throw record.initializationError;
    return record;
  }

  async reconcileClosedDialogs() {
    for (const record of this.pages.values()) {
      if (record.dialog || !record.pendingInput) continue;
      try {
        const recovery = await settleDialogInput(record);
        if (!recovery) continue;
        record.lastDialogRecovery = recovery;
        if (this.lastOperation?.operation_id === recovery.operation_id) {
          this.lastOperation.dialog_recovery = recovery;
          this.lastOperation.cleanup = { held_inputs_released: true, pending_dialog_resolution: false, warnings: [] };
          for (const action of this.lastOperation.actions || []) {
            if (action.status === "pending_dialog") action.status = recovery.action_status;
          }
          if (this.lastOperation.status === "blocked") this.lastOperation.status = "interrupted";
        }
      } catch (error) {
        if (!(error instanceof DialogBlocked)) record.inputRecoveryError = this.safe(error.message);
      }
    }
  }

  async listPages() {
    const pages = [];
    for (const record of this.pages.values()) {
      await record.ready;
      if (record.page.isClosed()) continue;
      let title = "";
      try { title = record.dialog || record.pendingInput ? "" : (await evaluateRead(record.page, () => document.title)); } catch {}
      pages.push({
        page_id: record.id, target_id: record.targetId, url: this.safe(record.page.url(), 2000),
        title: this.safe(title, 240), selected: record.id === this.currentPageId,
      });
    }
    return pages;
  }

  async tabs(operation, params) {
    if (["select", "close"].includes(params.action) && !this.pages.has(params.page_id)) {
      throw new Rejected("Page ID is stale or does not belong to this session.", "PAGE_NOT_FOUND");
    }
    await this.ensureBrowser();
    operation.check();
    let record;
    if (params.action === "new") {
      record = this.registerPage(await this.context.newPage());
      this.currentPageId = record.id;
      await record.ready;
      if (params.url) {
        try { await record.page.goto(validateUrl(params.url), { waitUntil: "domcontentloaded", timeout: operation.timeout(this.config.actionTimeout) }); }
        catch (error) {
          const observation = await this.tryObserve(record);
          return jsonResult({
            operation_id: operation.id, status: operation.controller.signal.aborted ? "cancelled" : "failed",
            error: { code: "NAVIGATION_OUTCOME_UNCERTAIN", message: this.safe(error.message) },
            created_page_id: record.id, pages: await this.listPages(), ...observation.data,
          }, observation.images, true);
        }
      }
    }
    if (params.action === "select") {
      record = this.pages.get(params.page_id);
      this.currentPageId = record.id;
      // Logical selection is deliberately separate from OS/browser focus.
    }
    if (params.action === "close") {
      const toClose = this.pages.get(params.page_id);
      await toClose.page.close({ runBeforeUnload: false });
    }
    const observation = record ? await this.tryObserve(record) : { data: {}, images: [] };
    return jsonResult({
      operation_id: operation.id, status: operation.controller.signal.aborted ? "cancelled" : "completed",
      browser_instance_id: this.instanceId, current_page_id: this.currentPageId,
      pages: await this.listPages(), ...observation.data,
    }, observation.images, operation.controller.signal.aborted);
  }

  async observe(record, controlsLimit = 24) {
    const navigationBefore = record.navigation;
    const capture = await captureViewport(record.page, { hasDialog: () => Boolean(record.dialog) });
    const capturedAt = new Date().toISOString();
    let summary;
    const warnings = capture.warnings.map((message) => this.safe(message, 400));
    try { if (!record.dialog) summary = await evaluateRead(record.page, inspectDOM, { limit: controlsLimit }); }
    catch (error) { warnings.push("Control map unavailable: " + this.safe(error.message, 300)); }
    const observationId = this.instanceId + ":o" + (++this.nextObservation);
    const actionable = capture.geometry.stable_geometry && navigationBefore === record.navigation &&
      (!summary || sameGeometry(capture.geometry, summary));
    record.lastObservation = { id: observationId, navigation: record.navigation, geometry: capture.geometry, actionable };
    return {
      data: {
        page_id: record.id, target_id: record.targetId, browser_instance_id: this.instanceId,
        observation_id: observationId, captured_at: capturedAt, actionable,
        geometry: this.safeData(capture.geometry),
        ...(summary ? { page: this.safeData(summary) } : {}),
        dialog: record.dialog ? { type: record.dialog.type(), message: this.safe(record.dialog.message(), 600) } : null,
        ...(record.lastDialogRecovery ? { dialog_recovery: record.lastDialogRecovery } : {}),
        warnings,
        images: [{ content_index: 1, label: "current_viewport", mime_type: capture.image.mimeType, geometry: this.safeData(capture.geometry) }],
      },
      images: [capture.image],
    };
  }

  async tryObserve(record, controlsLimit) {
    try { return await this.observe(record, controlsLimit); }
    catch (error) {
      record.lastObservation = null;
      return { data: {
        page_id: record.id,
        dialog: record.dialog ? { type: record.dialog.type(), message: this.safe(record.dialog.message(), 600) } : null,
        observation_unavailable: { message: this.safe(error.message), page_closed: record.page.isClosed() },
      }, images: [] };
    }
  }

  async step(operation, record, params) {
    const actions = params.actions.map((action, index) => ({ index, type: action.type, status: "not_started" }));
    const held = inputState();
    let failure = null;
    let index = 0;
    let cleanup = [];
    try {
      await assertObservation(record, params.observation_id);
      for (; index < params.actions.length; index++) {
        operation.check();
        const action = params.actions[index];
        actions[index].status = "started";
        try {
          const execute = () => runAction(record, action, operation, held, { actionTimeout: this.config.actionTimeout, observationId: params.observation_id });
          if (action.type === "dialog") {
            await execute();
            const recovery = await settleDialogInput(record);
            if (recovery) actions[index].recovery = recovery;
          } else {
            await runWithDialogFence(record, operation, held, action, execute);
          }
          actions[index].status = "completed";
        } catch (error) {
          actions[index].status = error instanceof DialogBlocked ? "pending_dialog" : error instanceof Rejected ? "rejected" : error instanceof Cancelled && ["wait", "wait_for"].includes(action.type) ? "cancelled" : "uncertain";
          actions[index].error = { code: error.code || "ACTION_FAILED", message: this.safe(error.message) };
          throw error;
        }
      }
      await operation.sleep(params.settle_ms ?? 120);
    } catch (error) { failure = error; }
    finally {
      if (record.pendingInput) cleanup = ["Owned input cleanup is pending native-dialog resolution; ordinary browser mutations are fenced."];
      else cleanup = await releaseInput(record.page, held);
    }
    // Cancellation never abandons a running Playwright promise. Input cleanup
    // and this final observation settle while the same FIFO queue remains held.
    const observation = await this.tryObserve(record);
    const cancelled = operation.controller.signal.aborted;
    const status = cancelled ? "cancelled" : failure instanceof DialogBlocked ? "blocked" : failure ? failure instanceof Rejected && actions.every((a) => a.status === "not_started") ? "rejected" : "failed" : "completed";
    return jsonResult({
      operation_id: operation.id, status, actions,
      ...(failure ? { error: { code: failure.code || "ACTION_FAILED", message: this.safe(failure.message) } } : {}),
      ...(cancelled ? { cancellation: { reason: operation.reason, remaining_actions_stopped: true } } : {}),
      cleanup: { held_inputs_released: cleanup.length === 0, pending_dialog_resolution: Boolean(record.pendingInput), warnings: cleanup },
      ...observation.data,
    }, observation.images, Boolean(failure || cancelled || observation.data.observation_unavailable));
  }

  async review(operation, record, params) {
    const page = record.page;
    const original = await evaluateRead(page, geometryDOM);
    const originalViewport = page.viewportSize();
    record.lastObservation = null;
    const images = [];
    const captures = [];
    const restoreErrors = [];
    let failure;
    try {
      for (const requested of params.captures) {
        operation.check();
        await page.setViewportSize({ width: requested.width, height: requested.height });
        operation.check();
        const scrollY = requested.scroll === "top" ? 0 : requested.scroll === "bottom"
          ? (await evaluateRead(page, geometryDOM)).document.height : requested.scroll_y;
        if (scrollY !== undefined) await page.evaluate((value) => window.scrollTo(window.scrollX, value), scrollY);
        await operation.sleep(requested.settle_ms ?? 150);
        const capture = await captureViewport(page, { hasDialog: () => Boolean(record.dialog) });
        images.push(capture.image);
        captures.push({
          label: requested.label, status: "captured", content_index: images.length,
          requested: { width: requested.width, height: requested.height, scroll: requested.scroll || "current", scroll_y: requested.scroll_y },
          geometry: this.safeData(capture.geometry), mime_type: capture.image.mimeType, warnings: capture.warnings.map((warning) => this.safe(warning, 300)),
        });
      }
    } catch (error) { failure = error; }
    finally {
      try { await page.setViewportSize(originalViewport); } catch (error) { restoreErrors.push("Viewport restoration failed: " + this.safe(error.message, 300)); }
      try { await page.evaluate((scroll) => window.scrollTo(scroll.x, scroll.y), original.scroll); } catch (error) { restoreErrors.push("Scroll restoration failed: " + this.safe(error.message, 300)); }
    }
    let restored;
    try { restored = await evaluateRead(page, geometryDOM); } catch {}
    const restoration = {
      attempted: true,
      viewport_restored: Boolean(restored && restored.viewport.width === original.viewport.width && restored.viewport.height === original.viewport.height),
      scroll_restored: Boolean(restored && Math.abs(restored.scroll.x - original.scroll.x) < 1 && Math.abs(restored.scroll.y - original.scroll.y) < 1),
      application_state_restored: false,
      note: "Viewport and scroll restoration does not undo application events. Call browser_observe for a fresh actionable observation.",
      warnings: restoreErrors,
    };
    if (!restoration.viewport_restored || !restoration.scroll_restored) {
      restoreErrors.push("Current viewport or scroll differs from the saved geometry, or could not be verified.");
    }
    const cancelled = operation.controller.signal.aborted;
    return jsonResult({
      operation_id: operation.id, status: cancelled ? "cancelled" : failure || restoreErrors.length ? "failed" : "completed",
      page_id: record.id, browser_instance_id: this.instanceId,
      captures, restoration,
      ...(failure ? { error: { code: failure.code || "CAPTURE_FAILED", message: this.safe(failure.message) } } : {}),
    }, images, Boolean(cancelled || failure || restoreErrors.length));
  }

  async closeBrowser() {
    const context = this.context;
    this.lifecycle = "closed";
    if (!context) return;
    this.expectedClosures.add(context);
    const pending = [...this.pages.values()].map((record) => record.pendingInput?.outcome).filter(Boolean);
    await context.close({ reason: "Browser session closed by its owning provider." });
    await Promise.all(pending);
    if (this.context === context) this.context = null;
    this.endpoint = null;
    for (const record of this.pages.values()) record.diagnostics.dispose();
    this.pages.clear();
    this.currentPageId = null;
  }

  async dispose() {
    this.shuttingDown = true;
    for (const operation of this.operations.values()) operation.cancel("Worker is shutting down.");
    await this.queue;
    await this.closeBrowser();
    await this.profile.release();
  }
}
