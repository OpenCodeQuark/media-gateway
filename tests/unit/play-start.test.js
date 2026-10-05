import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { clearPlaybackSessions, getPlaybackSession, openPlaybackSlice } from '../../src/streaming/play-start.js';

function box(type, payload) {
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(out.length, 0);
  out.write(type, 4);
  payload.copy(out, 8);
  return out;
}

function fragmentedHead() {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(0, 16);
  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(16, 0);
  ftyp.write('ftyp', 4);
  ftyp.write('isom', 8);
  return Buffer.concat([ftyp, box('moov', box('mvhd', mvhd))]);
}

async function readN(stream, n) {
  const chunks = [];
  let got = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    got += chunk.length;
    if (got >= n) break;
  }
  return Buffer.concat(chunks);
}

describe('play-start', () => {
  it('serves a later Range from the same download', async () => {
    clearPlaybackSessions();
    const head = fragmentedHead();
    let headCalls = 0;

    const fetchUpstream = (range) => {
      if (String(range).startsWith('bytes=-')) {
        return Promise.resolve({
          stream: Readable.from([Buffer.from('no-mfra')]),
          abort() {},
          total: 0,
          contentType: 'video/mp4',
        });
      }
      headCalls += 1;
      const stream = Readable.from(
        (async function* body() {
          yield head;
          await new Promise((resolve) => setTimeout(resolve, 30));
          yield Buffer.alloc(300_000, 9);
        })(),
      );
      return Promise.resolve({
        stream,
        abort() {},
        total: 500_000,
        contentType: 'video/mp4',
        name: 'clip.mp4',
      });
    };

    const session = getPlaybackSession('file', fetchUpstream);
    const first = await openPlaybackSlice(session, { start: 0, end: null });
    const firstBytes = await readN(first.stream, head.length + 250_000);
    assert.ok(firstBytes.length > 250_000);

    const second = await openPlaybackSlice(session, { start: 250_000, end: 250_099 });
    assert.ok(second);
    const secondBytes = await readN(second.stream, 100);
    assert.equal(secondBytes.length, 100);
    assert.equal(secondBytes[0], 9);
    assert.equal(headCalls, 1);

    first.abort();
    second.abort();
    clearPlaybackSessions();
  });
});
