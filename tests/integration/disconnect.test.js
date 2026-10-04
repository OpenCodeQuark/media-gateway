import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Readable } from 'node:stream';
import { createApp } from '../../src/app.js';
import { metadataCache } from '../../src/cache/metadata.js';
import { setMediaProvider } from '../../src/services/media.js';
import { formatContentRange } from '../../src/streaming/range.js';

describe('client disconnect', () => {
  let aborted = false;

  beforeEach(() => {
    aborted = false;
    metadataCache.clear();
    setMediaProvider({
      name: 'slow-fake',
      resolveId: (id) => id,
      async getMetadata(id) {
        return {
          id,
          provider: 'slow-fake',
          mimeType: 'video/mp4',
          size: 10_000_000,
          cacheable: true,
        };
      },
      async openStream(_id, options = {}) {
        const metadata = await this.getMetadata('slow1');
        const range = options.range;
        const total = range?.length ?? metadata.size;
        let produced = 0;

        const stream = new Readable({
          read() {
            if (aborted || options.signal?.aborted) {
              this.push(null);
              return;
            }
            if (produced >= total) {
              this.push(null);
              return;
            }
            const chunk = Buffer.alloc(Math.min(64 * 1024, total - produced), 0x44);
            produced += chunk.length;
            this.push(chunk);
          },
        });

        options.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            stream.destroy();
          },
          { once: true },
        );

        return {
          stream,
          metadata,
          statusCode: range ? 206 : 200,
          contentLength: total,
          contentRange: range ? formatContentRange(range) : undefined,
          headers: { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' },
          abort() {
            aborted = true;
            stream.destroy();
          },
        };
      },
    });
  });

  afterEach(() => {
    setMediaProvider();
    metadataCache.clear();
  });

  it('aborts upstream when the client disconnects', async () => {
    const app = createApp();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    await new Promise((resolve, reject) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port,
          path: '/media/slow1',
          headers: { Range: 'bytes=0-9999999' },
        },
        (res) => {
          res.once('data', () => req.destroy());
          res.on('error', () => undefined);
        },
      );
      req.on('error', () => undefined);

      const started = Date.now();
      const timer = setInterval(() => {
        if (aborted) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > 5000) {
          clearInterval(timer);
          reject(new Error('upstream was not aborted after client disconnect'));
        }
      }, 20);
    });

    await new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    assert.equal(aborted, true);
  });
});
