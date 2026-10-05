import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { setMediaProvider } from '../../src/services/media.js';
import { FakeMediaProvider, makeTestBuffer } from '../fixtures/fake-provider.js';

describe('error pages', () => {
  it('renders an HTML 404 without internal details', async () => {
    const res = await request(createApp()).get('/no-such-page').set('Accept', 'text/html');
    assert.equal(res.status, 404);
    assert.match(res.headers['content-type'], /html/);
    assert.match(res.text, /Not found/);
    assert.match(res.text, /Resource not found/);
    assert.doesNotMatch(res.text, /node_modules|Error:|at\s+\//);
  });

  it('keeps JSON 404 for API-style clients', async () => {
    const res = await request(createApp()).get('/no-such-page');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'MEDIA_NOT_FOUND');
    assert.equal(res.body.error.message, 'Resource not found.');
  });

  it('renders an HTML page for an invalid media id', async () => {
    const res = await request(createApp())
      .get('/media/' + encodeURIComponent('not a valid id'))
      .set('Accept', 'text/html');
    assert.equal(res.status, 400);
    assert.match(res.text, /Invalid request/);
    assert.doesNotMatch(res.text, /stack|node_modules/);
  });

  it('renders an HTML page for unsupported media', async () => {
    setMediaProvider(
      new FakeMediaProvider(
        new Map([['zipfile1', { data: makeTestBuffer(32), mimeType: 'application/zip', name: 'a.zip' }]]),
      ),
    );
    try {
      const res = await request(createApp()).get('/media/zipfile1').set('Accept', 'text/html');
      assert.equal(res.status, 415);
      assert.match(res.text, /Unsupported media/);
      assert.doesNotMatch(res.text, /node_modules/);
    } finally {
      setMediaProvider();
    }
  });
});
