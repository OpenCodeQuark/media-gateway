import { AppError } from '../utils/errors.js';

let shuttingDown = false;
const shutdownController = new AbortController();

export function markShuttingDown() {
  shuttingDown = true;
  if (!shutdownController.signal.aborted) {
    shutdownController.abort(new Error('Server shutting down'));
  }
}

export function isShuttingDown() {
  return shuttingDown;
}

export function rejectWhenShuttingDown(_req, res, next) {
  if (shuttingDown) {
    next(new AppError('SERVICE_UNAVAILABLE', 'Server is shutting down.'));
    return;
  }
  res.locals.shutdownSignal = shutdownController.signal;
  next();
}
