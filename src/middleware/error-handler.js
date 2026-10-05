import { isProduction } from '../config.js';
import { AppError, isAppError, toErrorPayload } from '../utils/errors.js';
import { wantsHtml } from '../utils/negotiate.js';
import { logger } from '../utils/logger.js';

const TITLES = {
  400: 'Invalid request',
  401: 'Unauthorized',
  403: 'Access denied',
  404: 'Not found',
  415: 'Unsupported media',
  416: 'Range not satisfiable',
  429: 'Too many requests',
  502: 'Upstream failure',
  503: 'Temporarily unavailable',
  504: 'Upstream timeout',
};

export function renderError(res, status, message) {
  res.status(status).render('error', {
    status,
    title: TITLES[status] || 'Something went wrong',
    message,
  });
}

export function notFoundHandler(req, res) {
  const message = 'Resource not found.';
  if (wantsHtml(req)) {
    renderError(res, 404, message);
    return;
  }
  res.status(404).json({
    success: false,
    error: { code: 'MEDIA_NOT_FOUND', message },
  });
}

export function errorHandler(err, req, res, _next) {
  if (res.headersSent) {
    res.destroy();
    return;
  }

  const appError = isAppError(err)
    ? err
    : new AppError('INTERNAL_ERROR', 'Internal server error.', { cause: err, expose: false });

  logger.error(
    {
      err: isProduction ? { message: appError.message, code: appError.code } : err,
      requestId: res.locals.requestId,
      method: req.method,
      path: req.path,
      statusCode: appError.statusCode,
      code: appError.code,
    },
    'request failed',
  );

  const payload = toErrorPayload(appError);
  if (wantsHtml(req)) {
    renderError(res, appError.statusCode, payload.error.message);
    return;
  }
  res.status(appError.statusCode).json(payload);
}
