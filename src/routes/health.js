import { Router } from 'express';
import { metrics } from '../metrics.js';
import { isShuttingDown } from '../middleware/shutdown.js';
import { getActiveStreams } from '../services/media.js';

const router = Router();

router.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'media-gateway'
  });
});

router.get('/ready', (_req, res) => {
  if (isShuttingDown()) {
    res.status(503).json({ status: 'shutting_down', service: 'media-gateway' });
    return;
  }
  res.status(200).json({
    status: 'ready',
    service: 'media-gateway',
    activeStreams: getActiveStreams(),
  });
});

router.get('/metrics', (_req, res) => {
  res.status(200).json({ success: true, metrics: metrics.snapshot() });
});

export default router;
