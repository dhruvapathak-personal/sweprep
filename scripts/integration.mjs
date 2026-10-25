import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { openSync } from 'node:fs';

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
const recoverySecret = randomBytes(32).toString('hex');
const baseUrl = 'http://localhost:3001';
const log = openSync('/tmp/sweprep-integration-app.log', 'w', 0o600);
const server = spawn(
  process.execPath,
  [
    'node_modules/next/dist/bin/next',
    'start',
    '--port',
    '3001',
    '--hostname',
    '127.0.0.1',
  ],
  {
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
      RECOVERY_SECRET: recoverySecret,
      APP_URL: baseUrl,
      GRADING_MODE: 'simulated',
      ALLOW_LOCAL_SIMULATION: 'true',
    },
  },
);
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      ready = (await fetch(baseUrl)).ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready)
    throw new Error(
      'Build first: the integration app did not start. See /tmp/sweprep-integration-app.log',
    );
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
        TEST_APP_URL: baseUrl,
        TEST_RECOVERY_SECRET: recoverySecret,
      },
    },
  );
  process.exitCode = result.status ?? 1;
} finally {
  server.kill('SIGTERM');
}
