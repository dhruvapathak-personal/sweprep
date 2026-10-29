import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  qualificationConfiguration,
  qualificationIntake,
  qualificationSql,
  qualifyOnce,
} from '../lib/content/qualification.ts';

const [mode, path, ...extra] = process.argv.slice(2);
try {
  if (
    extra.length ||
    !['batch', 'enqueue', 'once'].includes(mode) ||
    (mode !== 'once' && !path)
  )
    throw new Error('INVALID_COMMAND');
  let result: unknown;
  if (mode === 'once') {
    result = await qualifyOnce(path ? z.uuid().parse(path) : null);
  } else {
    const bytes = readFileSync(path);
    if (bytes.length > 300000) throw new Error('INPUT_TOO_LARGE');
    const raw: unknown = JSON.parse(bytes.toString('utf8'));
    if (mode === 'batch') {
      const config = qualificationConfiguration.parse(raw);
      result = { batchId: qualificationSql('open_batch', [config]) };
    } else {
      const intake = qualificationIntake.parse(raw);
      result = {
        jobId: qualificationSql('enqueue', [
          intake.candidateId,
          intake.batchId,
          intake.evidence,
        ]),
      };
    }
  }
  if (typeof result === 'object' && result !== null && 'state' in result) {
    const { id, state, reason, requestsUsed } = result as Record<
      string,
      unknown
    >;
    result = { id, state, reason, requestsUsed };
  }
  console.info(JSON.stringify(result));
} catch (error) {
  const allowed = [
    'QUALIFICATION_DISABLED',
    'QUALIFICATION_DATABASE_REQUIRED',
    'QUALIFICATION_DATABASE_FAILED',
    'INPUT_TOO_LARGE',
    'STALE_LEASE',
    'LINEAGE_EXHAUSTED',
    'IMMUTABLE_REVISION_REQUIRED',
  ];
  console.error(
    error instanceof Error && allowed.includes(error.message)
      ? error.message
      : 'QUALIFICATION_FAILED',
  );
  process.exitCode = 1;
}
