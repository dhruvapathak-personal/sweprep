import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  bundleSchema,
  canonicalJson,
  contentDigest,
  validateManifest,
} from '@/lib/content/manifest';
import {
  questionBundle,
  termBundle,
  manifestFor,
} from '@/tests/fixtures/content';
import { assertContentPolicy, assertLiveGrading } from '@/lib/server/env';

describe('offline manifest contract', () => {
  it('validates metadata-only discovery separately from correctness evidence', () => {
    const bundle = questionBundle('source-roles');
    bundle.sources.push({
      ...bundle.sources[0],
      id: 'bank',
      url: 'https://interview-bank.example.test/discovery',
      role: 'discovery_context',
      intendedUse: 'Coverage discovery only.',
    });
    expect(bundleSchema.safeParse(bundle).success).toBe(true);
    bundle.claims[0].sourceIds = ['bank'];
    expect(bundleSchema.safeParse(bundle).success).toBe(false);
  });
  it('rejects unlicensed reproduction, missing attribution, and reference payloads', () => {
    const bundle = questionBundle('rights');
    bundle.sources[0].useMode = 'permitted_reuse';
    expect(bundleSchema.safeParse(bundle).success).toBe(false);
    bundle.sources[0].rightsBasis = 'Synthetic permission record.';
    bundle.sources[0].payloadDigest = 'a'.repeat(64);
    expect(bundleSchema.safeParse(bundle).success).toBe(false);
    bundle.sources[0].attribution = 'Synthetic attribution.';
    expect(bundleSchema.safeParse(bundle).success).toBe(true);
    bundle.sources[0].useMode = 'reference_only';
    expect(bundleSchema.safeParse(bundle).success).toBe(false);
  });
  it('rejects approval forgery, unmapped claims, unchecked links and missing evidence', () => {
    const bundle = questionBundle('strict');
    expect(bundleSchema.safeParse({ ...bundle, approved: true }).success).toBe(
      false,
    );
    expect(
      bundleSchema.safeParse({ ...bundle, qualification: { pass: true } })
        .success,
    ).toBe(false);
    expect(bundleSchema.safeParse({ ...bundle, sources: [] }).success).toBe(
      false,
    );
    bundle.payload.rubric.requiredClaims.push('Unmapped');
    expect(bundleSchema.safeParse(bundle).success).toBe(false);
    const term = termBundle('safe-term');
    expect(
      bundleSchema.safeParse(
        questionBundle('link', {
          terms: [
            { termId: term.id, required: true, exposure: 'pre_attempt_safe' },
          ],
        }),
      ).success,
    ).toBe(false);
  });
  it('binds digests to content, parent, evidence and ordered dependencies', () => {
    const term = termBundle('dependency');
    const question = questionBundle(
      'dependency-question',
      {},
      { dependencies: [{ id: term.id, digest: term.digest }] },
    );
    expect(
      validateManifest(manifestFor([term, question])).bundles,
    ).toHaveLength(2);
    expect(() => validateManifest(manifestFor([question, term]))).toThrow(
      'DEPENDENCY_ORDER',
    );
    const tampered = manifestFor([question]);
    tampered.bundles[0].payload.title = 'Changed';
    expect(() => validateManifest(tampered)).toThrow('CHECKSUM_MISMATCH');
    tampered.checksum = contentDigest({
      schemaVersion: tampered.schemaVersion,
      policyVersion: tampered.policyVersion,
      bundles: tampered.bundles,
    });
    expect(() => validateManifest(tampered)).toThrow('DIGEST_MISMATCH');
    expect(canonicalJson({ z: ['λ', true], a: null })).toBe(
      '{"a":null,"z":["λ",true]}',
    );
  });
  it('runs the actual dry-run CLI without database credentials or network work', () => {
    const path = join(
      mkdtempSync(join(tmpdir(), 'sweprep-manifest-')),
      'input.json',
    );
    writeFileSync(path, JSON.stringify(manifestFor([termBundle('offline')])));
    const output = execFileSync(
      process.execPath,
      ['scripts/content-import.ts', 'dry-run', path],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, NODE_ENV: 'test' },
      },
    );
    expect(JSON.parse(output)).toMatchObject({
      valid: true,
      writes: 0,
      network: false,
      qualification: 'not performed',
    });
  });
  it('rejects aggregate serialized block bytes, including multibyte text, before importing', () => {
    for (const text of ['a'.repeat(10000), 'λ'.repeat(5000)]) {
      const bundle = questionBundle('oversize-blocks', {
        blocks: [
          { type: 'text', text },
          { type: 'text', text },
        ],
      });
      expect(() => validateManifest(manifestFor([bundle]))).toThrow(
        /BLOCKS_TOO_LARGE/,
      );
      const path = join(
        mkdtempSync(join(tmpdir(), 'sweprep-block-limit-')),
        'input.json',
      );
      writeFileSync(path, JSON.stringify(manifestFor([bundle])));
      expect(() =>
        execFileSync(
          process.execPath,
          ['scripts/content-import.ts', 'dry-run', path],
          { stdio: 'pipe' },
        ),
      ).toThrow();
    }
  });
});
it('never treats an old human flag or unknown policy as authorization', () => {
  for (const [key, value] of Object.entries({
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'synthetic',
    APP_URL: 'http://localhost:3000',
    GRADING_MODE: 'live',
    CONTENT_REVIEW_APPROVED: 'true',
    CONTENT_POLICY_VERSION: 'unknown',
  }))
    vi.stubEnv(key, value);
  try {
    expect(() => assertContentPolicy()).toThrow('FEATURE_DISABLED');
    expect(() => assertLiveGrading()).toThrow('LIVE_GRADING_DISABLED');
    vi.stubEnv('CONTENT_POLICY_VERSION', '');
    expect(() => assertContentPolicy()).toThrow('FEATURE_DISABLED');
  } finally {
    vi.unstubAllEnvs();
  }
});
