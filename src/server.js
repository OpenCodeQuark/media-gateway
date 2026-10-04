import { createApp } from './app.js';
import { config } from './config.js';
import { markShuttingDown } from './middleware/shutdown.js';
import { getActiveStreams } from './services/media.js';
import { logger } from './utils/logger.js';

const app = createApp();

const server = app.listen(config.port, config.host, () => {
  logger.info(
    { port: config.port, host: config.host, env: config.nodeEnv },
    'media-gateway listening',
  );
});

// Long media streams must not be killed by a short HTTP request timeout.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  markShuttingDown();
  logger.info({ signal, activeStreams: getActiveStreams() }, 'graceful shutdown started');

  const forceTimer = setTimeout(() => {
    logger.error('forced shutdown after timeout');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceTimer.unref?.();

  server.close((error) => {
    if (error) {
      logger.error({ err: error }, 'error during server close');
      process.exit(1);
    }
    logger.info('shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandledRejection');
});
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaughtException');
  shutdown('uncaughtException');
});
