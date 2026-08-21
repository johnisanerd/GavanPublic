import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { buildPublicEnvScript } from './server/public-env';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dev mirror of the server's runtime PUBLIC_ injection (server/public-env.ts):
// reads PUBLIC_* from the loaded .env and injects window.__PUBLIC_ENV__ so the
// client uses the exact same mechanism in dev as in prod.
function publicEnvPlugin(mode: string): Plugin {
  const env = loadEnv(mode, process.cwd(), 'PUBLIC_');
  const script = buildPublicEnvScript(env);
  return {
    name: 'pat-public-env',
    // serve-only: in `vite build` the server injects at runtime, so the built
    // dist/index.html must stay key-free (no baked build-arg, the whole point).
    apply: 'serve',
    transformIndexHtml: (html) =>
      html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${script}${html}`,
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), publicEnvPlugin(mode)],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    // Default to the deployed pat-frontend so `bun run dev` hits real
    // production events without standing up a local Hono+nanoclaw stack.
    // Override via PAT_DEV_UPSTREAM=http://localhost:8787 if you do want
    // a fully local stack.
    proxy: {
      '/api': {
        target: process.env.PAT_DEV_UPSTREAM ?? 'https://pat-frontend.fly.dev',
        changeOrigin: true,
        secure: true,
      },
      '/healthz': {
        target: process.env.PAT_DEV_UPSTREAM ?? 'https://pat-frontend.fly.dev',
        changeOrigin: true,
        secure: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
}));
