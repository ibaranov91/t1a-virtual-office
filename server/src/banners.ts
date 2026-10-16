import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { BANNER_PATTERNS, type Banner } from '../../shared/protocol';

export const BANNER_MAX_BYTES = 1024 * 1024;
export class BannerError extends Error { constructor(public code: number, message: string) { super(message); } }
export function validateBanner(value: unknown): value is Exclude<Banner, { kind: 'image' }> | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const b = value as Record<string, unknown>;
  return typeof b.color === 'string' && /^#[0-9a-f]{6}$/i.test(b.color) &&
    (b.kind === 'color' || b.kind === 'pattern' && BANNER_PATTERNS.includes(b.pattern as typeof BANNER_PATTERNS[number]));
}
export const bannerName = (name: string) => /^[A-Za-z0-9_-]+-[0-9a-f]{12}\.(png|jpg|webp)$/.test(name);
export function validateImage(b: Buffer): { ext: 'png' | 'jpg' | 'webp'; width: number; height: number } {
  if (b.length > BANNER_MAX_BYTES) throw new BannerError(413, 'Image must be at most 1 MB.');
  let ext: 'png' | 'jpg' | 'webp' | undefined, width = 0, height = 0;
  if (b.length >= 33 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && b.readUInt32BE(8) === 13 && b.toString('ascii', 12, 16) === 'IHDR') {
    ext = 'png'; width = b.readUInt32BE(16); height = b.readUInt32BE(20);
  } else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 4 <= b.length) {
      if (b[p++] !== 0xff) break;
      while (b[p] === 0xff) p++;
      const marker = b[p++];
      if (marker === 0xda || marker === 0xd9 || p + 2 > b.length) break;
      const length = b.readUInt16BE(p);
      if (length < 2 || p + length > b.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8 || length !== 8 + 3 * b[p + 7]) break;
        ext = 'jpg'; height = b.readUInt16BE(p + 3); width = b.readUInt16BE(p + 5); break;
      }
      p += length;
    }
  } else if (b.length >= 20 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' && b.readUInt32LE(4) + 8 === b.length) {
    const kind = b.toString('ascii', 12, 16), size = b.readUInt32LE(16);
    if (20 + size <= b.length) {
      if (kind === 'VP8X' && size === 10 && b.length >= 30) { width = b.readUIntLE(24, 3) + 1; height = b.readUIntLE(27, 3) + 1; }
      if (kind === 'VP8 ' && size >= 10 && b.length >= 30 && b.subarray(23, 26).equals(Buffer.from([0x9d, 1, 0x2a]))) { width = b.readUInt16LE(26) & 0x3fff; height = b.readUInt16LE(28) & 0x3fff; }
      if (kind === 'VP8L' && size >= 5 && b.length >= 25 && b[20] === 0x2f) { const bits = b.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
      if (width && height) ext = 'webp';
    }
  }
  if (!ext) throw new BannerError(400, 'Choose a PNG, JPEG or WEBP image with a valid image header.');
  if (width < 300 || width > 1600 || height < 100 || height > 800) throw new BannerError(400, 'Image must be 300–1600 px wide and 100–800 px tall.');
  return { ext, width, height };
}

export class BannerStore {
  constructor(public dir: string) {}
  save(userId: string, bytes: Buffer, previous: Banner | null | undefined): Extract<Banner, { kind: 'image' }> {
    if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new BannerError(400, 'Bad user.');
    const { ext } = validateImage(bytes), hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    const file = `${userId}-${hash}.${ext}`, banner = { kind: 'image' as const, url: `/banners/${file}` };
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, file), bytes);
    if (previous?.kind !== 'image' || previous.url !== banner.url) this.remove(userId, previous);
    return banner;
  }
  remove(userId: string, previous: Banner | null | undefined) {
    if (previous?.kind !== 'image' || !previous.url.startsWith('/banners/')) return;
    const file = previous.url.slice(9);
    if (!bannerName(file) || !file.startsWith(`${userId}-`)) return;
    // Match the whole owner, including ids that themselves contain hyphens.
    if (file.replace(/-[0-9a-f]{12}\.(png|jpg|webp)$/, '') !== userId) return;
    try { unlinkSync(join(this.dir, file)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  serve(name: string, req: IncomingMessage, res: ServerResponse) {
    if (!bannerName(name)) { res.writeHead(404); res.end(); return; }
    const file = join(this.dir, name);
    let size: number;
    try { size = statSync(file).size; } catch { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': name.endsWith('.png') ? 'image/png' : name.endsWith('.jpg') ? 'image/jpeg' : 'image/webp',
      'content-length': size, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }
}
