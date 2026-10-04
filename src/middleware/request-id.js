import { randomUUID } from 'node:crypto';

export function requestIdMiddleware(req, res, next) {
  const incoming = req.header('x-request-id');
  const requestId = incoming?.trim() ? incoming.trim().slice(0, 128) : randomUUID();
  req.headers['x-request-id'] = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.locals.requestId = requestId;
  next();
}
