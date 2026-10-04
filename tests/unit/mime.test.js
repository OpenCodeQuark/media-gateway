import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contentDispositionFor, sanitizeMimeType } from '../../src/utils/mime.js';

describe('mime', () => {
  it('sanitizes unsafe types and prefers inline for media', () => {
    assert.equal(sanitizeMimeType('video/mp4'), 'video/mp4');
    assert.equal(sanitizeMimeType('text/html'), 'application/octet-stream');
    assert.equal(sanitizeMimeType('application/octet-stream', 'a.mp3'), 'audio/mpeg');
    assert.match(contentDispositionFor('image/png', 'x.png'), /inline/);
    assert.match(contentDispositionFor('application/zip', 'x.zip'), /attachment/);
  });
});
