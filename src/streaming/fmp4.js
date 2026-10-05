import { durationFromMfra, patchMp4Durations } from './mp4-duration.js';

/**
 * Fragmented MP4 with an empty movie header and an mfra index at EOF.
 * Chromium will Range-scan every moof unless a segment index (sidx) is present.
 * The index is inserted after moov; later fragment offsets shift by that many bytes.
 */

const HEAD_PROBE = 8192;

export function headProbeBytes() {
  return HEAD_PROBE;
}

function u32(buf, offset) {
  return buf.readUInt32BE(offset);
}

function u64(buf, offset) {
  return u32(buf, offset) * 2 ** 32 + u32(buf, offset + 4);
}

function writeU64(buf, offset, value) {
  buf.writeUInt32BE(Math.floor(value / 2 ** 32), offset);
  buf.writeUInt32BE(value >>> 0, offset + 4);
}

export function findMoovEnd(buf) {
  const typeAt = buf.indexOf('moov');
  if (typeAt < 4) return null;
  const size = u32(buf, typeAt - 4);
  if (size < 8) return null;
  const end = typeAt - 4 + size;
  if (end > buf.length) return null;
  return end;
}

export function mvhdDuration(buf) {
  const typeAt = buf.indexOf('mvhd');
  if (typeAt < 0 || typeAt + 24 > buf.length) return null;
  if (buf[typeAt + 4] === 1) {
    if (typeAt + 36 > buf.length) return null;
    return u64(buf, typeAt + 28);
  }
  return u32(buf, typeAt + 20);
}

function movieTimescale(buf) {
  const typeAt = buf.indexOf('mvhd');
  if (typeAt < 0) return null;
  return buf[typeAt + 4] === 1 ? u32(buf, typeAt + 24) : u32(buf, typeAt + 16);
}

function trackTimescale(head, trackId) {
  const moovAt = head.indexOf('moov');
  if (moovAt < 4) return null;
  const moovSize = u32(head, moovAt - 4);
  const moovEnd = moovAt - 4 + moovSize;
  let offset = moovAt + 4;
  while (offset + 8 <= moovEnd) {
    const size = u32(head, offset);
    const type = head.toString('ascii', offset + 4, offset + 8);
    if (size < 8 || offset + size > moovEnd) break;
    if (type === 'trak') {
      const id = trakId(head, offset, offset + size);
      const scale = trakScale(head, offset, offset + size);
      if (id === trackId && scale) return scale;
    }
    offset += size;
  }
  return null;
}

function trakId(buf, start, end) {
  let offset = start + 8;
  while (offset + 8 <= end) {
    const size = u32(buf, offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (size < 8 || offset + size > end) break;
    if (type === 'tkhd') {
      const ver = buf[offset + 8];
      return ver === 1 ? u32(buf, offset + 28) : u32(buf, offset + 20);
    }
    offset += size;
  }
  return null;
}

function trakScale(buf, start, end) {
  let offset = start + 8;
  while (offset + 8 <= end) {
    const size = u32(buf, offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (size < 8 || offset + size > end) break;
    if (type === 'mdia') return boxScale(buf, offset + 8, offset + size, 'mdhd');
    offset += size;
  }
  return null;
}

function boxScale(buf, start, end, wanted) {
  let offset = start;
  while (offset + 8 <= end) {
    const size = u32(buf, offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (size < 8 || offset + size > end) break;
    if (type === wanted) {
      const ver = buf[offset + 8];
      return ver === 1 ? u32(buf, offset + 28) : u32(buf, offset + 20);
    }
    offset += size;
  }
  return null;
}

export function parseTfra(tail) {
  const mfraAt = tail.lastIndexOf('mfra');
  if (mfraAt < 4) return [];
  const mfraStart = mfraAt - 4;
  const mfraSize = u32(tail, mfraStart);
  if (mfraSize < 16 || mfraStart + mfraSize > tail.length) return [];
  const tracks = [];
  let offset = mfraStart + 8;
  const end = mfraStart + mfraSize;
  while (offset + 8 <= end) {
    const size = u32(tail, offset);
    const type = tail.toString('ascii', offset + 4, offset + 8);
    if (size < 8 || offset + size > end) break;
    if (type === 'tfra') {
      const ver = tail[offset + 8];
      const track = u32(tail, offset + 12);
      const lens = u32(tail, offset + 16);
      const count = u32(tail, offset + 20);
      const lt = (lens >> 4) & 3;
      const lu = (lens >> 2) & 3;
      const ls = lens & 3;
      const timeSize = ver === 1 ? 8 : 4;
      const offSize = ver === 1 ? 8 : 4;
      const entrySize = timeSize + offSize + (lt + 1) + (lu + 1) + (ls + 1);
      const entries = [];
      for (let i = 0; i < count; i += 1) {
        const at = offset + 24 + i * entrySize;
        if (at + timeSize + offSize > offset + size) break;
        const time = ver === 1 ? u64(tail, at) : u32(tail, at);
        const off = ver === 1 ? u64(tail, at + timeSize) : u32(tail, at + timeSize);
        entries.push({ time, off });
      }
      tracks.push({ track, ver, entries, timeSize, offSize, entrySize, boxStart: offset });
    }
    offset += size;
  }
  return tracks;
}

function buildSidx(entries, fileSize, timescale, mediaEnd) {
  const refs = [];
  for (let i = 0; i < entries.length; i += 1) {
    const nextOff = i + 1 < entries.length ? entries[i + 1].off : fileSize;
    const size = nextOff - entries[i].off;
    if (size <= 0 || size >= 0x80000000) return null;
    let dur = i + 1 < entries.length ? entries[i + 1].time - entries[i].time : mediaEnd - entries[i].time;
    if (dur <= 0 && i > 0) dur = entries[i].time - entries[i - 1].time;
    refs.push({ size, dur: Math.max(1, dur) });
  }
  const body = Buffer.alloc(4 + 4 + 4 + 4 + 4 + 4 + refs.length * 12);
  let p = 0;
  body.writeUInt32BE(0, p);
  p += 4;
  body.writeUInt32BE(entries.length ? 1 : 0, p);
  p += 4;
  body.writeUInt32BE(timescale >>> 0, p);
  p += 4;
  body.writeUInt32BE(entries[0].time >>> 0, p);
  p += 4;
  body.writeUInt32BE(0, p);
  p += 4;
  body.writeUInt16BE(0, p);
  p += 2;
  body.writeUInt16BE(refs.length, p);
  p += 2;
  for (const ref of refs) {
    body.writeUInt32BE(ref.size >>> 0, p);
    p += 4;
    body.writeUInt32BE(ref.dur >>> 0, p);
    p += 4;
    body.writeUInt32BE(0x90000000, p);
    p += 4;
  }
  const box = Buffer.alloc(8 + body.length);
  box.writeUInt32BE(box.length, 0);
  box.write('sidx', 4);
  body.copy(box, 8);
  // reference_ID is the track id, written above as 1 only when we selected track 1.
  return box;
}

function patchMoof(moof, delta) {
  const out = Buffer.from(moof);
  let offset = 8;
  while (offset + 8 <= out.length) {
    const size = u32(out, offset);
    const type = out.toString('ascii', offset + 4, offset + 8);
    if (size < 8 || offset + size > out.length) break;
    if (type === 'traf') patchTraf(out, offset, offset + size, delta);
    offset += size;
  }
  return out;
}

function patchTraf(buf, start, end, delta) {
  let offset = start + 8;
  while (offset + 8 <= end) {
    const size = u32(buf, offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (size < 8 || offset + size > end) break;
    if (type === 'tfhd') {
      const flags = u32(buf, offset + 8) & 0xffffff;
      if (flags & 1) {
        const value = u64(buf, offset + 16) + delta;
        writeU64(buf, offset + 16, value);
      }
    }
    offset += size;
  }
}

function patchMfra(box, delta) {
  const out = Buffer.from(box);
  for (const track of parseTfra(out)) {
    for (let i = 0; i < track.entries.length; i += 1) {
      const at = track.boxStart + 24 + i * track.entrySize + track.timeSize;
      const value = track.entries[i].off + delta;
      if (track.offSize === 8) writeU64(out, at, value);
      else out.writeUInt32BE(value >>> 0, at);
    }
  }
  return out;
}

/** Patch tfhd base offsets and tfra moof offsets inside a buffer of top-level boxes. */
export function patchFragmentBuffer(buf, delta) {
  if (!delta || !buf?.length) return buf;
  const parts = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    let size = u32(buf, offset);
    if (size < 8 || offset + size > buf.length) {
      parts.push(buf.subarray(offset));
      return Buffer.concat(parts);
    }
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const box = buf.subarray(offset, offset + size);
    if (type === 'moof') parts.push(patchMoof(box, delta));
    else if (type === 'mfra') parts.push(patchMfra(box, delta));
    else parts.push(box);
    offset += size;
  }
  if (offset < buf.length) parts.push(buf.subarray(offset));
  return Buffer.concat(parts);
}

/**
 * Build the virtual header for a duration-0 fragmented MP4.
 * Returns null when the file is not that layout.
 */
export function buildFragmentIndex(head, tail, fileSize) {
  if (!head?.length || !tail?.length || !fileSize) return null;
  if (head.length < 12 || head.toString('ascii', 4, 8) !== 'ftyp') return null;
  const moovEnd = findMoovEnd(head);
  if (!moovEnd) return null;
  if (mvhdDuration(head.subarray(0, moovEnd)) !== 0) return null;

  const tracks = parseTfra(tail).filter((track) => track.entries.length > 0);
  if (!tracks.length) return null;
  const video = tracks.find((track) => track.track === 1) ?? tracks[0];
  const timescale = trackTimescale(head.subarray(0, moovEnd), video.track);
  const movieScale = movieTimescale(head.subarray(0, moovEnd));
  const duration = durationFromMfra(head.subarray(0, moovEnd), tail);
  if (!timescale || !movieScale || !duration) return null;

  const mediaEnd = Math.max(1, Math.round((duration / movieScale) * timescale));
  const sidx = buildSidx(video.entries, fileSize, timescale, mediaEnd);
  if (!sidx) return null;

  const first = video.entries[0].off;
  if (first < moovEnd) return null;
  // Bytes between moov and the first moof stay in place; sidx points at the moof.
  const firstOffset = first - moovEnd;
  sidx.writeUInt32BE(firstOffset >>> 0, 24);

  if (video.track !== 1) sidx.writeUInt32BE(video.track >>> 0, 12);

  const prefix = Buffer.concat([patchMp4Durations(head.subarray(0, moovEnd), duration), sidx]);
  return {
    prefix,
    sidxLen: sidx.length,
    moovEnd,
    fileSize,
    virtualSize: fileSize + sidx.length,
    moofs: video.entries.map((entry) => entry.off),
    duration,
  };
}

export function nearestMoof(moofs, originalOffset) {
  let best = moofs[0] ?? 0;
  for (const off of moofs) {
    if (off <= originalOffset) best = off;
    else break;
  }
  return best;
}
