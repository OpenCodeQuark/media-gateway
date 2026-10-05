import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { metadataCache } from '../../src/cache/metadata.js';
import { metrics } from '../../src/metrics.js';
import { setMediaProvider } from '../../src/services/media.js';
import { FakeMediaProvider, makeTestBuffer } from '../fixtures/fake-provider.js';

/**
 * Mimics Chromium HTMLMediaElement Range probing / chunked fetch pattern.
 * Proves we never require buffering the full object for playback to start.
 */
describe('Chromium-style Range streaming', () => {
  const size = 5 * 1024 * 1024;
  const video = makeTestBuffer(size, 0x42);

  beforeEach(() => {
    metadataCache.clear();
    metrics.reset();
    setMediaProvider(
      new FakeMediaProvider(
        new Map([['chromevid', { data: video, mimeType: 'video/mp4', name: 'clip.mp4' }]]),
      ),
    );
  });

  afterEach(() => {
    setMediaProvider();
    metadataCache.clear();
  });

  async function getRange(app, range) {
    return request(app)
      .get('/media/chromevid')
      .set('Range', range)
      .set(
        'User-Agent',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      )
      .buffer(true)
      .parse((incoming, callback) => {
        const chunks = [];
        incoming.on('data', (c) => chunks.push(Buffer.from(c)));
        incoming.on('end', () => callback(null, Buffer.concat(chunks)));
      });
  }

  it('answers Chromium probe bytes=0-1 with 206 and exact headers', async () => {
    const app = createApp();
    const res = await getRange(app, 'bytes=0-1');
    assert.equal(res.status, 206);
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.equal(res.headers['content-range'], `bytes 0-1/${size}`);
    assert.equal(res.headers['content-length'], '2');
    assert.match(res.headers['content-type'], /video\/mp4/);
    assert.equal(res.body.length, 2);
  });

  it('serves sequential Chromium chunk ranges without full-file bodies', async () => {
    const app = createApp();
    const ranges = ['bytes=0-1', 'bytes=0-65535', 'bytes=65536-131071', `bytes=${size - 1024}-`];

    for (const range of ranges) {
      const res = await getRange(app, range);
      assert.equal(res.status, 206, range);
      assert.equal(res.headers['accept-ranges'], 'bytes');
      assert.ok(res.headers['content-range']?.startsWith('bytes '));
      const declared = Number(res.headers['content-length']);
      assert.equal(res.body.length, declared);
      assert.ok(declared < size, `range ${range} returned full object`);
    }
  });

  it('streams open-ended Chromium ranges through EOF without capping', async () => {
    const app = createApp();
    const open = await getRange(app, 'bytes=0-');
    assert.equal(open.status, 206);
    assert.equal(open.headers['content-length'], String(size));
    assert.equal(open.headers['content-range'], `bytes 0-${size - 1}/${size}`);
    assert.equal(open.body.length, size);

    const mid = await getRange(app, 'bytes=100-');
    assert.equal(mid.status, 206);
    assert.equal(mid.headers['content-range'], `bytes 100-${size - 1}/${size}`);
    assert.equal(mid.body.length, size - 100);
  });

  it('keeps small open-ended and suffix ranges exact', async () => {
    const app = createApp();
    const nearEnd = await getRange(app, `bytes=${size - 1024}-`);
    assert.equal(nearEnd.status, 206);
    assert.equal(nearEnd.headers['content-range'], `bytes ${size - 1024}-${size - 1}/${size}`);
    assert.equal(nearEnd.body.length, 1024);

    const suffix = await getRange(app, 'bytes=-2048');
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers['content-length'], '2048');
    assert.equal(suffix.body.length, 2048);
  });

  it('returns 416 with bytes */TOTAL for unsatisfiable Chromium ranges', async () => {
    const res = await request(createApp())
      .get('/media/chromevid')
      .set('Range', `bytes=${size + 10}-${size + 20}`);
    assert.equal(res.status, 416);
    assert.equal(res.headers['content-range'], `bytes */${size}`);
    assert.equal(res.headers['accept-ranges'], 'bytes');
  });

  it('HEAD does not return a media body', async () => {
    const res = await request(createApp()).head('/media/chromevid').set('Range', 'bytes=0-1');
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-length'], '2');
    assert.equal(res.headers['content-range'], `bytes 0-1/${size}`);
    assert.equal(res.text ?? '', '');
  });
});
