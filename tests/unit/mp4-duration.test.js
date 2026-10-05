import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { patchMp4Durations } from '../../src/streaming/mp4-duration.js';

describe('mp4-duration', () => {
  it('patches mvhd duration field', () => {
    const head = Buffer.alloc(64);
    head.write('mvhd', 8);
    head[12] = 0; // version
    head.writeUInt32BE(1000, 24); // timescale at type+16
    head.writeUInt32BE(0, 28); // duration at type+20
    const patched = patchMp4Durations(head, 248402);
    assert.equal(patched.readUInt32BE(28), 248402);
  });

  it('patches mdhd duration in the track timescale', () => {
    const mdhd = Buffer.alloc(32);
    mdhd.writeUInt32BE(mdhd.length, 0);
    mdhd.write('mdhd', 4);
    mdhd.writeUInt32BE(12288, 20);
    const mdia = Buffer.alloc(8 + mdhd.length);
    mdia.writeUInt32BE(mdia.length, 0);
    mdia.write('mdia', 4);
    mdhd.copy(mdia, 8);
    const trak = Buffer.alloc(8 + mdia.length);
    trak.writeUInt32BE(trak.length, 0);
    trak.write('trak', 4);
    mdia.copy(trak, 8);
    const mvhd = Buffer.alloc(32);
    mvhd.writeUInt32BE(mvhd.length, 0);
    mvhd.write('mvhd', 4);
    mvhd.writeUInt32BE(1000, 20);
    const moovBody = Buffer.concat([mvhd, trak]);
    const moov = Buffer.alloc(8 + moovBody.length);
    moov.writeUInt32BE(moov.length, 0);
    moov.write('moov', 4);
    moovBody.copy(moov, 8);

    const patched = patchMp4Durations(moov, 242583);
    const mdhdAt = patched.indexOf('mdhd');
    assert.equal(patched.readUInt32BE(mdhdAt + 20), Math.round(242.583 * 12288));
  });
});
