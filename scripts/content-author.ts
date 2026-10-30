import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { authorOnce, authoringSql } from '../lib/content/authoring.ts';
import { compileAuthoring } from '../lib/content/authoring-contract.ts';
import {
  manifestSchema,
  bundleSchema,
  contentDigest,
} from '../lib/content/manifest.ts';
import { qualificationIntake } from '../lib/content/qualification-contract.ts';

const [mode, input, output, ...extra] = process.argv.slice(2);
try {
  if (
    extra.length ||
    !input ||
    !['open', 'once', 'export'].includes(mode) ||
    (mode === 'export') !== Boolean(output)
  )
    throw new Error('INVALID_COMMAND');
  let result: unknown;
  if (mode === 'once') result = await authorOnce(z.uuid().parse(input));
  else if (mode === 'open') {
    const bytes = readFileSync(input);
    if (bytes.length > 300000) throw new Error('INPUT_TOO_LARGE');
    result = {
      id: authoringSql('open', [
        compileAuthoring(JSON.parse(bytes.toString('utf8'))),
      ]),
    };
  } else {
    const audit = authoringSql('export', [z.uuid().parse(input)]);
    const exported = z
      .object({
        work: z.object({
          state: z.literal('authored'),
          bundle: bundleSchema,
          plan: z.object({
            spec: z.object({
              batchId: z.uuid(),
              evidence: qualificationIntake.shape.evidence,
            }),
          }),
        }),
      })
      .parse(audit);
    const body = {
      schemaVersion: 1 as const,
      policyVersion: 'content-policy-v2' as const,
      bundles: [exported.work.bundle],
    };
    const manifest = manifestSchema.parse({
      ...body,
      checksum: contentDigest(body),
    });
    const intake = qualificationIntake.parse({
      candidateId: exported.work.bundle.id,
      batchId: exported.work.plan.spec.batchId,
      evidence: exported.work.plan.spec.evidence,
    });
    writeFileSync(
      output,
      JSON.stringify({ manifest, intake, authoring: audit }, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    result = {
      exported: true,
      imported: false,
      qualified: false,
      published: false,
    };
  }
  console.info(JSON.stringify(result));
} catch (e) {
  const allowed = [
    'AUTHORING_DISABLED',
    'AUTHORING_DATABASE_REQUIRED',
    'AUTHORING_DATABASE_FAILED',
    'INPUT_TOO_LARGE',
    'STALE_LEASE',
    'LINEAGE_EXHAUSTED',
    'IMMUTABLE_REVISION_REQUIRED',
    'CODE_MISMATCH',
    'AUTHORING_INPUT_INVALID',
  ];
  console.error(
    e instanceof Error && allowed.includes(e.message)
      ? e.message
      : 'AUTHORING_FAILED',
  );
  process.exitCode = 1;
}
