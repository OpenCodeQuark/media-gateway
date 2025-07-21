import fs from 'fs/promises';
import path from 'path';

export const serveFile = async (req, res) => {
  const filesDir = path.join(process.cwd(), 'files');

  const fileId = req.params.id;
  if (!fileId?.trim()) {
    console.error('Invalid file ID');
    return res.status(404).json({
      success: false,
      message: 'Resource not found',
    });
  }

  const filePath = path.join(filesDir, fileId);

  try {
    // Check file existence
    await fs.access(filePath);

    // Set cache headers (5 minutes)
    res.setHeader('Cache-Control', 'public, max-age=300');

    // Send file without blocking event loop
    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) {
        console.error('Send error:', err.message);
        res.status(err.status || 500).json({
          success: false,
          message: 'File delivery failed'
        });
      }
    });

  } catch (error) {
    res.status(404).json({
      success: false,
      message: 'Resource not found',
    });
  }
};
