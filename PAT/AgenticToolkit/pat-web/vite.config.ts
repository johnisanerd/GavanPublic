import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: process.env.PAT_WEB_UPSTREAM ?? 'http://localhost:8788',
        changeOrigin: true,
        secure: false,
        // PAT 2026-05-23: forward WebSocket upgrade requests too. The
        // realtime hook hits `/api/realtime` and needs the upgrade to
        // proxy through to the Bun server. Without `ws:true` vite
        // would 426-Upgrade-Required the WS handshake.
        ws: true,
      },
      '/healthz': {
        target: process.env.PAT_WEB_UPSTREAM ?? 'http://localhost:8788',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
