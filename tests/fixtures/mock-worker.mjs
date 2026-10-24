// Exercises the Rust transport and cancellation boundary without a browser.
import readline from 'node:readline';
let active = 0;
let sequence = 0;
const pending = new Map();
const lateAcknowledgments = new Map();
const heldOperations = new Set();
const result = (id, body) => process.stdout.write(`${JSON.stringify({ id, result: body })}\n`);
const text = (body) => ({ content: [{ type: 'text', text: JSON.stringify(body) }], isError: false });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'shutdown') {
    result(id, text({ shutdown: true }));
    process.exit(0);
  }
  if (method === 'cancel') {
    const operation = pending.get(params.operation_id);
    if (operation) operation.cancelled = true;
    if (heldOperations.delete(params.operation_id)) {
      active -= 1;
      pending.delete(params.operation_id);
      result(params.operation_id, text(operation));
    }
    if (lateAcknowledgments.has(params.operation_id)) {
      lateAcknowledgments.set(params.operation_id, id);
      return;
    }
    result(id, text({ cancellation_requested: Boolean(operation) }));
    return;
  }
  if (method === 'crash') process.exit(13);
  if (method === 'oversize') {
    result(id, text({ value: 'x'.repeat(65536) }));
    return;
  }
  if (method === 'hold') {
    pending.set(id, { cancelled: false, sequence: ++sequence, concurrent_at_start: active++ });
    heldOperations.add(id);
    return;
  }
  if (method === 'delay' || method === 'late_cancel_ack') {
    const operation = { cancelled: false, sequence: ++sequence, concurrent_at_start: active++ };
    pending.set(id, operation);
    if (method === 'late_cancel_ack') lateAcknowledgments.set(id, null);
    setTimeout(() => {
      active -= 1;
      pending.delete(id);
      result(id, text(operation));
      const acknowledgment = lateAcknowledgments.get(id);
      lateAcknowledgments.delete(id);
      if (acknowledgment) result(acknowledgment, text({ cancellation_requested: true }));
    }, params.milliseconds ?? 100);
    return;
  }
  result(id, text({ active, sequence: ++sequence, echoed: params }));
});
