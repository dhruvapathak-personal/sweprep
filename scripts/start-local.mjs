import { execFileSync } from 'node:child_process';

try {
  execFileSync('npx', ['--no-install', 'supabase', 'start'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log(
    'Local Supabase started. Run npm run setup:local to write private configuration.',
  );
} catch {
  throw new Error(
    'Local Supabase did not start. Check the Docker daemon and available ports 54320–54324; no credentials were printed.',
  );
}
