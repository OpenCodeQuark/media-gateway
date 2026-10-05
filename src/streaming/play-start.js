import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { AppError } from '../utils/errors.js';
import { durationFromMfra, patchMp4Durations } from './mp4-duration.js';

/**
 * One Google Drive download from byte 0, shared by the browser's follow-up
 * Range requests. The moov atom is patched (duration 0 fragmented MP4) using
 * a parallel tail fetch, but the head download is not paused while that runs.
 * A cancelled client does not abort Drive immediately — Chromium often drops
 * the first response and re-requests the first media offset a moment later.
 */

const sessions = new Map();
const durationCache = new Map();

const HOLD_LIMIT = 256 * 1024;
const MAX_AHEAD = 1024 * 1024;
const TAIL_BYTES = 8192;
const ABORT_GRACE_MS = 750;

export function clearPlaybackSessions() {
  for (const session of sessions.values()) session.kill?.();
  sessions.clear();
  durationCache.clear();
}

export function hasPlaybackSession(fileId) {
  const session = sessions.get(fileId);
  return Boolean(session && !session.dead && !session.failed);
}

function wake(session) {
  const waiters = session.waiters.splice(0);
  for (const waiter of waiters) waiter();
}

function waitFor(session) {
  return new Promise((resolve) => {
    session.waiters.push(resolve);
  });
}

function findMoovEnd(buf) {
  const typeAt = buf.indexOf('moov');
  if (typeAt < 4) return null;
  const size = buf.readUInt32BE(typeAt - 4);
  if (size < 8 || size > HOLD_LIMIT) return null;
  const end = typeAt - 4 + size;
  if (end > buf.length) return null;
  return end;
}

function mvhdDuration(buf) {
  const typeAt = buf.indexOf('mvhd');
  if (typeAt < 0 || typeAt + 24 > buf.length) return null;
  if (buf[typeAt + 4] === 1) {
    if (typeAt + 36 > buf.length) return null;
    return buf.readUInt32BE(typeAt + 28) * 2 ** 32 + buf.readUInt32BE(typeAt + 32);
  }
  return buf.readUInt32BE(typeAt + 20);
}

function looksLikeMp4(buf) {
  return buf.length >= 8 && buf.toString('ascii', 4, 8) === 'ftyp';
}

async function readLimited(stream, max) {
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

function concatChunks(session) {
  return session.chunks.length ? Buffer.concat(session.chunks) : Buffer.alloc(0);
}

function replaceChunks(session, buf) {
  session.base = 0;
  session.chunks = buf.length ? [buf] : [];
  session.buffered = buf.length;
}

function minReaderPos(session) {
  let min = Infinity;
  for (const reader of session.readers) {
    if (reader.pos < min) min = reader.pos;
  }
  return min;
}

function syncFlow(session) {
  // Hold the head at the moov until the duration patch is ready so the
  // parallel tail fetch is not starved by a large media download.
  if (!session.headerReady && session.moovBuffered) {
    session.pause?.();
    return;
  }
  const floor = session.readers.size === 0 ? 0 : minReaderPos(session);
  const ahead = session.buffered - floor;
  if (ahead >= MAX_AHEAD) session.pause?.();
  else session.resume?.();
}

function trim(session) {
  if (session.readers.size === 0) return;
  // Keep a megabyte behind the slowest reader so a follow-up Range that
  // rewinds into recently sent bytes can still be served from this download.
  const keepFrom = Math.max(0, minReaderPos(session) - MAX_AHEAD);
  while (session.chunks.length && session.base + session.chunks[0].length <= keepFrom) {
    session.base += session.chunks[0].length;
    session.chunks.shift();
  }
}

function readAvailable(session, pos, endExclusive) {
  const available = Math.min(session.buffered, endExclusive);
  if (available <= pos || pos < session.base) return Buffer.alloc(0);
  let skip = pos - session.base;
  let remaining = available - pos;
  const out = [];
  for (const chunk of session.chunks) {
    if (remaining <= 0) break;
    if (skip >= chunk.length) {
      skip -= chunk.length;
      continue;
    }
    const take = Math.min(chunk.length - skip, remaining);
    out.push(chunk.subarray(skip, skip + take));
    remaining -= take;
    skip = 0;
  }
  return out.length === 1 ? out[0] : Buffer.concat(out);
}

function appendChunk(session, buf) {
  session.chunks.push(buf);
  session.buffered += buf.length;
  wake(session);
  syncFlow(session);
}

function scheduleKill(session) {
  if (session.dead) return;
  clearTimeout(session.killTimer);
  session.killTimer = setTimeout(() => {
    if (session.readers.size === 0) session.kill();
  }, ABORT_GRACE_MS);
  session.killTimer.unref?.();
}

function cancelKill(session) {
  clearTimeout(session.killTimer);
  session.killTimer = null;
}

function produce(session, fetchUpstream) {
  const ac = new AbortController();
  let killed = false;

  session.kill = () => {
    if (killed) return;
    killed = true;
    session.dead = true;
    sessions.delete(session.fileId);
    clearTimeout(session.killTimer);
    if (!ac.signal.aborted) ac.abort();
    wake(session);
  };

  const tailPromise = fetchUpstream(`bytes=-${TAIL_BYTES}`, ac.signal).catch(() => null);

  fetchUpstream('bytes=0-', ac.signal)
    .then((main) => {
      if (killed) {
        main.abort?.();
        return;
      }
      session.total = main.total;
      session.contentType = main.contentType;
      session.name = main.name;
      session.etag = main.etag;

      const upstream = main.stream;
      let patchStarted = false;

      session.pause = () => {
        if (!upstream.destroyed && !upstream.isPaused()) upstream.pause();
      };
      session.resume = () => {
        if (!upstream.destroyed && upstream.isPaused()) upstream.resume();
      };

      const finishPatch = async () => {
        try {
          let all = concatChunks(session);
          let moovEnd = findMoovEnd(all);
          const isMp4 = looksLikeMp4(all);

          if (isMp4 && moovEnd && mvhdDuration(all.subarray(0, moovEnd)) === 0) {
            const cached = durationCache.get(session.fileId);
            let duration = cached ?? null;
            if (!duration) {
              const tail = await tailPromise;
              if (tail?.stream) {
                const tailBuf = await readLimited(tail.stream, TAIL_BYTES);
                tail.abort?.();
                // Head bytes kept arriving while the tail downloaded.
                all = concatChunks(session);
                moovEnd = findMoovEnd(all);
                if (moovEnd) {
                  duration = durationFromMfra(all.subarray(0, moovEnd), tailBuf);
                  if (duration) durationCache.set(session.fileId, duration);
                }
              }
            } else {
              tailPromise.then((tail) => tail?.abort?.()).catch(() => undefined);
            }
            if (duration && moovEnd) {
              const head = patchMp4Durations(all.subarray(0, moovEnd), duration);
              replaceChunks(session, Buffer.concat([head, all.subarray(moovEnd)]));
            }
          } else {
            tailPromise.then((tail) => tail?.abort?.()).catch(() => undefined);
          }
        } catch {
          tailPromise.then((tail) => tail?.abort?.()).catch(() => undefined);
        } finally {
          session.headerReady = true;
          session._resolve();
          wake(session);
          syncFlow(session);
        }
      };

      const considerPatch = () => {
        if (patchStarted) return;
        const all = concatChunks(session);
        if (!all.length) return;
        if (all.length >= 12 && !looksLikeMp4(all)) {
          patchStarted = true;
          finishPatch();
          return;
        }
        if (findMoovEnd(all) || all.length >= HOLD_LIMIT) {
          session.moovBuffered = true;
          syncFlow(session);
          patchStarted = true;
          finishPatch();
        }
      };

      upstream.on('data', (chunk) => {
        appendChunk(session, Buffer.from(chunk));
        considerPatch();
      });

      upstream.on('end', () => {
        if (!patchStarted) {
          patchStarted = true;
          finishPatch().finally(() => {
            session.ended = true;
            wake(session);
          });
          return;
        }
        session.ended = true;
        wake(session);
      });

      upstream.on('error', (error) => {
        session.failed = error;
        session._reject(error);
        wake(session);
      });

      upstream.resume();
    })
    .catch((error) => {
      session.failed = error;
      session._reject(error);
      wake(session);
    });
}

export function getPlaybackSession(fileId, fetchUpstream) {
  const existing = sessions.get(fileId);
  if (existing && !existing.dead && !existing.failed) return existing;

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A client that never reads must not surface as an unhandled rejection.
  ready.catch(() => undefined);

  const session = {
    fileId,
    chunks: [],
    base: 0,
    buffered: 0,
    total: 0,
    contentType: 'application/octet-stream',
    name: undefined,
    etag: undefined,
    readers: new Set(),
    moovBuffered: false,
    headerReady: false,
    ended: false,
    failed: null,
    dead: false,
    waiters: [],
    ready,
    _resolve: resolveReady,
    _reject: rejectReady,
    kill() {},
    pause() {},
    resume() {},
    killTimer: null,
  };

  sessions.set(fileId, session);
  produce(session, fetchUpstream);
  return session;
}

/**
 * Read [start, end] from the shared download. `end == null` reads through EOF.
 * Returns null when this offset was already discarded and must be fetched alone.
 */
export async function openPlaybackSlice(session, { start, end }) {
  await session.ready;
  if (session.failed) throw session.failed;
  if (session.dead && session.buffered <= start) return null;

  const total = session.total;
  const last = end == null ? total - 1 : Math.min(end, total - 1);
  if (!Number.isFinite(total) || total <= 0 || last < start || start < 0) {
    throw new AppError('RANGE_NOT_SATISFIABLE', 'Range not satisfiable.', {
      details: { total: total || 0 },
    });
  }
  if (start < session.base) return null;

  const reader = { pos: start };
  session.readers.add(reader);
  cancelKill(session);
  syncFlow(session);

  const pass = new PassThrough();
  let stopped = false;

  const detach = () => {
    if (stopped) return;
    stopped = true;
    session.readers.delete(reader);
    if (session.readers.size === 0) scheduleKill(session);
    else syncFlow(session);
    wake(session);
  };

  const pump = async () => {
    const length = last - start + 1;
    let sent = 0;
    while (!stopped && sent < length) {
      if (session.failed) throw session.failed;
      if (reader.pos < session.base) {
        throw new AppError('UPSTREAM_ERROR', 'Playback buffer dropped bytes still required.');
      }
      const endExclusive = Math.min(session.buffered, last + 1);
      if (endExclusive <= reader.pos) {
        if (session.ended || session.dead) break;
        await waitFor(session);
        continue;
      }
      const buf = readAvailable(session, reader.pos, endExclusive);
      if (!buf.length) {
        if (session.ended || session.dead) break;
        await waitFor(session);
        continue;
      }
      reader.pos += buf.length;
      sent += buf.length;
      trim(session);
      syncFlow(session);
      if (!pass.write(buf)) await once(pass, 'drain');
    }
    if (!stopped) pass.end();
  };

  pump().catch((error) => {
    detach();
    if (!pass.destroyed) pass.destroy(error);
  });

  pass.on('close', () => {
    if (!pass.writableEnded) detach();
  });
  pass.on('end', () => detach());

  return {
    stream: pass,
    abort() {
      detach();
      if (!pass.destroyed) pass.destroy();
    },
    contentLength: last - start + 1,
    total,
  };
}
