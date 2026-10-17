// Build info: the web build id is baked in by Vite (vite.config.ts); the server's comes from /api/version.
declare const __WEB_BUILD__: { version: string; sha: string; builtAt: string } | undefined;
export interface ServerVersion { version: string; sha: string; startedAt: number }
export const webBuild = typeof __WEB_BUILD__ !== 'undefined' ? __WEB_BUILD__ : { version: 'dev', sha: 'dev', builtAt: '' };

/** One line for the sidebar: the server's version, and the web build only when it differs (an old tab after a deploy). */
export function versionLine(server: ServerVersion | null, web = webBuild) {
  if (!server) return `v${web.version} · ${web.sha}`;
  const stale = web.sha !== server.sha && web.sha !== 'unknown' && server.sha !== 'unknown';
  return `v${server.version} · ${server.sha}${stale ? ` · page ${web.sha}, reload` : ''}`;
}
export function versionTitle(server: ServerVersion | null, web = webBuild) {
  return [server ? `Server v${server.version} (${server.sha}), up since ${new Date(server.startedAt).toLocaleString()}` : 'Server version unknown', `Page v${web.version} (${web.sha})${web.builtAt ? `, built ${new Date(web.builtAt).toLocaleString()}` : ''}`].join('\n');
}
export async function fetchServerVersion(): Promise<ServerVersion | null> {
  try { const r = await fetch('/api/version', { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}
