import axios from 'axios';

// Direct streaming without saving
export const handleDirectStream = async (res, id) => {
  try {
    const downloadUrl = `https://drive.usercontent.google.com/download?id=${id}&export=download`;

    const response = await axios.get(downloadUrl, {
      responseType: 'stream',
      maxRedirects: 5,
      timeout: 15000,
    });

    // Set proper headers
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour cache

    // Stream directly to client
    response.data.pipe(res);

    // Handle stream errors
    response.data.on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: 'Stream error',
          error: err.message
        });
      }
    });

  } catch (error) {
    console.error('Direct stream failed:', error.message);
    res.status(500).json({
      success: false,
      message: 'Direct download failed',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
};
