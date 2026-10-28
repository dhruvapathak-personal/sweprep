import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { validateManifest } from '../lib/content/manifest.ts';

const [mode, path, ...extra] = process.argv.slice(2);
if (!['dry-run', 'import'].includes(mode) || !path || extra.length)
  throw new Error(
    'Usage: node scripts/content-import.ts dry-run|import manifest.json',
  );
const bytes = readFileSync(path);
if (bytes.byteLength > 1_000_000) throw new Error('MANIFEST_TOO_LARGE');
const manifest = validateManifest(JSON.parse(bytes.toString('utf8')));
if (mode === 'dry-run') {
  console.info(
    JSON.stringify({
      valid: true,
      candidates: manifest.bundles.length,
      checksum: manifest.checksum,
      qualification: 'not performed',
      writes: 0,
      network: false,
    }),
  );
} else {
  if (!process.env.PGSERVICE)
    throw new Error(
      'Import requires an explicitly configured PGSERVICE for the content importer.',
    );
  const result = spawnSync(
    'psql',
    ['-X', '-w', '-v', 'ON_ERROR_STOP=1', '-At'],
    {
      input: `select private.import_content_manifest('${JSON.stringify(manifest).replaceAll("'", "''")}'::jsonb);\n`,
      encoding: 'utf8',
      maxBuffer: 2_000_000,
    },
  );
  if (result.status !== 0) throw new Error('IMPORT_FAILED');
  console.info(result.stdout.trim());
}
