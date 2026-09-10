import { Worker } from 'node:worker_threads';

const workerUrl = new URL('./content-worker.js', import.meta.url);

export function runUiContentOperation(operation, args) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: { operation, args } });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    worker.once('message', (message) => {
      if (message?.ok) {
        finish(resolve, message.result);
        return;
      }
      const error = new Error(message?.error?.message ?? 'Atlas local processing failed.');
      if (message?.error?.code) error.code = message.error.code;
      finish(reject, error);
    });
    worker.once('error', (error) => finish(reject, error));
    worker.once('exit', (code) => {
      if (code !== 0) finish(reject, new Error(`Atlas local processing worker stopped unexpectedly (${code}).`));
    });
  });
}
