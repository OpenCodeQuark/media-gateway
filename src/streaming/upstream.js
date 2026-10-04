import { Readable } from 'node:stream';
import { config } from '../config.js';
import { AppError } from '../utils/errors.js';

const ALLOWED_HOSTS = new Set([
  'drive.google.com',
  'drive.usercontent.google.com',
  'www.googleapis.com',
  'oauth2.googleapis.com',
  'www.google.com',
  'docs.google.com',
]);

const MAX_REDIRECTS = 5;

export function assertAllowedUpstreamUrl(url) {
  if (url.protocol !== 'https:') {
    throw new AppError('BAD_REQUEST', 'Only HTTPS upstream URLs are allowed.');
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new AppError('BAD_REQUEST', 'Upstream host is not allowed.', {
      details: { host: url.hostname },
    });
  }
}

function combineSignals(signals) {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}

/**
 * Fetch an allow-listed upstream URL.
 * Redirects are followed manually so each hop stays on approved HTTPS hosts (SSRF).
 */
export async function upstreamFetch(inputUrl, options = {}) {
  let url = typeof inputUrl === 'string' ? new URL(inputUrl) : new URL(inputUrl.href);
  const connectTimeoutMs = options.connectTimeoutMs ?? config.upstreamConnectTimeoutMs;
  const signal = combineSignals([options.signal]);

  let response;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertAllowedUpstreamUrl(url);

    const connectController = new AbortController();
    const connectTimer = setTimeout(() => {
      connectController.abort(new AppError('UPSTREAM_TIMEOUT', 'Upstream connection timed out.'));
    }, connectTimeoutMs);
    const hopSignal = combineSignals([signal, connectController.signal]);

    try {
      response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: options.headers,
        body: hop === 0 ? options.body : undefined,
        redirect: 'manual',
        signal: hopSignal,
      });
    } catch (error) {
      clearTimeout(connectTimer);
      if (error instanceof AppError) throw error;
      if (signal.aborted || connectController.signal.aborted) {
        throw new AppError('UPSTREAM_TIMEOUT', 'Upstream request timed out or was aborted.', {
          cause: error,
        });
      }
      throw new AppError('UPSTREAM_ERROR', 'Failed to reach upstream media provider.', {
        cause: error,
      });
    } finally {
      clearTimeout(connectTimer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await cancelBody(response);
      if (!location) {
        throw new AppError('UPSTREAM_ERROR', 'Upstream redirect missing Location header.');
      }
      let next;
      try {
        next = new URL(location, url);
      } catch {
        throw new AppError('UPSTREAM_ERROR', 'Upstream returned an invalid redirect URL.');
      }
      url = next;
      continue;
    }

    break;
  }

  if (!response) {
    throw new AppError('UPSTREAM_ERROR', 'Upstream request failed.');
  }

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    await cancelBody(response);
    throw new AppError('UPSTREAM_ERROR', 'Too many upstream redirects.');
  }

  let body = null;
  let idleTimer;
  const idleTimeoutMs = options.idleTimeoutMs ?? config.upstreamIdleTimeoutMs;
  const localAbort = new AbortController();

  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const resetIdle = () => {
    clearIdle();
    if (!idleTimeoutMs) return;
    idleTimer = setTimeout(() => {
      localAbort.abort(new AppError('UPSTREAM_TIMEOUT', 'Upstream idle timeout exceeded.'));
      body?.destroy(new AppError('UPSTREAM_TIMEOUT', 'Upstream idle timeout exceeded.'));
    }, idleTimeoutMs);
  };

  if (response.body) {
    const webStream = response.body;
    body = Readable.fromWeb(webStream);
    body.on('data', resetIdle);
    body.on('end', clearIdle);
    body.on('close', clearIdle);
    body.on('error', clearIdle);
    resetIdle();

    const nodeBody = body;
    const onAbort = () => {
      clearIdle();
      if (nodeBody && !nodeBody.destroyed) nodeBody.destroy();
      webStream.cancel().catch(() => undefined);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    localAbort.signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    status: response.status,
    headers: response.headers,
    body,
    url: url.toString(),
    abort() {
      clearIdle();
      localAbort.abort();
      if (body && !body.destroyed) body.destroy();
    },
  };
}

export async function readUpstreamText(response, maxBytes = 64_000) {
  if (!response.body) return '';

  const chunks = [];
  let total = 0;

  for await (const chunk of response.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      response.abort();
      break;
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks).toString('utf8');
}
