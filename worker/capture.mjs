// Copyright 2026 Sedna Labs. SPDX-License-Identifier: Apache-2.0
// Adapted and modified from Sedna/OpenAI Codex; see NOTICE and docs/provenance.md.
import { evaluateRead, geometryDOM, sendBounded } from "./dom.mjs";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export function imageDimensions(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      const marker = buffer[offset + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      const length = buffer.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      if (length < 2) break;
      offset += length + 2;
    }
  }
  throw new Error("Unsupported or malformed screenshot image.");
}

export async function captureViewport(page, { hasDialog = () => false } = {}) {
  const assertNoDialog = () => {
    if (hasDialog()) throw new Error("A native JavaScript dialog blocks reliable current-frame capture. Resolve it with browser_step dialog accept/dismiss; the dialog text is reported separately.");
  };
  assertNoDialog();
  const warnings = [];
  const before = await evaluateRead(page, geometryDOM);
  let chosen;
  for (const options of [
    { type: "png", scale: "css" },
    { type: "jpeg", quality: 75, scale: "css" },
  ]) {
    assertNoDialog();
    try {
      const buffer = await page.screenshot({ ...options, fullPage: false, timeout: 4000, caret: "initial" });
      if (buffer.length > MAX_IMAGE_BYTES) { warnings.push("Screenshot exceeded the inline size budget; trying JPEG."); continue; }
      chosen = { buffer, mimeType: options.type === "png" ? "image/png" : "image/jpeg", method: "playwright.viewport." + options.type };
      break;
    } catch (error) {
      assertNoDialog();
      warnings.push("Playwright screenshot failed: " + error.message.slice(0, 240));
    }
  }
  if (!chosen) {
    assertNoDialog();
    let session;
    try {
      session = await page.context().newCDPSession(page);
      const result = await sendBounded(session, "Page.captureScreenshot", {
        format: "jpeg", quality: 65, fromSurface: true, captureBeyondViewport: false,
      }, 4000);
      const buffer = Buffer.from(result.data, "base64");
      if (buffer.length > MAX_IMAGE_BYTES) throw new Error("CDP screenshot exceeds inline size budget.");
      chosen = { buffer, mimeType: "image/jpeg", method: "cdp.viewport.jpeg" };
    } finally { await session?.detach().catch(() => {}); }
  }
  assertNoDialog();
  const after = await evaluateRead(page, geometryDOM);
  const dimensions = imageDimensions(chosen.buffer);
  const stableGeometry = before.url === after.url &&
    before.viewport.width === after.viewport.width && before.viewport.height === after.viewport.height &&
    before.scroll.x === after.scroll.x && before.scroll.y === after.scroll.y &&
    before.device_pixel_ratio === after.device_pixel_ratio;
  if (!stableGeometry) warnings.push("Navigation or viewport geometry changed during capture; observe again before coordinate input.");
  return {
    image: { type: "image", mimeType: chosen.mimeType, data: chosen.buffer.toString("base64") },
    geometry: {
      ...after,
      image: dimensions,
      viewport_css_per_image_pixel: {
        x: after.viewport.width / dimensions.width,
        y: after.viewport.height / dimensions.height,
      },
      coordinate_space: "viewport_css_pixels",
      capture_method: chosen.method,
      stable_geometry: stableGeometry,
    },
    warnings,
  };
}
