import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg',
};

export function serveStatic(dir: string, req: IncomingMessage, res: ServerResponse) {
  const root = resolve(dir);
  let rel = '';
  try { rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^([/\\]|\.\.)+/, ''); } catch { /* fall back to index */ }
  let file = join(root, rel);
  if (!file.startsWith(root + sep) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
  const size = statSync(file).size;
  const headers: Record<string, string | number> = {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': file.includes('/assets/') && /-[\w-]{8}\./.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'accept-ranges': 'bytes', 'content-length': size,
  };
  let start = 0, end = size - 1, status = 200;
  const range = req.method === 'HEAD' ? null : req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), end); }
    else start = Math.max(0, size - Number(range[2]));
    if (start >= size || end < start || (!range[1] && Number(range[2]) === 0)) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${size}`, 'content-length': 0 }); res.end(); return;
    }
    status = 206; headers['content-range'] = `bytes ${start}-${end}/${size}`; headers['content-length'] = end - start + 1;
  }
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) { res.end(); return; }
  createReadStream(file, { start, end }).pipe(res);
}
