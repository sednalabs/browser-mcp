// Copyright 2026 Sedna Labs. SPDX-License-Identifier: Apache-2.0
// Adapted and modified from Sedna/OpenAI Codex; see NOTICE and docs/provenance.md.
import { Rejected } from "./operation.mjs";
import { releaseInput } from "./actions.mjs";

export class DialogBlocked extends Error {
  constructor() {
    super("A native JavaScript dialog interrupted this action. Resolve that dialog before other browser mutations; the original input remains tracked until it settles.");
    this.code = "DIALOG_OPEN";
  }
}

export async function runWithDialogFence(record, operation, state, action, execute) {
  if (record.dialog) throw new Rejected("Resolve the open native dialog before ordinary browser actions.", "DIALOG_OPEN");
  let opened;
  const dialogOpened = new Promise((resolve) => { opened = () => resolve({ dialog: true }); });
  record.dialogWaiters.add(opened);
  // A modal dialog can keep Chrome's input acknowledgement pending indefinitely.
  // This is the one explicit continuation case: retain that exact promise and
  // owned input state, fence all other mutations, and settle it after resolution.
  const outcome = Promise.resolve().then(execute).then(
    () => ({ completed: true }),
    (error) => ({ completed: false, error }),
  );
  try {
    const result = await Promise.race([outcome, dialogOpened]);
    if (result.dialog || record.dialog) {
      record.pendingInput = { operationId: operation.id, actionType: action.type, outcome, state };
      operation.suspendedForDialog = true;
      throw new DialogBlocked();
    }
    if (result.error) throw result.error;
  } finally { record.dialogWaiters.delete(opened); }
}

export async function settleDialogInput(record) {
  const pending = record.pendingInput;
  if (!pending) return null;
  if (record.dialog) throw new DialogBlocked();
  let opened;
  const dialogOpened = new Promise((resolve) => { opened = () => resolve({ dialog: true }); });
  record.dialogWaiters.add(opened);
  let outcome;
  try { outcome = await Promise.race([pending.outcome, dialogOpened]); }
  finally { record.dialogWaiters.delete(opened); }
  if (outcome.dialog || record.dialog) throw new DialogBlocked();
  const warnings = await releaseInput(record.page, pending.state);
  if (warnings.length) {
    throw new Rejected("The dialog was resolved, but owned input cleanup failed. Reset or close the session before further mutations.", "INPUT_RECOVERY_REQUIRED");
  }
  record.pendingInput = null;
  return {
    operation_id: pending.operationId,
    action_type: pending.actionType,
    action_status: outcome.completed ? "completed" : "uncertain",
    original_action_settled: true,
    held_inputs_released: true,
    dialog_resolution: record.lastDialogResolution || null,
  };
}
