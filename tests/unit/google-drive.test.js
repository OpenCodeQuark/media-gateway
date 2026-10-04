import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractConfirmParams,
  parseGoogleDriveId,
} from '../../src/providers/google-drive.js';
import { assertAllowedUpstreamUrl } from '../../src/streaming/upstream.js';
import { AppError } from '../../src/utils/errors.js';

describe('google drive parsing and SSRF guards', () => {
  it('parses raw IDs and share URLs', () => {
    assert.equal(parseGoogleDriveId('1AbCdEfGhIjKlMnOpQrStUv'), '1AbCdEfGhIjKlMnOpQrStUv');
    assert.equal(
      parseGoogleDriveId('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view'),
      '1AbCdEfGhIjKlMnOpQrStUv',
    );
    assert.equal(
      parseGoogleDriveId('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUv'),
      '1AbCdEfGhIjKlMnOpQrStUv',
    );
    assert.equal(
      parseGoogleDriveId('https://drive.google.com/uc?id=1AbCdEfGhIjKlMnOpQrStUv'),
      '1AbCdEfGhIjKlMnOpQrStUv',
    );
  });

  it('rejects traversal, http, and foreign hosts', () => {
    assert.throws(() => parseGoogleDriveId('../../etc/passwd'), AppError);
    assert.throws(() => parseGoogleDriveId('http://drive.google.com/file/d/abc1234567/view'), AppError);
    assert.throws(() => parseGoogleDriveId('https://evil.example/file/d/abc1234567/view'), AppError);
    assert.throws(() => parseGoogleDriveId('https://127.0.0.1/x'), AppError);
  });

  it('extracts virus-scan confirm tokens', () => {
    const html = '<form><input name="confirm" value="t"><input name="uuid" value="u-1"></form>';
    assert.deepEqual(extractConfirmParams(html), { confirm: 't', uuid: 'u-1' });
  });

  it('allows only approved HTTPS upstream hosts', () => {
    assert.doesNotThrow(() =>
      assertAllowedUpstreamUrl(new URL('https://drive.usercontent.google.com/download')),
    );
    assert.throws(() => assertAllowedUpstreamUrl(new URL('http://drive.google.com/x')), AppError);
    assert.throws(() => assertAllowedUpstreamUrl(new URL('https://evil.example/x')), AppError);
  });
});
