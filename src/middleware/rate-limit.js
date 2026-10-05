import rateLimit from 'express-rate-limit';
import { config, isTest } from '../config.js';
import { renderError } from './error-handler.js';
import { wantsHtml } from '../utils/negotiate.js';

export const rateLimitMiddleware = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (isTest) return true;
    const path = req.path || '';
    return path === '/' || path === '/health' || path === '/ready';
  },
  handler(req, res) {
    const message = 'Too many requests. Please try again later.';
    if (wantsHtml(req)) {
      renderError(res, 429, message);
      return;
    }
    res.status(429).json({
      success: false,
      error: { code: 'TOO_MANY_REQUESTS', message },
    });
  },
});
