import { networkInterfaces } from 'node:os';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// VITE_PORT / DECK_PORT let a second checkout (e.g. a worktree) run beside the main one.
// The API listens on 127.0.0.1 in dev; the browser always reaches it through this proxy.
const api = `127.0.0.1:${process.env.DECK_PORT ?? 8787}`;

// `npm run dev:mesh`: reachable on localhost and on this machine's Meshnet address (100.64.0.0/10, e.g. NordVPN
// Meshnet), nowhere else, over HTTPS so other devices get microphone access for voice. Override with DECK_MESH_IP.
// (Meshnet doesn't route a machine to its own address, so we listen on all interfaces and filter by the
// address each connection arrived on, instead of binding the Meshnet IP alone.)
const mesh = !!process.env.DECK_MESH;
const meshIp = () => {
  if (process.env.DECK_MESH_IP) return process.env.DECK_MESH_IP;
  for (const addrs of Object.values(networkInterfaces())) for (const a of addrs ?? []) {
    if (a.family !== 'IPv4') continue;
    const [o1, o2] = a.address.split('.').map(Number);
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return a.address;
  }
  throw new Error('dev:mesh: no Meshnet (100.64.0.0/10) address found; is Meshnet on? Set DECK_MESH_IP to override.');
};

/** Drop anything that didn't arrive on loopback or the Meshnet address (e.g. café Wi-Fi). */
const onlyMeshAndLocal = (ip: string): Plugin => {
  const ok = (a?: string) => !!a && [ip, '127.0.0.1', '::1'].includes(a.replace(/^::ffff:/, ''));
  return {
    name: 'deck-mesh-only',
    configureServer(server) {
      server.httpServer?.prependListener('connection', socket => { if (!ok(socket.localAddress)) socket.destroy(); });
      server.middlewares.use((req, res, next) => (ok(req.socket.localAddress) ? next() : (res.statusCode = 403, res.end())));
    },
  };
};
const meshAddr = mesh ? meshIp() : '';

export default defineConfig({
  plugins: [react(), ...(mesh ? [basicSsl(), onlyMeshAndLocal(meshAddr)] : [])],
  build: {
    // React gets its own chunk, so the many deploys a day don't make browsers download it again.
    rollupOptions: { output: { manualChunks: { react: ['react', 'react-dom'] } } },
    // The app chunk (~550 kB, ~170 kB gzipped) and the lazy pdf.js chunk (~540 kB) are both expected sizes.
    chunkSizeWarningLimit: 600,
  },
  server: {
    host: mesh ? '0.0.0.0' : 'localhost',
    port: Number(process.env.VITE_PORT ?? 5173),
    strictPort: true,
    fs: { allow: ['..'] },
    proxy: {
      '/api': { target: `http://${api}`, xfwd: true }, // x-forwarded-host: the Mac install command names this origin
      '/ws': { target: `ws://${api}`, ws: true },
    },
  },
});
