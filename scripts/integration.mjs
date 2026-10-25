import { execFileSync, spawnSync } from 'node:child_process';

const status = JSON.parse(
  execFileSync('npx', ['--no-install', 'supabase', 'status', '-o', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
);
if (new URL(status.API_URL).hostname !== '127.0.0.1')
  throw new Error(
    'Integration tests require the isolated local Supabase stack.',
  );
execFileSync('npx', ['--no-install', 'supabase', 'db', 'reset', '--local'], {
  stdio: 'inherit',
});
const result = spawnSync(
  'npx',
  ['--no-install', 'vitest', 'run', '--project', 'integration'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      TEST_SUPABASE_URL: status.API_URL,
      TEST_SUPABASE_KEY: status.ANON_KEY,
      TEST_SERVICE_KEY: status.SERVICE_ROLE_KEY,
    },
  },
);
process.exitCode = result.status ?? 1;
