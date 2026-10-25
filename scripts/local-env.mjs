import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

if (existsSync('.env.local'))
  throw new Error(
    '.env.local already exists; keep the current local configuration.',
  );
const status = JSON.parse(
  execFileSync('npx', ['--no-install', 'supabase', 'status', '-o', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
);
const values = {
  NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.ANON_KEY,
  APP_URL: 'http://localhost:3000',
  SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  RECOVERY_SECRET: randomBytes(32).toString('hex'),
  GRADING_MODE: 'simulated',
  ALLOW_LOCAL_SIMULATION: 'true',
  AI_DAILY_CAP_CENTS: '0',
  AI_MONTHLY_CAP_CENTS: '0',
};
writeFileSync(
  '.env.local',
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n') + '\n',
  { mode: 0o600, flag: 'wx' },
);
console.log(
  'Local configuration written. Simulated grading only; no provider calls.',
);
