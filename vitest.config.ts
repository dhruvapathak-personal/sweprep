import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve('.'),
      'server-only': path.resolve('tests/server-only.ts'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 30000,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'live',
          include: ['tests/live/**/*.test.ts'],
          testTimeout: 60000,
          fileParallelism: false,
        },
      },
    ],
  },
});
