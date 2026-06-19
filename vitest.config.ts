import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    // Include intel tests with CommonJS support
    exclude: ['node_modules/**'],
    include: ['src/__tests__/**/*.test.ts', 'src/**/tests/**/*.test.ts', 'intel/__tests__/**/*.test.mjs'],
    // Use forks pool to ensure fresh module evaluation per test file
    // (avoids Node.js module caching issues with vi.stubEnv)
    pool: 'forks',
  },
});
