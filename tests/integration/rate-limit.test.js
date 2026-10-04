import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

describe('rate limiting', () => {
  it('returns 429 after RATE_LIMIT_MAX is exceeded', async () => {
    const port = 18080 + Math.floor(Math.random() * 1000);
    const child = spawn(process.execPath, ['index.js'], {
      cwd: new URL('../..', import.meta.url).pathname,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'silent',
        RATE_LIMIT_WINDOW_MS: '60000',
        RATE_LIMIT_MAX: '2',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      let ready = false;
      for (let i = 0; i < 40; i += 1) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          if (res.ok) {
            ready = true;
            break;
          }
        } catch {
          // wait for listen
        }
        await sleep(50);
      }
      assert.equal(ready, true, 'server did not become ready');

      const a = await fetch(`http://127.0.0.1:${port}/metrics`);
      const b = await fetch(`http://127.0.0.1:${port}/metrics`);
      const c = await fetch(`http://127.0.0.1:${port}/metrics`);

      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.equal(c.status, 429);

      // Health remains available for probes.
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(health.status, 200);
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });
});
