import pino from 'pino';
import { config, isProduction, isTest } from '../config.js';

export const logger = pino({
  level: isTest ? 'silent' : config.logLevel,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'GOOGLE_CLIENT_SECRET',
      'GOOGLE_REFRESH_TOKEN',
      'GOOGLE_API_KEY',
      'access_token',
      'refresh_token',
      'token',
    ],
    remove: true,
  },
  transport:
    !isProduction && !isTest
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        }
      : undefined,
});
