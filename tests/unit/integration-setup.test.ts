import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

const runner = path.resolve('scripts/integration.mjs');
it('requires a fresh one-use host reset and rejects hosted or bridged services before SQL', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sweprep-setup-'));
  const receipt = path.join(directory, '.supabase-test.json');
  const run = () =>
    spawnSync(process.execPath, [runner], {
      cwd: directory,
      encoding: 'utf8',
    });
  try {
    expect(run().stderr).toContain('prepare-test');
    const status = {
      API_URL: 'http://127.0.0.1:54321',
      DB_URL: 'postgresql://postgres:synthetic@127.0.0.1:54322/postgres',
      ANON_KEY: 'synthetic',
      SERVICE_ROLE_KEY: 'synthetic',
    };
    for (const prepared of [
      { status, preparedAt: Date.now() / 1000 - 1801 },
      {
        status: { ...status, API_URL: 'https://project.supabase.co' },
        preparedAt: Date.now() / 1000,
      },
      {
        status: { ...status, API_URL: 'http://host.containers.internal:54321' },
        preparedAt: Date.now() / 1000,
      },
    ]) {
      writeFileSync(receipt, JSON.stringify(prepared));
      const result = run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Fresh isolated loopback');
      expect(existsSync(receipt)).toBe(false);
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});
