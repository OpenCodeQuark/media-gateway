/**
 * Helpers for duration=0 fragmented MP4 (mvhd/mdhd duration 0 + mfra at EOF).
 * Chromium HTMLMediaElement often waits to scan the whole object before canplay;
 * patching movie timescale duration from tfra lets progressive playback start early.
 */

function readU32(buf, offset) {
  return buf.readUInt32BE(offset);
}

function readU64(buf, offset) {
  const hi = buf.readUInt32BE(offset);
  const lo = buf.readUInt32BE(offset + 4);
  return hi * 2 ** 32 + lo;
}

function readBox(buf, boxStart, limit = buf.length) {
  if (boxStart < 0 || boxStart + 8 > limit) return null;
  let size = readU32(buf, boxStart);
  let header = 8;
  if (size === 1) {
    if (boxStart + 16 > limit) return null;
    size = Number(readU64(buf, boxStart + 8));
    header = 16;
  } else if (size === 0) {
    size = limit - boxStart;
  }
  if (size < header || boxStart + size > limit) return null;
  return {
    start: boxStart,
    size,
    type: buf.toString('ascii', boxStart + 4, boxStart + 8),
    header,
    end: boxStart + size,
  };
}

function forEachBox(buf, start, end, fn) {
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBox(buf, offset, end);
    if (!box || box.size <= 0) break;
    fn(box);
    offset += box.size;
  }
}

/** Map track_ID -> media timescale using moov/trak/tkhd+mdhd. */
function trackTimescales(head) {
  const scales = new Map();
  const moovType = head.indexOf('moov');
  if (moovType < 4) return scales;
  const moov = readBox(head, moovType - 4);
  if (!moov) return scales;

  forEachBox(head, moov.start + moov.header, moov.end, (trak) => {
    if (trak.type !== 'trak') return;
    let trackId;
    let scale;
    forEachBox(head, trak.start + trak.header, trak.end, (child) => {
      if (child.type === 'tkhd') {
        const ver = head[child.start + 8];
        trackId = ver === 1 ? readU32(head, child.start + 28) : readU32(head, child.start + 20);
      }
      if (child.type === 'mdia') {
        forEachBox(head, child.start + child.header, child.end, (mdiaChild) => {
          if (mdiaChild.type !== 'mdhd') return;
          const ver = head[mdiaChild.start + 8];
          scale =
            ver === 1
              ? readU32(head, mdiaChild.start + 28)
              : readU32(head, mdiaChild.start + 20);
        });
      }
    });
    if (trackId && scale) scales.set(trackId, scale);
  });
  return scales;
}

/** Return movie timescale duration derived from tfra + mdhd, or null. */
export function durationFromMfra(head, tail) {
  if (!head?.length || !tail?.length) return null;

  const mvhdAt = head.indexOf('mvhd');
  if (mvhdAt < 0) return null;
  const mvhdVer = head[mvhdAt + 4];
  const movieTimescale =
    mvhdVer === 1 ? readU32(head, mvhdAt + 24) : readU32(head, mvhdAt + 16);
  if (!movieTimescale) return null;

  const trackScales = trackTimescales(head);
  if (!trackScales.size) return null;

  const mfraType = tail.lastIndexOf('mfra');
  if (mfraType < 4) return null;
  const mfra = readBox(tail, mfraType - 4);
  if (!mfra || mfra.type !== 'mfra') return null;

  let maxSeconds = 0;
  forEachBox(tail, mfra.start + mfra.header, mfra.end, (box) => {
    if (box.type !== 'tfra' || box.size < 24) return;
    const ver = tail[box.start + 8];
    const trackId = readU32(tail, box.start + 12);
    const lens = readU32(tail, box.start + 16);
    const count = readU32(tail, box.start + 20);
    const scale = trackScales.get(trackId);
    if (!scale || count <= 0) return;

    const lt = (lens >> 4) & 3;
    const lu = (lens >> 2) & 3;
    const ls = lens & 3;
    const timeSize = ver === 1 ? 8 : 4;
    const entrySize = timeSize + (ver === 1 ? 8 : 4) + (lt + 1) + (lu + 1) + (ls + 1);
    const lastEntry = box.start + 24 + (count - 1) * entrySize;
    if (lastEntry + timeSize > box.end) return;

    const mediaTime = ver === 1 ? readU64(tail, lastEntry) : readU32(tail, lastEntry);
    const seconds = mediaTime / scale;
    if (Number.isFinite(seconds) && seconds > maxSeconds) maxSeconds = seconds;
  });

  if (maxSeconds <= 0) return null;
  return Math.max(1, Math.round((maxSeconds + 1) * movieTimescale));
}

function writeDuration(out, offset, version, duration) {
  const value = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(duration)));
  if (version === 1) {
    out.writeUInt32BE(Math.floor(value / 2 ** 32), offset);
    out.writeUInt32BE(value >>> 0, offset + 4);
    return;
  }
  out.writeUInt32BE(value >>> 0, offset);
}

/** Patch mvhd / tkhd / mdhd durations in a copy of the file head. */
export function patchMp4Durations(head, durationMovie) {
  if (!head?.length || !durationMovie || durationMovie <= 0) return head;
  const out = Buffer.from(head);

  let movieScale = 1000;
  const mvhdType = out.indexOf('mvhd');
  if (mvhdType >= 0) {
    const ver = out[mvhdType + 4];
    movieScale = ver === 1 ? readU32(out, mvhdType + 24) : readU32(out, mvhdType + 16);
    if (ver === 1) writeDuration(out, mvhdType + 28, 1, durationMovie);
    else writeDuration(out, mvhdType + 20, 0, durationMovie);
  }

  if (movieScale > 0) {
    const seconds = durationMovie / movieScale;
    const moovType = out.indexOf('moov');
    const moov = moovType >= 4 ? readBox(out, moovType - 4) : null;
    if (moov) {
      forEachBox(out, moov.start + moov.header, moov.end, (trak) => {
        if (trak.type !== 'trak') return;
        forEachBox(out, trak.start + trak.header, trak.end, (child) => {
          if (child.type !== 'mdia') return;
          forEachBox(out, child.start + child.header, child.end, (mdhd) => {
            if (mdhd.type !== 'mdhd') return;
            const ver = out[mdhd.start + 8];
            const scale = ver === 1 ? readU32(out, mdhd.start + 28) : readU32(out, mdhd.start + 20);
            const dur = seconds * scale;
            if (ver === 1) writeDuration(out, mdhd.start + 32, 1, dur);
            else writeDuration(out, mdhd.start + 24, 0, dur);
          });
        });
      });
    }
  }

  let search = 0;
  while (search < out.length) {
    const tkhdType = out.indexOf('tkhd', search);
    if (tkhdType < 0) break;
    const ver = out[tkhdType + 4];
    if (ver === 1) {
      out.writeUInt32BE(Math.floor(durationMovie / 2 ** 32), tkhdType + 28);
      out.writeUInt32BE(durationMovie >>> 0, tkhdType + 32);
    } else {
      out.writeUInt32BE(durationMovie >>> 0, tkhdType + 24);
    }
    search = tkhdType + 4;
  }

  return out;
}
