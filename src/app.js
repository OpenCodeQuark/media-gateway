import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { rejectWhenShuttingDown } from './middleware/shutdown.js';
import healthRoutes from './routes/health.js';
import homeRoutes from './routes/home.js';
import mediaRoutes from './routes/media.js';
import { logger } from './utils/logger.js';

export function createApp() {
  const app = express();

  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', join(dirname(fileURLToPath(import.meta.url)), 'views'));
  // Never compress media responses (would break Range / progressive playback).
  app.set('etag', false);

  app.use(requestIdMiddleware);
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(rejectWhenShuttingDown);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => String(req.headers['x-request-id'] ?? ''),
      autoLogging: {
        ignore: (req) =>
          req.url === '/health' || req.url === '/ready' || req.url === '/' || req.url?.startsWith('/?'),
      },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
      },
    }),
  );

  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    next();
  });

  app.use(rateLimitMiddleware);
  app.use(homeRoutes);
  app.use(healthRoutes);
  app.use('/media', mediaRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
