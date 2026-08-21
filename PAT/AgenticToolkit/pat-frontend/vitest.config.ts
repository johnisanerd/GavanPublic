/**
 * Vitest config for pat-frontend.
 *
 * Scope: smoke checks on the dashboard tab components and the new
 * server-side DB module. Not behavioral coverage — those tests live
 * in trace-e2e/ and smoketest/ per the project's testing convention
 * (see AGENTS.md "Trace-based end-to-end tests").
 *
 * Environment: happy-dom (lighter than jsdom, good enough for hook
 * mount + JSX render checks). The `@` alias mirrors vite.config.ts.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: false,
    include: ['src/**/*.test.{ts,tsx}', 'server/**/*.test.ts'],
    css: false,
  },
});
