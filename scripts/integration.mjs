import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { openSync, readFileSync, unlinkSync } from 'node:fs';

let prepared;
try {
  prepared = JSON.parse(readFileSync('.supabase-test.json', 'utf8'));
  unlinkSync('.supabase-test.json');
} catch {
  throw new Error(
    'On the host, run python3 scripts/local-stack.py prepare-test before each integration run.',
  );
}
const { status, preparedAt } = prepared;
let database;
try {
  const api = new URL(status.API_URL);
  database = new URL(status.DB_URL);
  if (
    typeof preparedAt !== 'number' ||
    Date.now() / 1000 - preparedAt < 0 ||
    Date.now() / 1000 - preparedAt > 1800 ||
    api.origin !== 'http://127.0.0.1:54321' ||
    api.pathname !== '/' ||
    api.username ||
    api.password ||
    api.search ||
    api.hash ||
    database.protocol !== 'postgresql:' ||
    database.hostname !== '127.0.0.1' ||
    database.port !== '54322' ||
    database.pathname !== '/postgres' ||
    database.username !== 'postgres' ||
    database.search ||
    database.hash ||
    !status.ANON_KEY ||
    !status.SERVICE_ROLE_KEY
  )
    throw new Error();
} catch {
  throw new Error('Fresh isolated loopback Supabase preparation is required.');
}
const sqlCheck = spawnSync('psql', ['-X', '-w', '-Atc', 'select 1'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    PGHOST: database.hostname,
    PGPORT: database.port,
    PGDATABASE: 'postgres',
    PGUSER: 'postgres',
    PGPASSWORD: decodeURIComponent(database.password),
    PGCONNECT_TIMEOUT: '5',
  },
});
if (sqlCheck.status !== 0 || sqlCheck.stdout.trim() !== '1')
  throw new Error(
    'Local SQL is unreachable. Use the app container with Linux host networking and psql.',
  );
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
        PGHOST: database.hostname,
        PGPORT: database.port,
        PGDATABASE: 'postgres',
        PGUSER: 'postgres',
        PGPASSWORD: decodeURIComponent(database.password),
        PGCONNECT_TIMEOUT: '5',
      },
    },
  );
  process.exitCode = result.status ?? 1;
} finally {
  server.kill('SIGTERM');
}
