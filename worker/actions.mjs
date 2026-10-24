// Copyright 2026 Sedna Labs. SPDX-License-Identifier: Apache-2.0
// Adapted and modified from Sedna/OpenAI Codex; see NOTICE and docs/provenance.md.
// Actions and locator selection are adapted from Sedna's Playwright provider;
// lifecycle, cancellation and input cleanup belong to this long-lived worker.
import { Rejected } from "./operation.mjs";
import { evaluateRead, geometryDOM, sameGeometry } from "./dom.mjs";

const SPECIAL_KEYS = new Set([
  "Alt", "AltGraph", "Control", "ControlOrMeta", "Meta", "Shift", "Enter", "Return",
  "Tab", "Escape", "Esc", "Backspace", "Delete", "Insert", "Home", "End",
  "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Space", "CapsLock", "NumLock", "ScrollLock", "Pause", "PrintScreen",
]);
function validKey(key) { return /^[\x20-\x7e]$/.test(key) || SPECIAL_KEYS.has(key) || /^F([1-9]|1[0-9]|2[0-4])$/.test(key); }
function chordParts(key) {
  return key === "+" ? ["+"] : key.endsWith("++") ? [...key.slice(0, -2).split("+"), "+"] : key.split("+");
}
function actualKey(key) {
  return key === "ControlOrMeta" ? process.platform === "darwin" ? "Meta" : "Control" : key === "Return" ? "Enter" : key === "Esc" ? "Escape" : key;
}
export function validateUrl(value) {
  if (value === "about:blank") return value;
  let url;
  try { url = new URL(value); } catch { throw new Rejected("Navigation URL must be absolute."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Rejected("Only http(s) URLs without embedded credentials, or about:blank, are allowed.");
  }
  return url.href;
}
export function actionUsesCoordinates(action) {
  return typeof action.x === "number" || (action.type === "drag" && (action.from.x !== undefined || action.to.x !== undefined));
}
export function validateActions(actions, params) {
  for (const action of actions) {
    if (action.type === "navigate") validateUrl(action.url);
    if (actionUsesCoordinates(action) && !params.observation_id) {
      throw new Rejected("Coordinate input requires the observation_id from the latest browser_observe or browser_step.", "OBSERVATION_REQUIRED");
    }
    if (["press", "key_down", "key_up"].includes(action.type)) {
      const key = action.key;
      const parts = action.type === "press" ? chordParts(key) : [key];
      if (!parts.every(validKey)) throw new Rejected("Unsupported key or key combination.");
    }
  }
}

export function locatorFor(page, target) {
  const root = target.frame ? page.frameLocator(target.frame) : page;
  const exact = target.exact ?? true;
  if (target.css !== undefined) return root.locator(target.css);
  if (target.role !== undefined) return root.getByRole(target.role, { ...(target.name === undefined ? {} : { name: target.name }), exact });
  if (target.text !== undefined) return root.getByText(target.text, { exact });
  if (target.label !== undefined) return root.getByLabel(target.label, { exact });
  if (target.placeholder !== undefined) return root.getByPlaceholder(target.placeholder, { exact });
  if (target.test_id !== undefined) return root.getByTestId(target.test_id);
  throw new Rejected("Target requires one locator strategy.");
}

export function inputState() { return { keys: new Set(), buttons: new Set() }; }
export async function releaseInput(page, state) {
  const warnings = [];
  for (const button of state.buttons) {
    try { await page.mouse.up({ button }); } catch (error) { if (!page.isClosed()) warnings.push("Could not release mouse button " + button + "."); }
  }
  for (const key of [...state.keys].reverse()) {
    try { await page.keyboard.up(key); } catch (error) { if (!page.isClosed()) warnings.push("Could not release key " + key + "."); }
  }
  state.keys.clear();
  state.buttons.clear();
  return warnings;
}

async function coordinatePoint(page, point) {
  if (point.target) {
    const locator = locatorFor(page, point.target);
    await locator.waitFor({ state: "visible", timeout: 5000 });
    const box = await locator.boundingBox({ timeout: 5000 });
    if (!box) throw new Error("Target has no visible bounding box.");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  const viewport = page.viewportSize();
  if (point.x < 0 || point.y < 0 || point.x >= viewport.width || point.y >= viewport.height) {
    throw new Rejected("Coordinates are outside the current viewport.", "COORDINATE_OUT_OF_BOUNDS");
  }
  return { x: point.x, y: point.y };
}

export async function assertObservation(record, observationId) {
  if (!observationId) return;
  const observation = record.lastObservation;
  if (!observation || observation.id !== observationId || !observation.actionable ||
      observation.navigation !== record.navigation) {
    throw new Rejected("Observation is stale for this page. Observe the page again.", "STALE_OBSERVATION");
  }
  const current = await evaluateRead(record.page, geometryDOM);
  if (!sameGeometry(observation.geometry, current)) {
    throw new Rejected("Page navigation or geometry changed since the observation. Observe again.", "STALE_OBSERVATION");
  }
}

export async function runAction(record, action, operation, state, options) {
  operation.check();
  const page = record.page;
  const timeout = operation.timeout(options.actionTimeout);
  const locator = action.target ? locatorFor(page, action.target) : null;
  if (actionUsesCoordinates(action)) await assertObservation(record, options.observationId);
  switch (action.type) {
    case "navigate": await page.goto(validateUrl(action.url), { waitUntil: "domcontentloaded", timeout }); break;
    case "back": await page.goBack({ waitUntil: "domcontentloaded", timeout }); break;
    case "forward": await page.goForward({ waitUntil: "domcontentloaded", timeout }); break;
    case "reload": await page.reload({ waitUntil: "domcontentloaded", timeout }); break;
    case "click": {
      const button = action.button || "left";
      const ownedModifiers = (action.modifiers || []).map(actualKey).filter((key) => !state.keys.has(key));
      for (const key of ownedModifiers) state.keys.add(key);
      state.buttons.add(button);
      try {
        if (locator) await locator.click({ button, clickCount: action.click_count || 1, modifiers: action.modifiers, timeout });
        else {
          const point = await coordinatePoint(page, action);
          for (const key of ownedModifiers) await page.keyboard.down(key);
          await page.mouse.click(point.x, point.y, { button, clickCount: action.click_count || 1 });
        }
        state.buttons.delete(button);
      } finally {
        for (const key of ownedModifiers.reverse()) {
          try { await page.keyboard.up(key); state.keys.delete(key); } catch {}
        }
      }
      break;
    }
    case "hover": {
      if (locator) await locator.hover({ timeout });
      else { const point = await coordinatePoint(page, action); await page.mouse.move(point.x, point.y); }
      break;
    }
    case "fill": await locator.fill(action.text, { timeout }); break;
    case "type":
      if (locator) await locator.focus({ timeout });
      if (action.delay_ms) {
        for (const character of action.text) {
          operation.check();
          await page.keyboard.type(character);
          await operation.sleep(action.delay_ms);
        }
      } else await page.keyboard.insertText(action.text);
      break;
    case "focus": await locator.focus({ timeout }); break;
    case "clear": await locator.fill("", { timeout }); break;
    case "check": await locator.setChecked(action.checked, { timeout }); break;
    case "select": await locator.selectOption(action.values, { timeout }); break;
    case "press": {
      const pressed = [];
      try {
        for (const key of chordParts(action.key).map(actualKey)) {
          operation.check();
          if (!state.keys.has(key)) { state.keys.add(key); pressed.push(key); }
          await page.keyboard.down(key);
        }
      } finally {
        for (const key of pressed.reverse()) {
          try { await page.keyboard.up(key); state.keys.delete(key); } catch {}
        }
      }
      break;
    }
    case "key_down": { const key = actualKey(action.key); state.keys.add(key); await page.keyboard.down(key); break; }
    case "key_up": { const key = actualKey(action.key); await page.keyboard.up(key); state.keys.delete(key); break; }
    case "mouse_move": {
      const point = await coordinatePoint(page, action);
      await page.mouse.move(point.x, point.y, { steps: action.steps || 1 });
      break;
    }
    case "mouse_down": {
      const button = action.button || "left";
      state.buttons.add(button); await page.mouse.down({ button }); break;
    }
    case "mouse_up": {
      const button = action.button || "left";
      await page.mouse.up({ button }); state.buttons.delete(button); break;
    }
    case "scroll": await page.mouse.wheel(action.delta_x || 0, action.delta_y); break;
    case "drag": {
      const from = await coordinatePoint(page, action.from);
      const to = await coordinatePoint(page, action.to);
      operation.check();
      await page.mouse.move(from.x, from.y);
      state.buttons.add("left");
      await page.mouse.down({ button: "left" });
      try {
        const steps = action.steps || 12;
        for (let i = 1; i <= steps; i++) {
          operation.check();
          await page.mouse.move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
        }
      } finally { await page.mouse.up({ button: "left" }); state.buttons.delete("left"); }
      break;
    }
    case "wait": await operation.sleep(action.ms); break;
    case "wait_for": await locator.waitFor({ state: action.state || "visible", timeout: Math.min(timeout, action.timeout_ms || timeout) }); break;
    case "dialog": {
      const dialog = record.dialog;
      if (!dialog) throw new Rejected("No dialog is open.", "NO_DIALOG");
      record.resolvingDialog = dialog;
      try {
        if (action.action === "accept") await dialog.accept(action.text);
        else await dialog.dismiss();
        if (record.dialog === dialog) record.dialog = null;
      } catch (error) {
        if (/no dialog is showing|already been handled/i.test(error.message)) {
          if (record.dialog === dialog) record.dialog = null;
          throw new Rejected("The native dialog was already resolved by another browser client.", "DIALOG_ALREADY_CLOSED");
        }
        throw error;
      } finally { if (record.resolvingDialog === dialog) record.resolvingDialog = null; }
      break;
    }
    default: throw new Rejected("Unsupported action type.");
  }
}
