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
import { contentDispositionFor, isSupportedMedia } from '../utils/mime.js';

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

function cacheKeyFor(mediaId) {
  return `${provider.name}:${mediaId}`;
}

async function getMetadata(mediaId, signal) {
  const id = provider.resolveId(mediaId);
  const cacheKey = cacheKeyFor(id);

  const cached = metadataCache.get(cacheKey);
  if (cached) {
    metrics.inc('metadata_cache_hits');
    return cached;
  }

  metrics.inc('metadata_cache_misses');
  return metadataCache.getOrLoad(cacheKey, () => provider.getMetadata(id, signal));
}

/** Metadata-only helper for homepage validation (no media body). */
export async function getMetadataForInput(input, signal) {
  return getMetadata(input, signal);
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
    if (req.method === 'HEAD') {
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
      if (!isSupportedMedia(metadata.mimeType)) {
        throw new AppError('UNSUPPORTED_MEDIA', 'This file type is not supported.');
      }
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

    // GET streams immediately. Do not probe metadata or warm head/tail first —
    // that extra Drive round-trip is what kept Chromium from starting playback.
    const cached = metadataCache.get(cacheKeyFor(mediaId));
    if (cached) metrics.inc('metadata_cache_hits');

    let range;
    if (cached) {
      try {
        range = resolveByteRange(req.headers.range, cached.size);
      } catch (error) {
        if (isAppError(error) && error.code === 'RANGE_NOT_SATISFIABLE') {
          res.setHeader('Content-Range', formatUnsatisfiedContentRange(cached.size));
          res.setHeader('Accept-Ranges', 'bytes');
        }
        throw error;
      }
    }
    if (range || req.headers.range) metrics.inc('range_requests');

    const result = await provider.openStream(mediaId, {
      range: cached ? range : undefined,
      rawRangeHeader: cached ? undefined : req.headers.range,
      signal,
      metadata: cached,
    });
    upstreamAbort = result.abort;
    metadataCache.set(cacheKeyFor(mediaId), result.metadata);

    if (!isSupportedMedia(result.metadata.mimeType)) {
      throw new AppError('UNSUPPORTED_MEDIA', 'This file type is not supported.');
    }

    setCommonHeaders(res, result.metadata);
    for (const [key, value] of Object.entries(result.headers)) {
      if (!res.getHeader(key) || key === 'Accept-Ranges') res.setHeader(key, value);
    }

    res.status(result.statusCode);
    res.setHeader('Content-Length', String(result.contentLength));
    if (result.contentRange) res.setHeader('Content-Range', result.contentRange);
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

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

    if (
      isAppError(error) &&
      error.code === 'RANGE_NOT_SATISFIABLE' &&
      !res.headersSent &&
      Number.isFinite(error.details?.total)
    ) {
      res.setHeader('Content-Range', formatUnsatisfiedContentRange(error.details.total));
      res.setHeader('Accept-Ranges', 'bytes');
    }

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
