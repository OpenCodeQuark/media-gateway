import { isProduction } from '../config.js';
import { AppError, isAppError, toErrorPayload } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export function notFoundHandler(_req, res) {
  res.status(404).json({
    success: false,
    error: { code: 'MEDIA_NOT_FOUND', message: 'Resource not found.' },
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

  res.status(appError.statusCode).json(toErrorPayload(appError));
}
