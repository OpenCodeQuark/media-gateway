
import express from "express";
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { getImageExtension } from './utils/getExtension.js';
import { scheduleCleanup } from './utils/fileCleanup.js';
import { handleDirectStream } from './utils/streamHandler.js';
import { serveFile } from './utils/fileHandler.js'; 

const app = express();
const filesDir = path.join(process.cwd(), 'files');

// File download endpoint
app.get("/file", async (req, res) => {
  const { id, type, stream = "no" } = req.query;

  // Validate parameters
  if (!id?.trim() || type !== 'image') {
    return res.status(404).json({
      success: false,
      message: 'Resource not found',
    });
  }

  if (stream === "yes") {
    return handleDirectStream(res, id);
  }

  try {
    const downloadUrl = `https://drive.usercontent.google.com/download?id=${id}&export=download`;

    // Fetch file with timeout
    const response = await axios.get(downloadUrl, {
      responseType: 'stream',
      maxRedirects: 5,
      timeout: 15000, // 15 seconds timeout
    });

    const contentType = response.headers['content-type'];
    const extension = getImageExtension(contentType) || '.bin';
    const filename = `${crypto.randomBytes(8).toString('hex')}${extension}`;
    const filePath = path.join(filesDir, filename);

    // Stream to file
    await new Promise((resolve, reject) => {
      const writer = response.data.pipe(fs.createWriteStream(filePath));
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // Temporary redirect to file
    res.redirect(302, `/files/img/${filename}`);

  } catch (error) {
    console.error('Download failed:', error.message);
    res.status(500).json({
      success: false,
      message: 'Download failed',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
});

app.get("/files/img/:id", serveFile); // Serve files from the 'files' directory

// Error handlers (same as before)
app.use((req, res) => res.status(404).json({ success: false, message: 'Resource not found' }));
app.use((err, req, res, next) => {
  console.error("Server Error:", err.message);
  res.status(500).json({
    success: false,
    message: 'Internal Server Error',
    error: process.env.NODE_ENV === 'production' ? undefined : err.message
  });
});

// Start file cleanup scheduler
scheduleCleanup(filesDir, 60); // Clean every 60 minutes

export default app;
