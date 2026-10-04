import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { metadataCache } from '../../src/cache/metadata.js';
import { metrics } from '../../src/metrics.js';
import { setMediaProvider } from '../../src/services/media.js';
import { FakeMediaProvider, makeTestBuffer } from '../fixtures/fake-provider.js';

const small = makeTestBuffer(1024, 0x41);
const large = makeTestBuffer(2 * 1024 * 1024, 0x42);

describe('media HTTP API', () => {
  beforeEach(() => {
    metadataCache.clear();
    metrics.reset();
    setMediaProvider(
      new FakeMediaProvider(
        new Map([
          ['img1', { data: small, mimeType: 'image/jpeg', name: 'photo.jpg' }],
          ['vid1', { data: large, mimeType: 'video/mp4', name: 'clip.mp4' }],
          ['badup', { data: small, mimeType: 'audio/mpeg', failUpstream: true }],
        ]),
      ),
    );
  });

  afterEach(() => {
    setMediaProvider();
    metadataCache.clear();
  });

  it('serves health, ready, and metrics', async () => {
    const app = createApp();
    const health = await request(app).get('/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');

    const ready = await request(app).get('/ready');
    assert.equal(ready.status, 200);
    assert.equal(ready.body.status, 'ready');

    const m = await request(app).get('/metrics');
    assert.equal(m.status, 200);
    assert.equal(m.body.success, true);
  });

  it('GET /media/:id returns 200 with correct headers and body', async () => {
    const res = await request(createApp())
      .get('/media/img1')
      .buffer(true)
      .parse((incoming, callback) => {
        const chunks = [];
        incoming.on('data', (c) => chunks.push(Buffer.from(c)));
        incoming.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /image\/jpeg/);
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.equal(res.headers['content-length'], String(small.length));
    assert.match(res.headers['content-disposition'], /inline/);
    assert.ok(res.headers['x-content-type-options']);
    assert.equal(res.body.length, small.length);
  });

  it('HEAD /media/:id returns headers without body', async () => {
    const res = await request(createApp()).head('/media/img1');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-length'], String(small.length));
    assert.equal(res.headers['accept-ranges'], 'bytes');
  });

  it('returns 206 for valid ranges with Content-Range', async () => {
    const res = await request(createApp())
      .get('/media/vid1')
      .set('Range', 'bytes=0-99')
      .buffer(true)
      .parse((incoming, callback) => {
        const chunks = [];
        incoming.on('data', (c) => chunks.push(Buffer.from(c)));
        incoming.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    assert.equal(res.status, 206);
    assert.equal(res.headers['content-range'], `bytes 0-99/${large.length}`);
    assert.equal(res.headers['content-length'], '100');
    assert.equal(res.body.length, 100);

    const open = await request(createApp()).get('/media/img1').set('Range', 'bytes=100-');
    assert.equal(open.status, 206);
    assert.equal(open.headers['content-range'], `bytes 100-1023/${small.length}`);

    const suffix = await request(createApp()).get('/media/img1').set('Range', 'bytes=-16');
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers['content-length'], '16');
  });

  it('HEAD supports Range → 206', async () => {
    const res = await request(createApp()).head('/media/vid1').set('Range', 'bytes=0-99');
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-range'], `bytes 0-99/${large.length}`);
    assert.equal(res.headers['content-length'], '100');
  });

  it('returns 416 for unsatisfiable ranges', async () => {
    const res = await request(createApp()).get('/media/img1').set('Range', 'bytes=99999-100000');
    assert.equal(res.status, 416);
    assert.equal(res.headers['content-range'], `bytes */${small.length}`);
    assert.equal(res.headers['accept-ranges'], 'bytes');
  });

  it('returns 404 / 400 / 502 for error cases', async () => {
    const app = createApp();
    const missing = await request(app).get('/media/does-not-exist');
    assert.equal(missing.status, 404);

    const bad = await request(app).get('/media/' + encodeURIComponent('../../etc/passwd'));
    assert.equal(bad.status, 400);

    const ssrf = await request(app).get(
      '/media/' + encodeURIComponent('https://127.0.0.1/secret'),
    );
    assert.equal(ssrf.status, 400);

    const upstream = await request(app).get('/media/badup');
    assert.equal(upstream.status, 502);
  });
});
