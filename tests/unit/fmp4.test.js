import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { buildFragmentIndex, patchFragmentBuffer } from '../../src/streaming/fmp4.js';
import { clearFragmentedMp4Cache, openFragmentedMp4 } from '../../src/streaming/fmp4-play.js';

function box(type, payload) {
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(out.length, 0);
  out.write(type, 4);
  payload.copy(out, 8);
  return out;
}

function fullBox(type, payload) {
  const body = Buffer.alloc(4 + payload.length);
  payload.copy(body, 4);
  return box(type, body);
}

function fragmentedFile() {
  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(16, 0);
  ftyp.write('ftyp', 4);
  ftyp.write('isom', 8);

  const mvhdBody = Buffer.alloc(100);
  mvhdBody.writeUInt32BE(1000, 12);
  const mdhdBody = Buffer.alloc(20);
  mdhdBody.writeUInt32BE(1000, 12);
  const tkhdBody = Buffer.alloc(84);
  tkhdBody.writeUInt32BE(1, 12);
  const moov = box(
    'moov',
    Buffer.concat([
      box('mvhd', mvhdBody),
      box('trak', Buffer.concat([box('tkhd', tkhdBody), box('mdia', box('mdhd', mdhdBody))])),
    ]),
  );

  const moofAt = (index) => ftyp.length + moov.length + index * (moofSize() + mdat().length);

  function tfhd(base) {
    const body = Buffer.alloc(16);
    body.writeUInt32BE(0x000001, 0);
    body.writeUInt32BE(1, 4);
    body.writeUInt32BE(base >>> 0, 12);
    return box('tfhd', body);
  }
  function mfhd() {
    const payload = Buffer.alloc(4);
    payload.writeUInt32BE(1, 0);
    return fullBox('mfhd', payload);
  }
  function moofSize() {
    return box('moof', Buffer.concat([mfhd(), box('traf', tfhd(0))])).length;
  }
  function mdat() {
    return box('mdat', Buffer.alloc(48, 7));
  }
  function moof(base) {
    return box('moof', Buffer.concat([mfhd(), box('traf', tfhd(base))]));
  }

  const first = moofAt(0);
  const second = moofAt(1);
  const media = Buffer.concat([moof(first), mdat(), moof(second), mdat()]);

  function tfra(entries) {
    const body = Buffer.alloc(16 + entries.length * 19);
    body[0] = 1;
    body.writeUInt32BE(1, 4);
    body.writeUInt32BE(entries.length, 12);
    let offset = 16;
    for (const entry of entries) {
      body.writeUInt32BE(entry.time, offset + 4);
      body.writeUInt32BE(entry.off, offset + 12);
      body[offset + 16] = 1;
      body[offset + 17] = 1;
      body[offset + 18] = 1;
      offset += 19;
    }
    return box('tfra', body);
  }

  const tfraBox = tfra([
    { time: 0, off: first },
    { time: 1000, off: second },
  ]);
  const mfraSize = 8 + tfraBox.length + 16;
  const mfro = fullBox('mfro', Buffer.from([0, 0, 0, 0]));
  const mfra = Buffer.alloc(mfraSize);
  mfra.writeUInt32BE(mfraSize, 0);
  mfra.write('mfra', 4);
  tfraBox.copy(mfra, 8);
  mfro.copy(mfra, 8 + tfraBox.length);
  mfra.writeUInt32BE(mfraSize, mfra.length - 4);

  return {
    file: Buffer.concat([ftyp, moov, media, mfra]),
    first,
    second,
    moovEnd: ftyp.length + moov.length,
  };
}

function sliceFetcher(file) {
  const calls = [];
  return {
    calls,
    fetch(range) {
      calls.push(range);
      let start;
      let end;
      if (range.startsWith('bytes=-')) {
        const n = Number(range.slice('bytes=-'.length));
        start = Math.max(0, file.length - n);
        end = file.length - 1;
      } else {
        const match = range.match(/bytes=(\d+)-(\d*)/);
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : file.length - 1;
      }
      const body = file.subarray(start, end + 1);
      return Promise.resolve({
        stream: Readable.from([body]),
        abort() {},
        total: file.length,
        contentType: 'video/mp4',
        name: 'clip.mp4',
      });
    },
  };
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('fragmented mp4 index', () => {
  it('inserts an sidx and shifts fragment offsets', () => {
    const { file, first, moovEnd } = fragmentedFile();
    const head = file.subarray(0, 8192);
    const tail = file.subarray(Math.max(0, file.length - 8192));
    const index = buildFragmentIndex(head, tail, file.length);
    assert.ok(index);
    assert.equal(index.prefix.subarray(4, 8).toString(), 'ftyp');
    assert.ok(index.prefix.includes('sidx'));
    assert.equal(index.virtualSize, file.length + index.sidxLen);
    assert.equal(index.moovEnd, moovEnd);

    const body = patchFragmentBuffer(file.subarray(moovEnd), index.sidxLen);
    const tfhd = body.indexOf('tfhd');
    const base = body.readUInt32BE(tfhd + 16);
    assert.equal(base, first + index.sidxLen);
  });

  it('serves a seekable virtual file and reuses the cached head', async () => {
    clearFragmentedMp4Cache();
    const { file, first } = fragmentedFile();
    const upstream = sliceFetcher(file);

    const opened = await openFragmentedMp4('clip', { rawRangeHeader: 'bytes=0-' }, upstream.fetch);
    assert.ok(opened);
    assert.equal(opened.statusCode, 206);
    assert.equal(opened.headers['Accept-Ranges'], 'bytes');
    assert.match(opened.contentRange, /^bytes 0-\d+\/\d+$/);
    const body = await readAll(opened.stream);
    assert.equal(body.length, opened.contentLength);
    assert.equal(body.subarray(4, 8).toString(), 'ftyp');
    const sidx = body.indexOf('sidx');
    assert.ok(sidx > 0);
    const tfhd = body.indexOf('tfhd');
    assert.equal(body.readUInt32BE(tfhd + 16), first + (body.length - file.length));

    const callsAfterPlay = upstream.calls.length;
    const again = await openFragmentedMp4(
      'clip',
      { rawRangeHeader: `bytes=0-${Math.min(body.length, 1024) - 1}` },
      upstream.fetch,
    );
    const head = await readAll(again.stream);
    assert.equal(head.length, Math.min(body.length, 1024));
    assert.deepEqual(head, body.subarray(0, head.length));
    assert.equal(upstream.calls.length, callsAfterPlay);

    const seekAt = body.indexOf('mdat', sidx) - 4;
    const seek = await openFragmentedMp4(
      'clip',
      { rawRangeHeader: `bytes=${seekAt}-${seekAt + 7}` },
      upstream.fetch,
    );
    const mark = await readAll(seek.stream);
    assert.equal(mark.subarray(4, 8).toString(), 'mdat');
    clearFragmentedMp4Cache();
  });
});
