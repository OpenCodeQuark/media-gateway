import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatContentRange,
  formatUnsatisfiedContentRange,
  parseRangeHeader,
  resolveByteRange,
} from '../../src/streaming/range.js';
import { AppError } from '../../src/utils/errors.js';

describe('range', () => {
  it('parses closed, open-ended, and suffix ranges', () => {
    assert.deepEqual(resolveByteRange('bytes=0-100', 1000), {
      start: 0,
      end: 100,
      length: 101,
      total: 1000,
      suffix: false,
    });
    assert.deepEqual(resolveByteRange('bytes=100-', 1000), {
      start: 100,
      end: 999,
      length: 900,
      total: 1000,
      suffix: false,
    });
    assert.deepEqual(resolveByteRange('bytes=-100', 1000), {
      start: 900,
      end: 999,
      length: 100,
      total: 1000,
      suffix: true,
    });
  });

  it('returns undefined without Range and formats headers', () => {
    assert.equal(resolveByteRange(undefined, 1000), undefined);
    assert.equal(
      formatContentRange({ start: 0, end: 99, length: 100, total: 500 }),
      'bytes 0-99/500',
    );
    assert.equal(formatUnsatisfiedContentRange(500), 'bytes */500');
  });

  it('rejects invalid, multi, and out-of-bounds ranges', () => {
    assert.throws(() => parseRangeHeader('items=0-1'), AppError);
    assert.throws(() => resolveByteRange('bytes=0-1,2-3', 100), AppError);
    assert.throws(() => resolveByteRange('bytes=1000-1001', 1000), AppError);
    assert.throws(() => resolveByteRange('bytes=10-5', 100), AppError);
  });
});
