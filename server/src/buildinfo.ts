// One source for what is running: package version, git commit and when this process started. The web build id is
// baked into the client by Vite (client/vite.config.ts) and compared with this one in the UI.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const read = (p: string) => { try { return readFileSync(fileURLToPath(new URL(p, root)), 'utf8').trim(); } catch { return ''; } };
function sha() {
  const deployed = read('.deployed-rev').split(' ')[0]; // deploy.sh records the commit (and "-dirty") it shipped; there is no .git on the box
  if (deployed) return deployed.replace(/^([0-9a-f]{7})[0-9a-f]*/, '$1');
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: fileURLToPath(root), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return 'unknown'; }
}
export interface ServerVersion { version: string; sha: string; startedAt: number }
const startedAt = Date.now();
let cached: { at: number; v: ServerVersion } | null = null;
/** Read per call (cached 30 s): deploy.sh writes .deployed-rev after it restarts the service. */
export function serverVersion(): ServerVersion {
  if (cached && Date.now() - cached.at < 30_000) return cached.v;
  let version = '0.0.0';
  try { version = JSON.parse(read('package.json') || '{}').version ?? version; } catch { /* keep default */ }
  cached = { at: Date.now(), v: { version, sha: sha(), startedAt } };
  return cached.v;
}
