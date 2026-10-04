import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('security headers', () => {
  it('sets Helmet security headers', async () => {
    const res = await request(createApp()).get('/health');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.ok(res.headers['cross-origin-resource-policy']);
    assert.equal(res.headers['x-powered-by'], undefined);
  });
});
