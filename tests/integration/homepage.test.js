import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { metadataCache } from '../../src/cache/metadata.js';
import { setMediaProvider } from '../../src/services/media.js';
import { FakeMediaProvider, makeTestBuffer } from '../fixtures/fake-provider.js';

describe('homepage', () => {
  beforeEach(() => {
    metadataCache.clear();
    setMediaProvider(
      new FakeMediaProvider(
        new Map([['1AbCdEfGhIjKlMnOpQr', { data: makeTestBuffer(128), mimeType: 'video/mp4' }]]),
      ),
    );
  });

  afterEach(() => {
    setMediaProvider();
    metadataCache.clear();
  });

  it('GET / returns HTML with input and generate controls', async () => {
    const res = await request(createApp()).get('/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /html/);
    assert.match(res.text, /Media Gateway/);
    assert.match(res.text, /Stream Google Drive media through a direct URL/);
    assert.match(res.text, /Paste Google Drive link or file ID/);
    assert.match(res.text, /Generate Direct Link/);
    assert.match(res.text, /Copy direct link/);
    assert.match(res.text, /Validate/);
    assert.match(res.text, /window\.location\.origin/);
    assert.doesNotMatch(res.text, /Copy Direct Link/);
    assert.doesNotMatch(res.text, /localhost/);
    assert.doesNotMatch(res.text, /Example:/);
  });

  it('resolves raw IDs and share URLs', async () => {
    const app = createApp();
    const id = '1AbCdEfGhIjKlMnOpQr';

    const raw = await request(app).get('/api/resolve').query({ input: id });
    assert.equal(raw.status, 200);
    assert.equal(raw.body.success, true);
    assert.equal(raw.body.id, id);
    assert.equal(raw.body.path, `/media/${id}`);

    const share = await request(app)
      .get('/api/resolve')
      .query({ input: `https://drive.google.com/file/d/${id}/view?usp=sharing` });
    assert.equal(share.status, 200);
    assert.equal(share.body.id, id);
  });

  it('validates media via metadata without requiring a body download API', async () => {
    const res = await request(createApp())
      .get('/api/validate')
      .query({ input: '1AbCdEfGhIjKlMnOpQr' });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.mimeType, 'video/mp4');
    assert.equal(res.body.size, 128);
  });

  it('rejects invalid resolve input', async () => {
    const res = await request(createApp())
      .get('/api/resolve')
      .query({ input: 'https://evil.example/file/d/abc/view' });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
  });
});
