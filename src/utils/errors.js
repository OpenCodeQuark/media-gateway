const STATUS_BY_CODE = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  MEDIA_NOT_FOUND: 404,
  INVALID_MEDIA_ID: 400,
  RANGE_NOT_SATISFIABLE: 416,
  TOO_MANY_REQUESTS: 429,
  UPSTREAM_ERROR: 502,
  UPSTREAM_TIMEOUT: 504,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = options.statusCode ?? STATUS_BY_CODE[code] ?? 500;
    this.expose = options.expose ?? this.statusCode < 500;
    this.details = options.details;
  }
}

export function isAppError(error) {
  return error instanceof AppError;
}

export function toErrorPayload(error) {
  return {
    success: false,
    error: {
      code: error.code,
      message: error.expose ? error.message : 'An unexpected error occurred.',
      ...(error.details ? { details: error.details } : {}),
    },
  };
}
