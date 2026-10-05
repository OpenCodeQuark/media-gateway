import { PassThrough } from 'node:stream';
import { config } from '../config.js';
import { openFragmentedMp4 } from '../streaming/fmp4-play.js';
import { getPlaybackSession, hasPlaybackSession, openPlaybackSlice } from '../streaming/play-start.js';
import { formatContentRange, parseRangeHeader } from '../streaming/range.js';
import { readUpstreamText, upstreamFetch } from '../streaming/upstream.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { sanitizeMimeType } from '../utils/mime.js';

const USER_AGENT = 'media-gateway/0.2.0';
const DRIVE_FILE_ID = /^[a-zA-Z0-9_-]{10,128}$/;
const DRIVE_HOSTS = new Set(['drive.google.com', 'docs.google.com']);

let cachedTokens = null;

/** Confirmed media download URLs (post virus-scan). Avoids repeating the interstitial on every Range request. */
const confirmedDownloads = new Map();
const CONFIRM_CACHE_TTL_MS = 15 * 60 * 1000;

function getCachedDownloadUrl(fileId) {
  const entry = confirmedDownloads.get(fileId);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    confirmedDownloads.delete(fileId);
    return undefined;
  }
  return entry.url;
}

function cacheDownloadUrl(fileId, url) {
  if (!fileId || !url) return;
  confirmedDownloads.set(fileId, { url, expiresAt: Date.now() + CONFIRM_CACHE_TTL_MS });
}

/** Test helper */
export function clearConfirmedDownloadCache() {
  confirmedDownloads.clear();
}

/** Extract and normalize a Google Drive file ID. Rejects arbitrary URLs (SSRF). */
export function parseGoogleDriveId(input) {
  const value = input?.trim();
  if (!value) {
    throw new AppError('INVALID_MEDIA_ID', 'Media ID is required.');
  }

  if (value.includes('://') || value.startsWith('//')) {
    return extractFromUrl(value.startsWith('//') ? `https:${value}` : value);
  }

  if (value.includes('..') || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new AppError('INVALID_MEDIA_ID', 'Invalid media identifier.');
  }

  if (!DRIVE_FILE_ID.test(value)) {
    throw new AppError('INVALID_MEDIA_ID', 'Invalid Google Drive file ID.');
  }

  return value;
}

function extractFromUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('INVALID_MEDIA_ID', 'Invalid Google Drive URL.');
  }

  if (url.protocol !== 'https:') {
    throw new AppError('INVALID_MEDIA_ID', 'Only HTTPS Google Drive URLs are allowed.');
  }

  if (!DRIVE_HOSTS.has(url.hostname)) {
    throw new AppError('INVALID_MEDIA_ID', 'URL host is not an allowed Google Drive domain.', {
      details: { host: url.hostname },
    });
  }

  const fileMatch = url.pathname.match(/\/file\/d\/([^/]+)/);
  if (fileMatch?.[1]) return assertDriveId(decodeURIComponent(fileMatch[1]));

  const idParam = url.searchParams.get('id');
  if (idParam) return assertDriveId(idParam);

  throw new AppError('INVALID_MEDIA_ID', 'Could not extract a Google Drive file ID from URL.');
}

function assertDriveId(id) {
  const trimmed = id.trim();
  if (!DRIVE_FILE_ID.test(trimmed) || trimmed.includes('..')) {
    throw new AppError('INVALID_MEDIA_ID', 'Invalid Google Drive file ID.');
  }
  return trimmed;
}

function hasOAuthConfig() {
  return Boolean(config.googleClientId && config.googleClientSecret && config.googleRefreshToken);
}

async function getAccessToken(signal) {
  if (!hasOAuthConfig()) return undefined;
  if (cachedTokens && cachedTokens.expiresAt > Date.now() + 60_000) {
    return cachedTokens.accessToken;
  }

  const body = new URLSearchParams({
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    refresh_token: config.googleRefreshToken,
    grant_type: 'refresh_token',
  });

  const response = await upstreamFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body,
    signal,
    connectTimeoutMs: config.upstreamMetadataTimeoutMs,
  });

  if (response.status >= 400) {
    response.abort();
    throw new AppError('UPSTREAM_ERROR', 'Failed to refresh Google OAuth token.');
  }

  const json = JSON.parse(await readUpstreamText(response));
  if (!json.access_token) {
    throw new AppError('UPSTREAM_ERROR', 'Google OAuth response missing access token.');
  }

  cachedTokens = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return cachedTokens.accessToken;
}

async function authHeaders(signal) {
  const headers = { 'User-Agent': USER_AGENT };
  const token = await getAccessToken(signal);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function buildDownloadUrl(fileId) {
  const url = new URL('https://drive.usercontent.google.com/download');
  url.searchParams.set('id', fileId);
  url.searchParams.set('export', 'download');
  // Skip the virus-scan HTML interstitial when Drive accepts a direct confirm.
  url.searchParams.set('confirm', 't');
  return url.toString();
}

function buildAltDownloadUrl(fileId) {
  const url = new URL('https://drive.google.com/uc');
  url.searchParams.set('id', fileId);
  url.searchParams.set('export', 'download');
  return url.toString();
}

/** Large public files may return an HTML virus-scan page with confirm/uuid tokens. */
export function extractConfirmParams(html) {
  const confirmMatch =
    html.match(/confirm=([0-9A-Za-z_-]+)/) || html.match(/name="confirm"\s+value="([^"]+)"/);
  if (!confirmMatch?.[1]) return null;
  const uuidMatch = html.match(/name="uuid"\s+value="([^"]+)"/);
  return { confirm: confirmMatch[1], uuid: uuidMatch?.[1] };
}

function mapDriveStatusToError(status) {
  if (status === 404) return new AppError('MEDIA_NOT_FOUND', 'Media could not be found.');
  if (status === 401) return new AppError('UNAUTHORIZED', 'Upstream authentication failed.');
  if (status === 403) return new AppError('FORBIDDEN', 'Access to this media is forbidden.');
  if (status === 429) return new AppError('TOO_MANY_REQUESTS', 'Upstream rate limit exceeded.');
  return new AppError('UPSTREAM_ERROR', 'Upstream media provider returned an error.', {
    details: { status },
  });
}

async function fetchDriveMetadata(fileId, signal) {
  if (!config.googleApiKey && !hasOAuthConfig()) return null;

  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set('fields', 'id,name,mimeType,size,modifiedTime,md5Checksum');
  url.searchParams.set('supportsAllDrives', 'true');
  if (config.googleApiKey && !hasOAuthConfig()) {
    url.searchParams.set('key', config.googleApiKey);
  }

  const response = await upstreamFetch(url, {
    headers: await authHeaders(signal),
    signal,
    connectTimeoutMs: config.upstreamMetadataTimeoutMs,
    idleTimeoutMs: config.upstreamMetadataTimeoutMs,
  });

  if (response.status === 404) {
    response.abort();
    throw new AppError('MEDIA_NOT_FOUND', 'Media could not be found.');
  }
  if (response.status === 401 || response.status === 403) {
    response.abort();
    throw new AppError('FORBIDDEN', 'Access to this Google Drive file is forbidden.');
  }
  if (response.status >= 400) {
    response.abort();
    throw new AppError('UPSTREAM_ERROR', 'Google Drive metadata request failed.', {
      details: { status: response.status },
    });
  }

  return JSON.parse(await readUpstreamText(response));
}

function buildConfirmedUrl(fileId, confirm, useAlt) {
  const url = new URL(useAlt ? buildAltDownloadUrl(fileId) : buildDownloadUrl(fileId));
  url.searchParams.set('confirm', confirm.confirm);
  if (confirm.uuid) url.searchParams.set('uuid', confirm.uuid);
  return url.toString();
}

function isHtmlResponse(response) {
  const contentType = response.headers.get('content-type') ?? '';
  return contentType.includes('text/html');
}

function rememberMediaUrl(fileId, response) {
  if (response.status < 400 && response.url && !isHtmlResponse(response)) {
    cacheDownloadUrl(fileId, response.url);
  }
}

async function fetchConfirmed(fileId, confirm, headers, signal, useAlt) {
  const confirmedUrl = buildConfirmedUrl(fileId, confirm, useAlt);
  const response = await upstreamFetch(confirmedUrl, { headers, signal });
  if (response.status < 400 && !isHtmlResponse(response)) {
    cacheDownloadUrl(fileId, confirmedUrl);
  }
  return response;
}

async function downloadWithConfirm(fileId, headers, signal) {
  // Reuse post-confirm URL so Chromium's many Range requests skip the virus-scan HTML each time.
  const cachedUrl = getCachedDownloadUrl(fileId);
  if (cachedUrl) {
    const cachedResponse = await upstreamFetch(cachedUrl, { headers, signal });
    if (cachedResponse.status < 400 && !isHtmlResponse(cachedResponse)) {
      return cachedResponse;
    }
    cachedResponse.abort();
    confirmedDownloads.delete(fileId);
  }

  let response = await upstreamFetch(buildDownloadUrl(fileId), { headers, signal });

  if (response.status === 200 && isHtmlResponse(response) && response.body) {
    const html = await readUpstreamText(response);
    const confirm = extractConfirmParams(html);
    if (!confirm) {
      response = await upstreamFetch(buildAltDownloadUrl(fileId), { headers, signal });
      const altType = response.headers.get('content-type') ?? '';
      if (response.status === 200 && altType.includes('text/html') && response.body) {
        const altConfirm = extractConfirmParams(await readUpstreamText(response));
        if (!altConfirm) {
          throw new AppError(
            'FORBIDDEN',
            'Google Drive requires interactive confirmation or the file is not publicly accessible.',
          );
        }
        return fetchConfirmed(fileId, altConfirm, headers, signal, true);
      }
      rememberMediaUrl(fileId, response);
      return response;
    }
    return fetchConfirmed(fileId, confirm, headers, signal, false);
  }

  rememberMediaUrl(fileId, response);
  return response;
}

async function openDriveDownload({ fileId, rangeHeader, signal }) {
  const headers = await authHeaders(signal);
  if (rangeHeader) headers.Range = rangeHeader;

  if (hasOAuthConfig()) {
    const apiUrl = new URL(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
    );
    apiUrl.searchParams.set('alt', 'media');
    apiUrl.searchParams.set('supportsAllDrives', 'true');

    const apiResponse = await upstreamFetch(apiUrl, { headers, signal });

    if (apiResponse.status !== 401 && apiResponse.status !== 403) {
      return apiResponse;
    }
    apiResponse.abort();
    logger.warn(
      { fileId, status: apiResponse.status },
      'Drive API media denied; falling back to public download',
    );
  }

  return downloadWithConfirm(fileId, headers, signal);
}

function nameFromDisposition(header) {
  if (!header) return undefined;
  const utf = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf?.[1]) {
    try {
      return decodeURIComponent(utf[1]);
    } catch {
      return utf[1];
    }
  }
  return header.match(/filename="?([^";]+)"?/i)?.[1];
}

async function probeViaRange(fileId, signal) {
  const response = await openDriveDownload({
    fileId,
    rangeHeader: 'bytes=0-0',
    signal,
  });

  try {
    if (response.status === 404) throw mapDriveStatusToError(404);
    if (response.status >= 400) throw mapDriveStatusToError(response.status);

    const contentType = response.headers.get('content-type') ?? undefined;
    const contentRange = response.headers.get('content-range');
    const contentLength = response.headers.get('content-length');
    const etag = response.headers.get('etag') ?? undefined;
    const contentDisposition = response.headers.get('content-disposition') ?? undefined;

    let size = 0;
    const rangeTotal = contentRange?.match(/\/(\d+)\s*$/)?.[1];
    if (rangeTotal) size = Number(rangeTotal);

    if (!size && contentLength) {
      const len = Number(contentLength);
      if (response.status === 200 && Number.isFinite(len)) size = len;
    }

    response.abort();

    if (!size || !Number.isFinite(size)) {
      const full = await openDriveDownload({ fileId, signal });
      try {
        if (full.status >= 400) throw mapDriveStatusToError(full.status);
        const lenHeader = full.headers.get('content-length');
        const parsed = lenHeader ? Number(lenHeader) : NaN;
        full.abort();
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new AppError('UPSTREAM_ERROR', 'Unable to determine media size from Google Drive.');
        }
        return {
          mimeType: sanitizeMimeType(
            full.headers.get('content-type') ?? contentType,
            nameFromDisposition(full.headers.get('content-disposition') ?? contentDisposition),
          ),
          size: parsed,
          etag: full.headers.get('etag') ?? etag,
          name: nameFromDisposition(full.headers.get('content-disposition') ?? contentDisposition),
        };
      } catch (error) {
        full.abort();
        throw error;
      }
    }

    return {
      mimeType: sanitizeMimeType(contentType, nameFromDisposition(contentDisposition)),
      size,
      etag,
      name: nameFromDisposition(contentDisposition),
    };
  } catch (error) {
    response.abort();
    throw error;
  }
}

function wrapUpstreamStream(response) {
  if (!response.body) {
    response.abort();
    throw new AppError('UPSTREAM_ERROR', 'Upstream returned an empty body.');
  }

  const pass = new PassThrough();
  const upstream = response.body;

  const abort = () => {
    response.abort();
    if (!upstream.destroyed) upstream.destroy();
    if (!pass.destroyed) pass.destroy();
  };

  upstream.on('error', (err) => {
    if (!pass.destroyed) pass.destroy(err);
  });
  pass.on('error', () => abort());
  upstream.pipe(pass);

  return { stream: pass, abort };
}

async function openStructured(fileId, rangeHeader, signal) {
  const response = await openDriveDownload({ fileId, rangeHeader, signal });
  if (response.status === 416) {
    response.abort();
    throw new AppError('RANGE_NOT_SATISFIABLE', 'Range not satisfiable.');
  }
  if (response.status >= 400) {
    response.abort();
    throw mapDriveStatusToError(response.status);
  }

  const contentRange = response.headers.get('content-range');
  const totalFromRange = Number(contentRange?.match(/\/(\d+)\s*$/)?.[1]);
  const contentLength = Number(response.headers.get('content-length'));
  const total =
    Number.isFinite(totalFromRange) && totalFromRange > 0
      ? totalFromRange
      : Number.isFinite(contentLength)
        ? contentLength
        : 0;
  const name = nameFromDisposition(response.headers.get('content-disposition'));
  const { stream, abort } = wrapUpstreamStream(response);
  return {
    stream,
    abort,
    total,
    contentType: sanitizeMimeType(response.headers.get('content-type'), name),
    name,
    etag: response.headers.get('etag') ?? undefined,
  };
}

/** Byte span for a client request. Suffix and multi-ranges are fetched directly. */
function startupSpan(options) {
  if (options.range) {
    const { start, end } = options.range;
    return { start, end, full: false };
  }
  if (!options.rawRangeHeader) return { start: 0, end: null, full: true };
  let parsed;
  try {
    parsed = parseRangeHeader(options.rawRangeHeader);
  } catch {
    return null;
  }
  if (!parsed || parsed.isSuffix || parsed.start === undefined) return null;
  return { start: parsed.start, end: parsed.end ?? null, full: false };
}

async function maybeFastStart(fileId, options) {
  const fragmented = await openFragmentedMp4(fileId, options, (rangeHeader, signal) =>
    openStructured(fileId, rangeHeader, signal),
  );
  if (fragmented) return fragmented;

  const span = startupSpan(options);
  if (!span) return null;

  const existing = hasPlaybackSession(fileId);
  // Only the first start-at-0 request opens the shared download. Later ranges
  // (Chromium seeking to the first sample) read that same download.
  if (!existing && span.start !== 0) return null;

  const session = getPlaybackSession(fileId, (rangeHeader, signal) =>
    openStructured(fileId, rangeHeader, signal),
  );
  const slice = await openPlaybackSlice(session, { start: span.start, end: span.end });
  if (!slice) return null;

  const start = span.start;
  const end = start + slice.contentLength - 1;
  const metadata = {
    id: fileId,
    provider: 'google-drive',
    name: session.name,
    mimeType: session.contentType,
    size: slice.total,
    etag: session.etag,
    cacheable: true,
  };

  const ranged = Boolean(options.range || options.rawRangeHeader);

  return {
    stream: slice.stream,
    metadata,
    statusCode: ranged ? 206 : 200,
    contentLength: slice.contentLength,
    contentRange: ranged
      ? formatContentRange({ start, end, length: slice.contentLength, total: slice.total })
      : undefined,
    headers: {
      'Content-Type': session.contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': config.mediaCacheControl,
    },
    abort: slice.abort,
  };
}

export const googleDriveProvider = {
  name: 'google-drive',

  resolveId(input) {
    return parseGoogleDriveId(input);
  },

  async getMetadata(id, signal) {
    const fileId = parseGoogleDriveId(id);
    const apiMeta = await fetchDriveMetadata(fileId, signal);

    if (apiMeta) {
      const size = apiMeta.size !== undefined ? Number(apiMeta.size) : NaN;
      if (!Number.isFinite(size)) {
        const probed = await probeViaRange(fileId, signal);
        return {
          id: fileId,
          provider: this.name,
          name: apiMeta.name ?? probed.name,
          mimeType: sanitizeMimeType(apiMeta.mimeType ?? probed.mimeType, apiMeta.name),
          size: probed.size,
          etag: apiMeta.md5Checksum ?? probed.etag,
          modifiedTime: apiMeta.modifiedTime,
          cacheable: true,
        };
      }

      return {
        id: fileId,
        provider: this.name,
        name: apiMeta.name,
        mimeType: sanitizeMimeType(apiMeta.mimeType, apiMeta.name),
        size,
        etag: apiMeta.md5Checksum,
        modifiedTime: apiMeta.modifiedTime,
        cacheable: true,
      };
    }

    const probed = await probeViaRange(fileId, signal);
    return {
      id: fileId,
      provider: this.name,
      name: probed.name,
      mimeType: probed.mimeType,
      size: probed.size,
      etag: probed.etag,
      cacheable: true,
    };
  },

  async openStream(id, options = {}) {
    const fileId = parseGoogleDriveId(id);
    const rangeHeader =
      options.rawRangeHeader ||
      (options.range ? `bytes=${options.range.start}-${options.range.end}` : undefined);

    const fast = await maybeFastStart(fileId, options);
    if (fast) return fast;

    let metadata = options.metadata;
    if (!metadata && !options.rawRangeHeader) {
      metadata = await this.getMetadata(fileId, options.signal);
    }

    const response = await openDriveDownload({
      fileId,
      rangeHeader,
      signal: options.signal,
    });

    const contentRangeHeader = response.headers.get('content-range');
    const totalFromRange = Number(contentRangeHeader?.match(/\/(\d+)\s*$/)?.[1]);
    const upstreamLength = Number(response.headers.get('content-length'));
    const contentType = sanitizeMimeType(
      response.headers.get('content-type') ?? metadata?.mimeType,
      metadata?.name || nameFromDisposition(response.headers.get('content-disposition')),
    );

    if (!metadata) {
      const size =
        Number.isFinite(totalFromRange) && totalFromRange > 0
          ? totalFromRange
          : response.status === 200 && Number.isFinite(upstreamLength)
            ? upstreamLength
            : NaN;
      if (!Number.isFinite(size)) {
        response.abort();
        throw new AppError('UPSTREAM_ERROR', 'Unable to determine media size from Google Drive.');
      }
      metadata = {
        id: fileId,
        provider: this.name,
        name: nameFromDisposition(response.headers.get('content-disposition')),
        mimeType: contentType,
        size,
        etag: response.headers.get('etag') ?? undefined,
        cacheable: true,
      };
    }

    if (response.status === 416) {
      response.abort();
      throw new AppError('RANGE_NOT_SATISFIABLE', 'Range not satisfiable.', {
        details: { total: metadata.size },
      });
    }

    if (response.status >= 400) {
      response.abort();
      throw mapDriveStatusToError(response.status);
    }

    const wantsPartial = Boolean(rangeHeader);
    // Refuse to buffer whole files when upstream ignores Range on large media.
    if (wantsPartial && response.status === 200) {
      const acceptRanges = response.headers.get('accept-ranges');
      if (acceptRanges?.toLowerCase() === 'none') {
        response.abort();
        throw new AppError(
          'UPSTREAM_ERROR',
          'Upstream does not support byte ranges for this media.',
        );
      }
      const expected =
        options.range?.length ??
        (Number.isFinite(upstreamLength) ? upstreamLength : Number.NaN);
      if (
        Number.isFinite(upstreamLength) &&
        upstreamLength === metadata.size &&
        Number.isFinite(expected) &&
        metadata.size > expected
      ) {
        response.abort();
        throw new AppError(
          'UPSTREAM_ERROR',
          'Upstream ignored Range request; refusing to buffer entire media file.',
        );
      }
    }

    const { stream, abort } = wrapUpstreamStream(response);

    let statusCode = response.status === 206 ? 206 : 200;
    let contentLength;
    let contentRange;

    if (wantsPartial) {
      statusCode = 206;
      contentRange =
        contentRangeHeader ||
        (options.range ? formatContentRange(options.range) : undefined);
      contentLength = Number.isFinite(upstreamLength)
        ? upstreamLength
        : options.range?.length;
      if (!Number.isFinite(contentLength)) {
        abort();
        throw new AppError('UPSTREAM_ERROR', 'Upstream range response missing Content-Length.');
      }
      if (!contentRange) {
        abort();
        throw new AppError('UPSTREAM_ERROR', 'Upstream range response missing Content-Range.');
      }
    } else {
      contentLength = Number.isFinite(upstreamLength) ? upstreamLength : metadata.size;
    }

    const headers = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': metadata.cacheable ? config.mediaCacheControl : 'private, no-store',
    };

    if (metadata.etag) {
      headers.ETag = metadata.etag.startsWith('"') ? metadata.etag : `"${metadata.etag}"`;
    }
    if (metadata.modifiedTime) {
      headers['Last-Modified'] = new Date(metadata.modifiedTime).toUTCString();
    }

    return {
      stream,
      metadata: { ...metadata, mimeType: contentType },
      statusCode,
      contentLength,
      contentRange,
      headers,
      abort,
    };
  },
};
