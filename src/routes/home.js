import { Router } from 'express';
import { parseGoogleDriveId } from '../providers/google-drive.js';
import { getMetadataForInput } from '../services/media.js';
import { isAppError } from '../utils/errors.js';

const router = Router();

router.get('/', (_req, res) => {
  res.status(200).render('home');
});

/** Normalize Drive ID / share URL using server-side parser (no upstream fetch). */
router.get('/api/resolve', (req, res) => {
  const input = typeof req.query.input === 'string' ? req.query.input : '';
  try {
    const id = parseGoogleDriveId(input);
    res.status(200).json({
      success: true,
      id,
      path: `/media/${encodeURIComponent(id)}`,
    });
  } catch (error) {
    const appError = isAppError(error)
      ? error
      : { statusCode: 400, code: 'INVALID_MEDIA_ID', message: 'Invalid media identifier.', expose: true };
    res.status(appError.statusCode || 400).json({
      success: false,
      error: {
        code: appError.code || 'INVALID_MEDIA_ID',
        message: appError.expose === false ? 'Invalid media identifier.' : appError.message,
      },
    });
  }
});

/** Lightweight metadata check — does not download the media body. */
router.get('/api/validate', async (req, res) => {
  const input = typeof req.query.input === 'string' ? req.query.input : '';
  try {
    const metadata = await getMetadataForInput(input);
    res.status(200).json({
      success: true,
      id: metadata.id,
      mimeType: metadata.mimeType,
      size: metadata.size,
      name: metadata.name,
      path: `/media/${encodeURIComponent(metadata.id)}`,
    });
  } catch (error) {
    const appError = isAppError(error)
      ? error
      : { statusCode: 502, code: 'UPSTREAM_ERROR', message: 'Validation failed.', expose: true };
    res.status(appError.statusCode || 502).json({
      success: false,
      error: {
        code: appError.code || 'UPSTREAM_ERROR',
        message: appError.expose === false ? 'Validation failed.' : appError.message,
      },
    });
  }
});

export default router;
