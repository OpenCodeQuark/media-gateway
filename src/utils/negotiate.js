/** Browser page loads ask for HTML. API and media clients do not. */
export function wantsHtml(req) {
  const path = req.path || '';
  if (path.startsWith('/api/')) return false;
  return String(req.headers.accept || '').includes('text/html');
}
