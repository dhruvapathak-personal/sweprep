import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  authoredBundle,
  compileAuthoring,
} from '@/lib/content/authoring-contract';
import { authorOnce } from '@/lib/content/authoring';
import { authoringSpec } from '@/tests/fixtures/authoring';
import { questionBundle, termBundle } from '@/tests/fixtures/content';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('snapshot-only conceptual authoring', () => {
  it('freezes ordinary and repair requests and derives immutable question and term manifests', () => {
    for (const bundle of [
      questionBundle('synthetic-author'),
      termBundle('synthetic-term'),
    ]) {
      const spec = authoringSpec(bundle);
      const plan = compileAuthoring(spec);
      expect(plan.requests.original.store).toBe(false);
      expect(plan.requests.original.instructions).not.toContain('Grade only');
      expect(plan.requests.original.instructions).not.toContain(
        'Return uncertain',
      );
      expect(plan.requests.original.instructions).toContain('every component');
      expect(plan.requests.original).not.toHaveProperty('tools');
      expect(plan.requests.original.instructions).not.toBe(
        plan.requests.repair.instructions,
      );
      expect(plan.requests.original.input).toBe(plan.requests.repair.input);
      expect(
        authoredBundle(
          spec,
          { candidateId: bundle.id, parentId: null, version: 1 },
          { payload: bundle.payload, claims: bundle.claims },
        ),
      ).toEqual(bundle);
    }
  });
  it('rejects source drift, discovery sources, private material, execution and rubric drift before handoff', () => {
    const bundle = questionBundle('synthetic-invalid');
    const spec = authoringSpec(bundle);
    const bad = structuredClone(spec);
    bad.evidence[0].text += 'drift';
    expect(() => compileAuthoring(bad)).toThrow('AUTHORING_INPUT_INVALID');
    bad.evidence = spec.evidence;
    bad.sources[0].role = 'discovery_context';
    expect(() => compileAuthoring(bad)).toThrow('AUTHORING_INPUT_INVALID');
    expect(() =>
      compileAuthoring({ ...spec, coverage: 'password=private' }),
    ).toThrow('AUTHORING_INPUT_INVALID');
    expect(() =>
      compileAuthoring({
        ...spec,
        authorization: { ...spec.authorization, codeDigest: '0'.repeat(64) },
      }),
    ).toThrow('CODE_MISMATCH');
    for (const payload of [
      { ...bundle.payload, rubric: { ...bundle.payload.rubric, passScore: 3 } },
      {
        ...bundle.payload,
        rubric: {
          ...bundle.payload.rubric,
          referenceAnswer: 'No excellence criterion.',
        },
      },
      {
        ...bundle.payload,
        blocks: [{ type: 'code', language: 'python', code: 'print(1)' }],
      },
    ])
      expect(() =>
        authoredBundle(
          spec,
          { candidateId: bundle.id, parentId: null, version: 1 },
          { payload, claims: bundle.claims },
        ),
      ).toThrow();
  });
  it('stops disabled authoring before database access or SDK dispatch', async () => {
    vi.stubEnv('AUTHORING_ENABLED', 'false');
    vi.stubEnv('PGSERVICE', '');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      authorOnce('00000000-0000-4000-8000-000000000001'),
    ).rejects.toThrow('AUTHORING_DISABLED');
    expect(fetch).not.toHaveBeenCalled();
  });
});
