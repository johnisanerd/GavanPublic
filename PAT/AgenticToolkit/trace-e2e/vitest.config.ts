import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@harness': path.resolve(__dirname, 'src/harness'),
    },
  },
  test: {
    // Each scenario test drives a real session — generous per-test
    // budget; the test bodies set their own narrower timeouts.
    testTimeout: 5 * 60 * 1000,
    hookTimeout: 30 * 1000,
    // Trace tests are inherently serial (they share a nanoclaw + a
    // back-mind container slot). Force sequential execution.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    fileParallelism: false,
    sequence: { concurrent: false },
    reporters: 'verbose',
    include: ['src/tests/**/*.test.ts', 'src/harness/**/*.test.ts'],
  },
});
