
// Helper function to get image extension from MIME type
export const  getImageExtension =(mimeType) => {
  const extensions = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
  };
  return extensions[mimeType] || null;
}
