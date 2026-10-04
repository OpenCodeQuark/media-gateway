import { metadataCache } from '../cache/metadata.js';
import { config } from '../config.js';
import { metrics } from '../metrics.js';
import { googleDriveProvider } from '../providers/google-drive.js';
import {
  formatContentRange,
  formatUnsatisfiedContentRange,
  resolveByteRange,
} from '../streaming/range.js';
import { createClientAbortSignal, pipeWithBackpressure } from '../streaming/pipe.js';
import { AppError, isAppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { contentDispositionFor } from '../utils/mime.js';

let provider = googleDriveProvider;
let activeStreams = 0;

/** Swap provider (used by tests). */
export function setMediaProvider(next) {
  provider = next ?? googleDriveProvider;
}

export function getActiveStreams() {
  return activeStreams;
}

function setCommonHeaders(res, metadata) {
  res.setHeader('Content-Type', metadata.mimeType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Disposition', contentDispositionFor(metadata.mimeType, metadata.name));
  res.setHeader(
    'Cache-Control',
    metadata.cacheable ? config.mediaCacheControl : 'private, no-store',
  );
  if (metadata.etag) {
    res.setHeader('ETag', metadata.etag.startsWith('"') ? metadata.etag : `"${metadata.etag}"`);
  }
  if (metadata.modifiedTime) {
    res.setHeader('Last-Modified', new Date(metadata.modifiedTime).toUTCString());
  }
}

async function getMetadata(mediaId, signal) {
  const id = provider.resolveId(mediaId);
  const cacheKey = `${provider.name}:${id}`;

  const cached = metadataCache.get(cacheKey);
  if (cached) {
    metrics.inc('metadata_cache_hits');
    return cached;
  }

  metrics.inc('metadata_cache_misses');
  return metadataCache.getOrLoad(cacheKey, () => provider.getMetadata(id, signal));
}

export async function handleMediaRequest(req, res) {
  const started = Date.now();
  metrics.inc('requests_total');

  const rawId = String(req.params.mediaId ?? '');
  let mediaId;

  try {
    mediaId = provider.resolveId(rawId);
  } catch (error) {
    metrics.inc('requests_failed');
    throw error;
  }

  if (config.maxConcurrentStreams > 0 && activeStreams >= config.maxConcurrentStreams) {
    metrics.inc('requests_failed');
    throw new AppError('SERVICE_UNAVAILABLE', 'Too many concurrent media streams.');
  }

  const { signal, abort, cleanup } = createClientAbortSignal(req, res);
  let upstreamAbort;
  const shutdownSignal = res.locals.shutdownSignal;
  const onShutdownAbort = () => abort(new Error('Server shutting down'));
  shutdownSignal?.addEventListener('abort', onShutdownAbort);

  try {
    const metadata = await getMetadata(mediaId, signal);

    let range;
    try {
      range = resolveByteRange(req.headers.range, metadata.size);
    } catch (error) {
      if (isAppError(error) && error.code === 'RANGE_NOT_SATISFIABLE') {
        res.setHeader('Content-Range', formatUnsatisfiedContentRange(metadata.size));
        res.setHeader('Accept-Ranges', 'bytes');
      }
      throw error;
    }

    if (range) metrics.inc('range_requests');

    if (req.method === 'HEAD') {
      setCommonHeaders(res, metadata);
      if (range) {
        res.status(206);
        res.setHeader('Content-Length', String(range.length));
        res.setHeader('Content-Range', formatContentRange(range));
      } else {
        res.status(200);
        res.setHeader('Content-Length', String(metadata.size));
      }
      res.end();
      return;
    }

    const result = await provider.openStream(mediaId, { range, signal, metadata });
    upstreamAbort = result.abort;

    setCommonHeaders(res, result.metadata);
    for (const [key, value] of Object.entries(result.headers)) {
      if (!res.getHeader(key)) res.setHeader(key, value);
    }

    res.status(result.statusCode);
    res.setHeader('Content-Length', String(result.contentLength));
    if (result.contentRange) res.setHeader('Content-Range', result.contentRange);

    activeStreams += 1;
    metrics.inc('media_streams_active');

    try {
      const bytes = await pipeWithBackpressure(result.stream, res, {
        signal,
        onBytes: (n) => metrics.inc('bytes_streamed', n),
      });

      logger.info(
        {
          mediaId,
          provider: provider.name,
          status: result.statusCode,
          durationMs: Date.now() - started,
          bytes,
          range: req.headers.range,
        },
        'media stream completed',
      );
    } finally {
      activeStreams -= 1;
      metrics.inc('media_streams_active', -1);
      result.abort();
    }
  } catch (error) {
    upstreamAbort?.();

    if (signal.aborted) {
      if (res.headersSent) res.destroy();
      return;
    }

    metrics.inc('requests_failed');
    if (
      isAppError(error) &&
      (error.code === 'UPSTREAM_ERROR' || error.code === 'UPSTREAM_TIMEOUT')
    ) {
      metrics.inc('upstream_errors');
    }

    throw error;
  } finally {
    cleanup();
    shutdownSignal?.removeEventListener('abort', onShutdownAbort);
  }
}
