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
import {
  qualificationTask,
  validateQualificationTask,
} from '@/lib/content/qualification-contract';
import { authoringSpec } from '@/tests/fixtures/authoring';
import { modelOutput, syntheticPackage } from '@/tests/fixtures/evaluation';

describe('offline manifest contract', () => {
  it('requires exactly the supplied critic links, including an empty set', () => {
    const input = syntheticPackage();
    const clear = input.dataset.cases.find((c) => c.id === 'critic-clear')!;
    const linked = input.dataset.cases.find((c) => c.id === 'critic-spoiler')!;
    const finding = {
      termId: (linked.candidate as ReturnType<typeof questionBundle>).payload
        .terms[0].termId,
      exposure: 'pre_attempt_safe',
      verdict: 'safe',
      reason: 'Synthetic contextual check.',
    };
    for (const entry of [clear, linked]) {
      const work = {
        ...entry,
        candidate: entry.candidate as ReturnType<typeof questionBundle>,
        artifacts: { fixtures: entry.fixtures },
      };
      const output = modelOutput(entry) as Record<string, unknown>;
      const valid = entry === clear ? [] : [finding];
      expect(() =>
        validateQualificationTask(work, { ...output, links: valid }),
      ).not.toThrow();
      const invalid = [
        [
          ...valid,
          { ...finding, termId: '20000000-0000-4000-8000-000000000001' },
        ],
        ...(entry === linked
          ? [
              [],
              [finding, finding],
              [{ ...finding, termId: '20000000-0000-4000-8000-000000000002' }],
              [{ ...finding, exposure: 'post_grade_only' }],
              [{ ...finding, verdict: 'spoiler_or_uncertain' }],
            ]
          : []),
      ];
      for (const links of invalid)
        expect(() =>
          validateQualificationTask(work, { ...output, links }),
        ).toThrow('CHECK_FAILED');
      for (const flags of [
        { privacy: 'private_or_uncertain' },
        { originality: 'reuse_or_uncertain' },
        { objections: ['Unresolved factual issue.'] },
      ])
        expect(() =>
          validateQualificationTask(work, {
            ...output,
            links: valid,
            ...flags,
          }),
        ).toThrow('CHECK_FAILED');
    }
  });
  it('shares neutral anchors without assigning grader-only duties to other roles', () => {
    const candidate = questionBundle('synthetic-role-boundaries');
    for (const stage of ['source', 'fixtures', 'critic']) {
      const task = qualificationTask(
        { stage, candidate, evidence: [], dependencies: [], artifacts: {} },
        false,
      );
      expect(task.instructions).not.toContain('Grade only');
      expect(task.instructions).not.toContain('Return uncertain');
      expect(task.instructions).not.toContain('Explain evidence and missing');
      expect(task.instructions).toContain('One of two');
      expect(task.instructions).toContain('every component');
    }
  });
  it('keeps verbatim membership distinct from semantic support, privacy and reproduction rights', () => {
    const candidate = questionBundle('synthetic-grounding');
    const spec = authoringSpec(candidate);
    const work = {
      candidate,
      evidence: spec.evidence,
      stage: 'source',
      dependencies: [],
      artifacts: {},
    };
    const output = {
      independentAnswer: 'Synthetic independent assessment.',
      claims: candidate.claims.map((c) => ({
        claim: c.claim,
        sourceId: c.sourceIds[0],
        quote: c.claim,
        verdict: 'supported',
        reason: 'The synthetic source states the mapped claim.',
      })),
      privacy: 'public',
      originality: 'original',
      issues: [],
      executionRequired: false,
      executionPlan: [],
    };
    expect(() => validateQualificationTask(work, output)).not.toThrow();
    for (const quote of [
      'synthetic fixture claim.',
      'Synthetic  fixture claim.',
      'Synthetic fixture…',
    ])
      expect(() =>
        validateQualificationTask(work, {
          ...output,
          claims: [{ ...output.claims[0], quote }],
        }),
      ).toThrow('CHECK_FAILED');
    for (const finding of [
      { privacy: 'private_or_uncertain' },
      { originality: 'reuse_or_uncertain' },
      {
        claims: [
          {
            ...output.claims[0],
            verdict: 'unsupported',
            reason: 'The exact substring does not support this assertion.',
          },
        ],
      },
    ])
      expect(() =>
        validateQualificationTask(work, { ...output, ...finding }),
      ).toThrow('CHECK_FAILED');
    expect(qualificationTask(work, false).instructions).toContain(
      'Substring membership is not factual support',
    );
    const critic = qualificationTask({ ...work, stage: 'critic' }, false);
    expect(critic.instructions).toContain(
      'do not reject a wrong-answer fixture merely because the answer is false',
    );
    expect(critic.input).not.toContain(output.independentAnswer);
  });
  it('rejects null, reversed, threshold-crossing and mislabeled scored fixture expectations', () => {
    const candidate = questionBundle('synthetic-fixtures');
    const spec = authoringSpec(candidate);
    const work = {
      candidate,
      evidence: spec.evidence,
      stage: 'fixtures',
      dependencies: [],
      artifacts: {},
    };
    const cases = [
      'wrong',
      'partial',
      'borderline_pass',
      'strong',
      'non_answer',
    ].map((kind, i) => ({
      kind,
      answer: `Synthetic ${kind}`,
      expected: 'scored',
      minScore: [0, 1, 4, 4, 0][i],
      maxScore: [0, 2, 4, 5, 0][i],
      expectedPass: i === 2 || i === 3,
      reason: 'Frozen synthetic expectation.',
      basis: [
        {
          claim: candidate.claims[0].claim,
          sourceId: spec.evidence[0].sourceId,
          quote: spec.evidence[0].text,
        },
      ],
    }));
    expect(() => validateQualificationTask(work, { cases })).not.toThrow();
    for (const change of [
      { minScore: null },
      { minScore: 5, maxScore: 4 },
      { minScore: 3 },
      { expectedPass: false },
      { expected: 'uncertain' },
    ]) {
      const altered = structuredClone(cases);
      Object.assign(altered[2], change);
      expect(() =>
        validateQualificationTask(work, { cases: altered }),
      ).toThrow();
    }
  });
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
