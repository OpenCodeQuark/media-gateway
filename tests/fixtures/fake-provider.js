import { Readable } from 'node:stream';
import { formatContentRange } from '../../src/streaming/range.js';
import { AppError } from '../../src/utils/errors.js';

export class FakeMediaProvider {
  name = 'fake';

  constructor(files) {
    this.files = files;
  }

  resolveId(input) {
    const value = input.trim();
    if (!value || value.includes('..') || value.includes('/') || value.includes('://')) {
      throw new AppError('INVALID_MEDIA_ID', 'Invalid media identifier.');
    }
    return value;
  }

  async getMetadata(id) {
    const file = this.files.get(this.resolveId(id));
    if (!file) throw new AppError('MEDIA_NOT_FOUND', 'Media could not be found.');
    if (file.failUpstream) throw new AppError('UPSTREAM_ERROR', 'Upstream failed.');
    return {
      id,
      provider: this.name,
      name: file.name,
      mimeType: file.mimeType,
      size: file.data.length,
      cacheable: true,
    };
  }

  async openStream(id, options = {}) {
    const metadata = options.metadata ?? (await this.getMetadata(id));
    const file = this.files.get(metadata.id);
    if (!file) throw new AppError('MEDIA_NOT_FOUND', 'Media could not be found.');
    if (file.failUpstream) throw new AppError('UPSTREAM_ERROR', 'Upstream failed.');

    const start = options.range?.start ?? 0;
    const end = options.range?.end ?? metadata.size - 1;
    const slice = file.data.subarray(start, end + 1);
    const stream = Readable.from(slice);

    return {
      stream,
      metadata,
      statusCode: options.range ? 206 : 200,
      contentLength: slice.length,
      contentRange: options.range ? formatContentRange(options.range) : undefined,
      headers: {
        'Content-Type': metadata.mimeType,
        'Accept-Ranges': 'bytes',
      },
      abort() {
        if (!stream.destroyed) stream.destroy();
      },
    };
  }
}

export function makeTestBuffer(size, fill = 0x61) {
  return Buffer.alloc(size, fill);
}
