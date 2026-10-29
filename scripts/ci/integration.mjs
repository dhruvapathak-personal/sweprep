import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { openSync, readFileSync, unlinkSync } from 'node:fs';
if (process.env.CI !== 'true')
  throw new Error(
    'CI-only integration requires CI=true and isolated services.',
  );

let prepared;
try {
  prepared = JSON.parse(readFileSync('.supabase-test.json', 'utf8'));
  unlinkSync('.supabase-test.json');
} catch {
  throw new Error(
    'In CI, run python3 scripts/ci/local-stack.py prepare-test before each integration run.',
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
const sqlEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('PG')),
  ),
  PGHOST: database.hostname,
  PGHOSTADDR: database.hostname,
  PGPORT: database.port,
  PGDATABASE: 'postgres',
  PGUSER: 'postgres',
  PGPASSWORD: decodeURIComponent(database.password),
  PGCONNECT_TIMEOUT: '5',
};
const sqlCheck = spawnSync('psql', ['-X', '-w', '-Atc', 'select 1'], {
  encoding: 'utf8',
  env: sqlEnv,
});
if (sqlCheck.status !== 0 || sqlCheck.stdout.trim() !== '1')
  throw new Error(
    'CI SQL is unreachable. Use isolated Linux loopback networking and psql.',
  );
const recoverySecret = randomBytes(32).toString('hex');
const contentAdmin = spawnSync(
  'psql',
  [
    '-X',
    '-w',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    'grant content_importer, content_publisher, qualification_operator, qualification_worker to postgres',
  ],
  { encoding: 'utf8', env: sqlEnv },
);
if (contentAdmin.status !== 0)
  throw new Error('Isolated content test administration is unavailable.');
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
      CONTENT_POLICY_VERSION: 'content-policy-v1',
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
        ...sqlEnv,
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
