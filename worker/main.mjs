#!/usr/bin/env node
// Copyright 2026 Sedna Labs. SPDX-License-Identifier: Apache-2.0
// Adapted and modified from Sedna/OpenAI Codex; see NOTICE and docs/provenance.md.
import readline from "node:readline";
import { loadConfig } from "./config.mjs";
import { BrowserRuntime } from "./runtime.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;
let runtime;
try { runtime = new BrowserRuntime(await loadConfig()); }
catch (error) { process.stderr.write("Browser worker configuration failed: " + error.message + "\n"); process.exit(1); }
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let ending = false;
function write(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function protocolError(id, message, code = "INVALID_REQUEST") { write({ id: id ?? null, error: { code, message } }); }

input.on("line", (line) => {
  let request;
  try {
    if (Buffer.byteLength(line) > MAX_INPUT_BYTES) throw new Error("Worker request exceeds 1 MiB.");
    request = JSON.parse(line);
    if (!request || !["number", "string"].includes(typeof request.id) || typeof request.method !== "string") {
      throw new Error("Expected {id,method,params}.");
    }
    if (ending) throw new Error("Worker is shutting down.");
    if (request.method === "cancel") {
      if (!request.params || !["string", "number"].includes(typeof request.params.operation_id)) throw new Error("cancel requires operation_id.");
      write({ id: request.id, result: { content: [{ type: "text", text: JSON.stringify(runtime.cancel(request.params.operation_id)) }] } });
      return;
    }
    if (request.method === "shutdown") ending = true;
    runtime.call(request.id, request.method, request.params ?? {}).then((result) => {
      write({ id: request.id, result });
      if (request.method === "shutdown") {
        input.close();
        // Closing stdin releases its handle without truncating stdout's final line.
        process.stdin.destroy();
      }
    }, (error) => protocolError(request.id, error.message, error.code)).catch((error) => {
      process.stderr.write("Worker output failed: " + error.message + "\n");
      void finish();
    });
  } catch (error) { protocolError(request?.id, error.message); }
});

let finalizing;
function finish() {
  if (finalizing) return finalizing;
  ending = true;
  finalizing = runtime.dispose().catch((error) => {
    process.stderr.write("Browser cleanup failed: " + error.message + "\n");
    process.exitCode = 1;
  });
  return finalizing;
}
input.on("close", () => { void finish(); });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {
  input.close();
  process.stdin.destroy();
  void finish();
});
process.stdout.on("error", () => { input.close(); process.stdin.destroy(); void finish(); });
