import { PassThrough, Transform } from 'node:stream';
import { config } from '../config.js';
import { AppError } from '../utils/errors.js';
import { formatContentRange, parseRangeHeader } from './range.js';
import {
  buildFragmentIndex,
  findMoovEnd,
  headProbeBytes,
  mvhdDuration,
  nearestMoof,
  patchFragmentBuffer,
} from './fmp4.js';

/** How much of the virtual file to keep so the next play does not wait on Drive. */
const HEAD_CACHE = 1024 * 1024;
const MOOV_HOLD = 256 * 1024;

const cache = new Map();
const inflight = new Map();

export function clearFragmentedMp4Cache() {
  cache.clear();
  inflight.clear();
}

function looksLikeMp4(buf) {
  return buf.length >= 8 && buf.toString('ascii', 4, 8) === 'ftyp';
}

async function readStream(stream, max) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.from(chunk);
    chunks.push(buf);
    total += buf.length;
    if (total >= max) break;
  }
  return Buffer.concat(chunks).subarray(0, Math.min(total, max));
}

function bufferUntilMoov(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    const finish = (buffered) => {
      stream.pause();
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      resolve({ buffered, stream });
    };

    const onData = (chunk) => {
      const buf = Buffer.from(chunk);
      chunks.push(buf);
      size += buf.length;
      const all = Buffer.concat(chunks);
      if (!looksLikeMp4(all) && all.length >= 12) {
        finish(all);
        return;
      }
      if (findMoovEnd(all) || size >= MOOV_HOLD) finish(all);
    };
    const onEnd = () => finish(Buffer.concat(chunks));
    const onError = (error) => {
      stream.off('data', onData);
      reject(error);
    };

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.resume();
  });
}

class BoxPatch extends Transform {
  constructor(delta) {
    super();
    this.delta = delta;
    this.buf = Buffer.alloc(0);
  }

  _transform(chunk, _enc, cb) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this.drain();
    cb();
  }

  _flush(cb) {
    if (this.buf.length) this.push(this.buf);
    this.buf = Buffer.alloc(0);
    cb();
  }

  drain() {
    while (this.buf.length >= 8) {
      const size = this.buf.readUInt32BE(0);
      if (size < 8 || size > 16_000_000) {
        this.push(this.buf);
        this.buf = Buffer.alloc(0);
        return;
      }
      if (this.buf.length < size) return;
      const box = this.buf.subarray(0, size);
      this.buf = this.buf.subarray(size);
      const type = box.toString('ascii', 4, 8);
      if (type === 'moof' || type === 'mfra') this.push(patchFragmentBuffer(box, this.delta));
      else this.push(box);
    }
  }
}

class SkipBytes extends Transform {
  constructor(count) {
    super();
    this.left = count;
  }

  _transform(chunk, _enc, cb) {
    if (this.left <= 0) {
      this.push(chunk);
      cb();
      return;
    }
    if (chunk.length <= this.left) {
      this.left -= chunk.length;
      cb();
      return;
    }
    this.push(chunk.subarray(this.left));
    this.left = 0;
    cb();
  }
}

class RememberHead extends Transform {
  constructor(index) {
    super();
    this.index = index;
    this.filled = index.head?.length ?? 0;
    this.extra = [];
  }

  _transform(chunk, _enc, cb) {
    if (this.filled < HEAD_CACHE) {
      const take = Math.min(chunk.length, HEAD_CACHE - this.filled);
      this.extra.push(chunk.subarray(0, take));
      this.filled += take;
      if (this.filled >= HEAD_CACHE) this.publish();
    }
    cb(null, chunk);
  }

  _flush(cb) {
    if (this.extra.length) this.publish();
    cb();
  }

  publish() {
    const base = this.index.head ?? Buffer.alloc(0);
    this.index.head = Buffer.concat([base, ...this.extra]);
    this.extra = [];
  }
}

function requestSpan(options, total) {
  const header = options.rawRangeHeader;
  if (!header && !options.range) {
    if (!total) return { start: 0, end: null };
    return { start: 0, end: total - 1, open: false, full: true };
  }
  if (options.range) {
    return {
      start: options.range.start,
      end: options.range.end,
      open: false,
      full: false,
    };
  }
  const parsed = parseRangeHeader(header);
  if (!parsed) return { start: 0, end: null, open: true, full: false };
  if (parsed.isSuffix) {
    if (!total) return null;
    const suffix = Math.min(parsed.suffixLength, total);
    return { start: total - suffix, end: total - 1, open: false, full: false };
  }
  return {
    start: parsed.start,
    end: parsed.end ?? null,
    open: parsed.end === undefined,
    full: false,
  };
}

function describe(fileId, upstream, index, total) {
  return {
    id: fileId,
    provider: 'google-drive',
    name: upstream.name,
    mimeType: upstream.contentType,
    size: total,
    etag: upstream.etag,
    cacheable: true,
  };
}

function responseFrom({ stream, abort, metadata, start, end, total, ranged }) {
  const length = end - start + 1;
  return {
    stream,
    abort,
    metadata,
    statusCode: ranged ? 206 : 200,
    contentLength: length,
    contentRange: ranged ? formatContentRange({ start, end, length, total }) : undefined,
    headers: {
      'Content-Type': metadata.mimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': config.mediaCacheControl,
    },
  };
}

function rawReplay(fileId, upstream, buffered, options) {
  const total = upstream.total;
  const span = requestSpan(options, total) ?? { start: 0, end: null, open: true };
  const last = span.end == null ? total - 1 : Math.min(span.end, total - 1);
  if (last < span.start || span.start >= total) {
    upstream.abort?.();
    throw new AppError('RANGE_NOT_SATISFIABLE', 'Range not satisfiable.', { details: { total } });
  }

  const pass = new PassThrough();
  const abort = () => {
    upstream.abort?.();
    if (!pass.destroyed) pass.destroy();
  };
  options.signal?.addEventListener('abort', abort, { once: true });

  let sent = 0;
  const needed = last - span.start + 1;
  const write = (buf) => {
    if (sent >= needed || pass.destroyed) return;
    const from = span.start > sent ? span.start - sent : 0;
    const slice = buf.subarray(from);
    const take = slice.subarray(0, needed - sent);
    if (!take.length) {
      sent += buf.length;
      return;
    }
    sent += from + take.length;
    pass.write(take);
  };

  write(buffered);
  if (sent >= needed) {
    pass.end();
    upstream.abort?.();
  } else {
    upstream.stream.on('data', (chunk) => {
      write(Buffer.from(chunk));
      if (sent >= needed) {
        pass.end();
        abort();
      }
    });
    upstream.stream.on('end', () => {
      if (!pass.writableEnded) pass.end();
    });
    upstream.stream.on('error', (error) => pass.destroy(error));
    upstream.stream.resume();
  }

  const ranged = Boolean(options.range || options.rawRangeHeader);
  return responseFrom({
    stream: pass,
    abort,
    metadata: describe(fileId, upstream, null, total),
    start: span.start,
    end: last,
    total,
    ranged,
  });
}

async function classify(fileId, fetchUpstream, signal) {
  const [headRes, tailRes] = await Promise.all([
    fetchUpstream(`bytes=0-${headProbeBytes() - 1}`, signal),
    fetchUpstream(`bytes=-${headProbeBytes()}`, signal),
  ]);
  try {
    const head = await readStream(headRes.stream, headProbeBytes());
    const tail = await readStream(tailRes.stream, headProbeBytes());
    const index = buildFragmentIndex(head, tail, headRes.total || tailRes.total);
    if (!index) {
      cache.set(fileId, { negative: true });
      return null;
    }
    index.head = index.prefix;
    index.contentType = headRes.contentType;
    index.name = headRes.name;
    index.etag = headRes.etag;
    cache.set(fileId, { index });
    return index;
  } finally {
    headRes.abort?.();
    tailRes.abort?.();
  }
}

function serveIndexed(fileId, index, options, fetchUpstream) {
  const total = index.virtualSize;
  const span = requestSpan(options, total);
  if (!span) return null;
  const last = span.end == null ? total - 1 : Math.min(span.end, total - 1);
  if (span.start >= total || last < span.start) {
    throw new AppError('RANGE_NOT_SATISFIABLE', 'Range not satisfiable.', { details: { total } });
  }

  const pass = new PassThrough();
  let upstreamAbort = () => {};
  const abort = () => {
    upstreamAbort();
    if (!pass.destroyed) pass.destroy();
  };
  options.signal?.addEventListener('abort', abort, { once: true });

  const produce = async () => {
    const head = index.head ?? Buffer.alloc(0);
    const cacheEnd = Math.min(last, head.length - 1);
    if (span.start <= cacheEnd) pass.write(head.subarray(span.start, cacheEnd + 1));
    if (last < head.length) {
      pass.end();
      return;
    }

    const bodyStart = Math.max(span.start, head.length);
    const origStart = bodyStart - index.sidxLen;
    const origEnd = last - index.sidxLen;
    const aligned = nearestMoof(index.moofs, origStart);
    const open = span.end == null && last === total - 1;
    const range = open ? `bytes=${aligned}-` : `bytes=${aligned}-${origEnd}`;
    const upstream = await fetchUpstream(range, options.signal);
    upstreamAbort = () => upstream.abort?.();
    const skip = origStart - aligned;
    const source = upstream.stream;
    const patch = new BoxPatch(index.sidxLen);
    const remember = bodyStart === head.length && span.start === 0 ? new RememberHead(index) : new PassThrough();
    const skipper = new SkipBytes(skip);
    const onError = (error) => {
      if (!pass.destroyed) pass.destroy(error);
    };
    source.on('error', onError);
    skipper.on('error', onError);
    patch.on('error', onError);
    source.pipe(patch).pipe(skipper).pipe(remember).pipe(pass);
  };

  produce().catch((error) => {
    if (!pass.destroyed) pass.destroy(error);
  });

  const ranged = Boolean(options.range || options.rawRangeHeader);
  return responseFrom({
    stream: pass,
    abort,
    metadata: describe(
      fileId,
      { name: index.name, contentType: index.contentType, etag: index.etag },
      index,
      total,
    ),
    start: span.start,
    end: last,
    total,
    ranged,
  });
}

async function coldPlay(fileId, options, fetchUpstream) {
  const signal = options.signal;
  let resolveIndex;
  const indexReady = new Promise((resolve) => {
    resolveIndex = resolve;
  });
  inflight.set(fileId, indexReady);
  let settled = false;
  const finishIndex = (index) => {
    if (settled) return;
    settled = true;
    resolveIndex(index);
    inflight.delete(fileId);
  };
  const tailPromise = fetchUpstream(`bytes=-${headProbeBytes()}`, signal);
  let head;
  try {
    head = await fetchUpstream('bytes=0-', signal);
  } catch (error) {
    finishIndex(null);
    tailPromise.then((tail) => tail?.abort?.()).catch(() => undefined);
    throw error;
  }
  const held = await bufferUntilMoov(head.stream);
  const buffered = held.buffered;
  const moovEnd = looksLikeMp4(buffered) ? findMoovEnd(buffered) : null;

  if (!moovEnd || mvhdDuration(buffered.subarray(0, moovEnd)) !== 0) {
    tailPromise.then((tail) => tail?.abort?.()).catch(() => undefined);
    cache.set(fileId, { negative: true });
    finishIndex(null);
    return rawReplay(fileId, { ...head, stream: held.stream }, buffered, options);
  }

  const tail = await tailPromise;
  const tailBuf = await readStream(tail.stream, headProbeBytes());
  tail.abort?.();
  const index = buildFragmentIndex(buffered.subarray(0, moovEnd), tailBuf, head.total);
  if (!index) {
    cache.set(fileId, { negative: true });
    finishIndex(null);
    return rawReplay(fileId, { ...head, stream: held.stream }, buffered, options);
  }

  index.contentType = head.contentType;
  index.name = head.name;
  index.etag = head.etag;
  index.head = index.prefix;
  cache.set(fileId, { index });
  finishIndex(index);

  const total = index.virtualSize;
  const span = requestSpan(options, total) ?? { start: 0, end: null, open: true };
  const last = span.end == null ? total - 1 : Math.min(span.end, total - 1);
  const partial = buffered.subarray(moovEnd);
  const pass = new PassThrough();
  const abort = () => {
    head.abort?.();
    if (!pass.destroyed) pass.destroy();
  };
  signal?.addEventListener('abort', abort, { once: true });

  const merged = new PassThrough();
  if (partial.length) merged.write(partial);
  if (held.stream.readableEnded) {
    merged.end();
  } else {
    held.stream.on('data', (chunk) => {
      if (!merged.write(chunk)) held.stream.pause();
    });
    merged.on('drain', () => held.stream.resume());
    held.stream.on('end', () => merged.end());
    held.stream.on('error', (error) => merged.destroy(error));
    held.stream.resume();
  }

  const patch = new BoxPatch(index.sidxLen);
  const remember = new RememberHead(index);
  pass.write(index.prefix);
  merged.pipe(patch).pipe(remember).pipe(pass);
  merged.on('error', (error) => pass.destroy(error));

  const ranged = Boolean(options.range || options.rawRangeHeader);
  return responseFrom({
    stream: pass,
    abort,
    metadata: describe(fileId, head, index, total),
    start: span.start,
    end: last,
    total,
    ranged,
  });
}

function isPlayFromStart(options) {
  const hinted = options.metadata?.size || options.range?.total || 0;
  const span = requestSpan(options, hinted);
  if (!span || span.start !== 0) return false;
  if (span.end == null || span.open) return true;
  return Boolean(hinted) && span.end >= hinted - 1;
}

/**
 * Serve a duration-0 fragmented MP4 as a seekable virtual file with an sidx.
 * Returns null when this file is not that layout (caller uses the normal stream).
 */
export async function openFragmentedMp4(fileId, options, fetchUpstream) {
  const known = cache.get(fileId);
  if (known?.negative) return null;
  if (known?.index) return serveIndexed(fileId, known.index, options, fetchUpstream);

  if (!isPlayFromStart(options)) {
    let pending = inflight.get(fileId);
    if (!pending) {
      pending = classify(fileId, fetchUpstream, options.signal).finally(() => inflight.delete(fileId));
      inflight.set(fileId, pending);
    }
    const index = await pending;
    if (!index) return null;
    return serveIndexed(fileId, index, options, fetchUpstream);
  }

  if (inflight.has(fileId)) {
    const index = await inflight.get(fileId);
    if (!index) return null;
    return serveIndexed(fileId, cache.get(fileId)?.index ?? index, options, fetchUpstream);
  }

  return coldPlay(fileId, options, fetchUpstream);
}
