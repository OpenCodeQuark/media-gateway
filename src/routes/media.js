import { Router } from 'express';
import { handleMediaRequest } from '../services/media.js';

const router = Router();

async function mediaHandler(req, res, next) {
  try {
    await handleMediaRequest(req, res);
  } catch (error) {
    next(error);
  }
}

router.get('/:mediaId', mediaHandler);
router.head('/:mediaId', mediaHandler);

export default router;
