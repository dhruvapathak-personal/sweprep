import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier/flat';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    files: [
      'components/**/*.{ts,tsx}',
      'lib/contracts/**/*.ts',
      'lib/domain/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['@/lib/server/*', '**/lib/server/*'],
          paths: [
            {
              name: 'openai',
              message: 'Provider access belongs in the server adapter.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['lib/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['next/*', '@supabase/*', '@/lib/server/*'],
          paths: ['openai', 'react'],
        },
      ],
    },
  },
  globalIgnores([
    '.next/**',
    'node_modules/**',
    'lib/contracts/database.types.ts',
    'supabase/.temp/**',
  ]),
]);
