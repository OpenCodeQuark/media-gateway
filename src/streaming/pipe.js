import { pipeline } from 'node:stream/promises';

/** Pipe with backpressure; respects AbortSignal (client disconnect / shutdown). */
export async function pipeWithBackpressure(source, destination, options = {}) {
  let bytes = 0;

  const onData = (chunk) => {
    const n = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    bytes += n;
    options.onBytes?.(n);
  };

  source.on('data', onData);
  try {
    await pipeline(source, destination, { signal: options.signal, end: true });
    return bytes;
  } finally {
    source.off('data', onData);
  }
}

/** Abort upstream work when the HTTP client disconnects mid-stream. */
export function createClientAbortSignal(req, res, parent) {
  const controller = new AbortController();

  const abort = (reason) => {
    if (!controller.signal.aborted) {
      controller.abort(reason ?? new Error('Client disconnected'));
    }
  };

  // Prefer response close: request close can fire on keep-alive quirks.
  const onClose = () => {
    if (!res.writableEnded) abort(new Error('Client disconnected'));
  };

  const onParentAbort = () => abort(parent?.reason ?? new Error('Aborted'));

  res.once('close', onClose);
  parent?.addEventListener('abort', onParentAbort);

  return {
    signal: controller.signal,
    abort,
    cleanup() {
      res.off('close', onClose);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}
