import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  compileEvaluation,
  loadPrivatePackage,
  offlineEvaluation,
  persistPrivateReport,
  validateEvaluationPlan,
} from '@/lib/content/evaluation-contract';
import { evaluateOnce } from '@/lib/content/model-evaluation';
import { gradingTask } from '@/lib/contracts/grading';
import { structuredRequest } from '@/lib/content/provider';
import {
  evaluationConfig,
  rehash,
  syntheticPackage,
} from '@/tests/fixtures/evaluation';

afterEach(() => vi.unstubAllEnvs());
describe('independent release evaluation contracts', () => {
  it('performs deterministic-only dry runs with no database or transport and immutable reproducible reports', () => {
    vi.stubEnv('PGSERVICE', '');
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('NO_NETWORK'));
    const input = syntheticPackage();
    const config = evaluationConfig({
      dailyCap: 0,
      monthlyCap: 0,
      batchCap: 0,
      providerPolicyDigest: null,
      privacyApprovalDigest: null,
      deploymentApprovalDigest: null,
      runAuthorizationDigest: null,
    });
    const first = offlineEvaluation(input, config);
    expect(offlineEvaluation(input, config)).toEqual(first);
    expect(first).toMatchObject({
      status: 'not_evaluated',
      approvalAuthority: 'none',
      requestsUsed: 0,
      reservedCents: 0,
    });
    expect(first.cases.find((c) => c.id === 'policy-rights')).toMatchObject({
      expectationMatched: true,
      reasons: ['REUSE_RIGHTS_REQUIRED'],
    });
    expect(
      first.cases.filter((c) => c.status === 'not_evaluated'),
    ).toHaveLength(11);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
    const dir = mkdtempSync(join(tmpdir(), 'evaluation-report-'));
    const { digest } = persistPrivateReport(dir, first);
    expect(persistPrivateReport(dir, first).digest).toBe(digest);
    writeFileSync(join(dir, `${digest}.json`), 'altered');
    expect(() => persistPrivateReport(dir, first)).toThrow('REPORT_CONFLICT');
  });
  it('exercises the exact learner request, preserves repair identity and rejects rewritten frozen requests', () => {
    const plan = compileEvaluation(syntheticPackage(), evaluationConfig());
    for (const entry of plan.cases)
      for (const request of Object.values(entry.requests ?? {})) {
        expect(request.service_tier).toBe('default');
        expect(request.reasoning).toEqual({ effort: 'low' });
      }
    const entry = plan.cases.find((c) => c.id === 'grade-strong')!;
    const candidate = entry.candidate as ReturnType<
      typeof syntheticPackage
    >['dataset']['cases'][number]['candidate'] & {
      payload: {
        blocks: unknown;
        assumptions: string;
        rubric: {
          version: string;
          passScore: number;
          requiredClaims: string[];
          referenceAnswer: string;
        };
      };
    };
    const data = {
      question: candidate.payload.blocks,
      assumptions: candidate.payload.assumptions,
      rubric: {
        version: candidate.payload.rubric.version,
        pass_score: candidate.payload.rubric.passScore,
        required_claims: candidate.payload.rubric.requiredClaims,
        reference_answer: candidate.payload.rubric.referenceAnswer,
      },
      learnerAnswer: entry.answer!,
    };
    for (const repair of [false, true])
      expect(entry.requests![repair ? 'repair' : 'original']).toEqual(
        structuredRequest(
          gradingTask(data, repair),
          plan.configuration.modelVersion,
          'technical_grade',
        ),
      );
    expect(validateEvaluationPlan(plan)).toBe(plan);
    entry.requests!.original.instructions = 'A different easier prompt.';
    expect(() => validateEvaluationPlan(plan)).toThrow('REQUEST_MISMATCH');
  });
  it('fails closed on package/code/evidence/independence/coverage drift and invalid ambiguous bounds', () => {
    const input = syntheticPackage();
    const config = evaluationConfig();
    expect(() =>
      compileEvaluation({ ...input, digest: '0'.repeat(64) }, config),
    ).toThrow('PACKAGE_DIGEST_MISMATCH');
    expect(() =>
      compileEvaluation(input, { ...config, codeDigest: '0'.repeat(64) }),
    ).toThrow('CODE_MISMATCH');
    const badEvidence = structuredClone(input);
    badEvidence.dataset.cases[0].evidence[0].text += 'changed';
    expect(() => compileEvaluation(rehash(badEvidence), config)).toThrow(
      'CASE_EVIDENCE_INVALID',
    );
    const ambiguous = structuredClone(input);
    ambiguous.dataset.cases.find(
      (c) => c.id === 'grade-uncertain-context',
    )!.expected.grade!.minScore = 0;
    expect(() => compileEvaluation(rehash(ambiguous), config)).toThrow(
      'CASE_EXPECTATION_INVALID',
    );
    const missing = structuredClone(input);
    missing.dataset.cases = missing.dataset.cases.filter(
      (c) => c.id !== 'critic-spoiler',
    );
    expect(() => compileEvaluation(rehash(missing), config)).toThrow(
      'COVERAGE_INCOMPLETE',
    );
    const collision = structuredClone(input);
    collision.dataset.cases[0].candidate = structuredClone(
      collision.dataset.cases[0].candidate,
    );
    const staged = (collision.manifest as { bundles: { id: string }[] })
      .bundles[0];
    Object.assign(collision.dataset.cases[0].candidate as object, {
      id: staged.id,
    });
    collision.dataset.cases[0].candidate = rehash(
      collision.dataset.cases[0].candidate as { digest: string },
    );
    expect(() => compileEvaluation(rehash(collision), config)).toThrow(
      'HOLDOUT_IDENTITY_INVALID',
    );
  });
  it('requires explicit complete facets rather than deriving a negative from its ID or overall acceptance', () => {
    const config = evaluationConfig();
    for (const change of [
      (
        entry: ReturnType<typeof syntheticPackage>['dataset']['cases'][number],
      ) => {
        entry.expected.facets = null;
      },
      (
        entry: ReturnType<typeof syntheticPackage>['dataset']['cases'][number],
      ) => {
        entry.expected.facets!.claims[0].verdict = 'supported';
      },
      (
        entry: ReturnType<typeof syntheticPackage>['dataset']['cases'][number],
      ) => {
        entry.expected.facets!.claims.push(entry.expected.facets!.claims[0]);
      },
    ]) {
      const input = syntheticPackage();
      change(input.dataset.cases.find((c) => c.id === 'source-unsupported')!);
      expect(() => compileEvaluation(rehash(input), config)).toThrow(
        'CASE_FACETS_INVALID',
      );
    }
    const renamed = syntheticPackage();
    renamed.dataset.cases.find((c) => c.id === 'source-unsupported')!.id =
      'opaque-independent-case';
    expect(() => compileEvaluation(rehash(renamed), config)).not.toThrow();
    for (const legacy of [
      { protocolVersion: 'release-evaluation-v2' },
      { promptVersion: 'qualification-prompts-v2' },
      { reasoningEffort: 'none' },
    ])
      expect(() =>
        compileEvaluation(rehash(renamed), { ...config, ...legacy }),
      ).toThrow();
  });
  it('verifies retained attachment bytes and refuses traversal, escapes and missing notices without printing input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evaluation-package-'));
    writeFileSync(join(dir, 'license.txt'), 'Synthetic license.\n');
    writeFileSync(join(dir, 'notice.txt'), 'Synthetic notice.\n');
    writeFileSync(join(dir, 'reference.txt'), 'Synthetic fixture claim.');
    const input = syntheticPackage();
    const path = join(dir, 'package.json');
    writeFileSync(path, JSON.stringify(input));
    expect(loadPrivatePackage(path).digest).toBe(input.digest);
    writeFileSync(join(dir, 'notice.txt'), 'modified');
    expect(() => loadPrivatePackage(path)).toThrow('ATTACHMENT_INVALID');
    const outside = mkdtempSync(join(tmpdir(), 'evaluation-outside-'));
    writeFileSync(join(outside, 'notice.txt'), 'Synthetic notice.\n');
    symlinkSync(join(outside, 'notice.txt'), join(dir, 'escape.txt'));
    input.attachments[2].path = 'escape.txt';
    writeFileSync(path, JSON.stringify(rehash(input)));
    expect(() => loadPrivatePackage(path)).toThrow('ATTACHMENT_INVALID');
    input.attachments[2].path = '../notice.txt';
    writeFileSync(path, JSON.stringify(rehash(input)));
    expect(() => loadPrivatePackage(path)).toThrow('ATTACHMENT_INVALID');
    const missingNotice = syntheticPackage();
    missingNotice.attachments = missingNotice.attachments.filter(
      (a) => a.kind !== 'notice',
    );
    writeFileSync(path, JSON.stringify(rehash(missingNotice)));
    expect(() => loadPrivatePackage(path)).toThrow('RIGHTS_RECORD_REQUIRED');
  });
  it('refuses dispatch before any database/provider operation when independent authorization is absent', async () => {
    vi.stubEnv('MODEL_EVALUATION_ENABLED', 'false');
    vi.stubEnv('PGSERVICE', '');
    await expect(
      evaluateOnce('00000000-0000-4000-8000-000000000001'),
    ).rejects.toThrow('EVALUATION_DISABLED');
  });
});
