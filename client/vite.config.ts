import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_PORT / DECK_PORT let a second checkout (e.g. a worktree) run beside the main one
const api = `localhost:${process.env.DECK_PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    fs: { allow: ['..'] },
    proxy: {
      '/api': `http://${api}`,
      '/ws': { target: `ws://${api}`, ws: true },
    },
  },
});
