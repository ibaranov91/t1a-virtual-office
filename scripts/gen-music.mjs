// Builds the jukebox library from scripts/music.json: downloads each CC0 original into .music-src/ (gitignored),
// converts it to a loudness-matched, streamable AAC file client/public/assets/music/<id>-<hash>.m4a (a re-encode
// gets a new URL, so caches never mix versions), and writes the catalog
// shared/music.json plus CREDITS.md. Needs ffmpeg + ffprobe. Run: npm run gen:music [-- --force]
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url).pathname;
const SRC = `${root}.music-src/`, OUT = `${root}client/public/assets/music/`;
const force = process.argv.includes('--force');
const list = JSON.parse(await readFile(`${root}scripts/music.json`, 'utf8'));

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
try { run('ffmpeg', ['-version']); run('ffprobe', ['-version']); } catch { throw new Error('ffmpeg and ffprobe are needed (brew install ffmpeg)'); }

const ids = new Set();
for (const t of list) {
  for (const k of ['id', 'title', 'artist', 'genre', 'url', 'page', 'license']) if (!t[k]) throw new Error(`${t.id ?? '?'}: missing ${k}`);
  if (!/^[a-z0-9-]+$/.test(t.id)) throw new Error(`${t.id}: id must be [a-z0-9-]+`);
  if (ids.has(t.id)) throw new Error(`${t.id}: duplicate id`);
  if (!/^CC0\b/.test(t.license)) throw new Error(`${t.id}: not CC0 (${t.license})`);
  ids.add(t.id);
}
mkdirSync(SRC, { recursive: true }); mkdirSync(OUT, { recursive: true });

const tracks = [];
for (const t of list) {
  const ext = (new URL(t.url).pathname.match(/\.(mp3|ogg|flac|wav|m4a)$/i)?.[1] ?? 'mp3').toLowerCase();
  const src = `${SRC}${t.id}.${ext}`, mine = readdirSync(OUT).filter(f => /^[a-z0-9-]+-[0-9a-f]{8}\.m4a$/.test(f) && f.slice(0, -13) === t.id);
  let file = mine[0];
  if (force || !file) {
    if (!existsSync(src)) {
      process.stdout.write(`↓ ${t.id}… `);
      const res = await fetch(t.url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`${t.id}: download ${res.status}`);
      writeFileSync(src, Buffer.from(await res.arrayBuffer()));
      console.log('ok');
    }
    // two-pass loudnorm: measure, then normalize with the measured values (linear, no pumping)
    const { stderr } = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', src, '-af', 'loudnorm=I=-18:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
    const at = stderr.lastIndexOf('{'), m = JSON.parse(stderr.slice(at, stderr.indexOf('}', at) + 1));
    const af = `loudnorm=I=-18:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vn', '-map_metadata', '-1', '-af', af,
      '-c:a', 'aac', '-b:a', '80k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', `${OUT}.tmp.m4a`]);
    file = `${t.id}-${createHash('sha1').update(readFileSync(`${OUT}.tmp.m4a`)).digest('hex').slice(0, 8)}.m4a`;
    renameSync(`${OUT}.tmp.m4a`, `${OUT}${file}`);
    console.log(`♪ ${file}`);
  }
  const duration = Math.round(Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', `${OUT}${file}`]).trim()) * 1000);
  if (!(duration >= 60_000 && duration <= 360_000)) throw new Error(`${t.id}: duration ${duration} ms outside 60 s–6 min`);
  tracks.push({ id: t.id, file, title: t.title, artist: t.artist, genre: t.genre, duration, page: t.page, license: t.license });
}
const keep = new Set(tracks.map(t => t.file));
for (const f of readdirSync(OUT)) if (f.endsWith('.m4a') && !keep.has(f)) { rmSync(`${OUT}${f}`); console.log(`✕ ${f}`); }

writeFileSync(`${root}shared/music.json`, JSON.stringify({ tracks }, null, 2) + '\n');
writeFileSync(`${OUT}CREDITS.md`, `# Jukebox music\n\nAll tracks are CC0 (public domain). Thank you to the artists.\n\n| Title | Artist | Genre | License | Source |\n|---|---|---|---|---|\n${tracks.map(t => `| ${t.title} | ${t.artist} | ${t.genre} | ${t.license} | ${t.page} |`).join('\n')}\n`);
console.log(`${tracks.length} tracks, ${Math.round(tracks.reduce((s, t) => s + t.duration, 0) / 60_000)} min`);
