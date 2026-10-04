const EXTENSION_TO_MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  pdf: 'application/pdf',
};

const INLINE_PREFIXES = ['image/', 'video/', 'audio/'];
const INLINE_TYPES = new Set(['application/pdf', 'application/ogg', 'text/plain']);
const BLOCKED = new Set(['text/html', 'application/javascript', 'text/javascript']);

export function mimeFromFilename(name) {
  if (!name) return undefined;
  const ext = name.split('.').pop()?.toLowerCase();
  return ext ? EXTENSION_TO_MIME[ext] : undefined;
}

export function sanitizeMimeType(raw, fallbackName) {
  const candidate = (raw ?? '').split(';')[0]?.trim().toLowerCase();
  if (!candidate || BLOCKED.has(candidate) || candidate === 'application/octet-stream') {
    return mimeFromFilename(fallbackName) ?? 'application/octet-stream';
  }
  if (!/^[a-z0-9!#$&\-\^_.+]+\/[a-z0-9!#$&\-\^_.+]+$/.test(candidate)) {
    return mimeFromFilename(fallbackName) ?? 'application/octet-stream';
  }
  return candidate;
}

export function contentDispositionFor(mimeType, filename) {
  const inline =
    INLINE_TYPES.has(mimeType) || INLINE_PREFIXES.some((p) => mimeType.startsWith(p));
  const disposition = inline ? 'inline' : 'attachment';
  if (!filename) return disposition;
  return `${disposition}; filename="${filename.replace(/["\r\n]/g, '_')}"`;
}
