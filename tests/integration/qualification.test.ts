import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentDigest, type ContentBundle } from '@/lib/content/manifest';
import { qualificationSql, qualifyOnce } from '@/lib/content/qualification';
import { gradingInstructions } from '@/lib/contracts/grading';
import { questionBundle, termBundle } from '@/tests/fixtures/content';
import {
  importBundles,
  literal,
  publish,
  release,
  sql,
  testUser,
} from './helpers';

const kinds = ['wrong', 'partial', 'borderline_pass', 'strong', 'ambiguous'];
const configuration = (overrides: Record<string, unknown> = {}) => ({
  policyVersion: 'content-policy-v1',
  modelVersion: 'gpt-5.4-mini-2026-03-17',
  promptVersion: 'qualification-prompts-v1',
  schemaVersion: 'qualification-schema-v1',
  fixtureVersion: 'machine-fixtures-v1',
  graderVersion: 'grader-v1',
  gradingPromptVersion: 'grade-prompt-v1',
  gradingSchemaVersion: 'grade-schema-v1',
  toolchainVersion: 'nonexecutable-tests-v1',
  modelEvaluationDigest: '1'.repeat(64),
  privacyApprovalDigest: '2'.repeat(64),
  deploymentApprovalDigest: '3'.repeat(64),
  providerConfigurationDigest: '4'.repeat(64),
  enabled: true,
  publicationEnabled: false,
  requestCents: 10,
  dailyCap: 100,
  monthlyCap: 2000,
  batchCap: 2000,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  ...overrides,
});
type Configuration = ReturnType<typeof configuration>;
const admin = (statement: string) => sql(`set role postgres; ${statement}`);
function rehash<T extends ContentBundle>(bundle: T): T {
  const body = Object.fromEntries(
    Object.entries(bundle).filter(([key]) => key !== 'digest'),
  );
  return { ...bundle, digest: contentDigest(body) };
}
function candidate(kind: 'question' | 'term' = 'question') {
  const id = randomUUID();
  const words = Array.from(
    { length: 100 },
    (_, index) => `unique${id.replaceAll('-', '')}${index}`,
  ).join(' ');
  if (kind === 'question')
    return questionBundle(`worker-${id}`, {
      blocks: [{ type: 'text', text: words }],
    });
  const term = termBundle(`worker-${id}`);
  term.payload.example = words;
  return rehash(term);
}
function snapshots(bundle: ContentBundle) {
  return bundle.sources
    .filter((s) => s.role === 'correctness_evidence')
    .map((s) => {
      const text = bundle.claims.map((c) => c.claim).join('\n');
      return {
        sourceId: s.id,
        url: s.url,
        edition: s.edition,
        locator: s.locator,
        authority: 'standard',
        permissionBasis: 'Synthetic source authored for isolated tests.',
        provenance:
          'Isolated test supplies the entire synthetic source; not external evidence.',
        text,
        digest: createHash('sha256').update(text).digest('hex'),
      };
    });
}
function enable(config: Configuration) {
  for (const [key, value] of Object.entries({
    QUALIFICATION_ENABLED: 'true',
    QUALIFICATION_MODEL_EVAL_APPROVED: 'true',
    QUALIFICATION_PRIVACY_APPROVED: 'true',
    QUALIFICATION_DEPLOYMENT_APPROVED: 'true',
    QUALIFICATION_CONFIGURATION_DIGEST: contentDigest(config),
    QUALIFICATION_MODEL_EVALUATION_DIGEST: config.modelEvaluationDigest,
    QUALIFICATION_PRIVACY_APPROVAL_DIGEST: config.privacyApprovalDigest,
    QUALIFICATION_DEPLOYMENT_APPROVAL_DIGEST: config.deploymentApprovalDigest,
    QUALIFICATION_PROVIDER_CONFIGURATION_DIGEST:
      config.providerConfigurationDigest,
    OPENAI_API_KEY: 'synthetic-test-key-not-a-credential',
  }))
    vi.stubEnv(key, String(value));
}
function enqueue(
  bundle: ContentBundle,
  config = configuration(),
  evidence: unknown = snapshots(bundle),
) {
  importBundles([bundle]);
  const batch = admin(
    `set role qualification_operator; select private.qualification_open_batch(${literal(config)})`,
  );
  const job = admin(
    `set role qualification_operator; select private.qualification_enqueue('${bundle.id}','${batch}',${literal(evidence)})`,
  );
  enable(config);
  return { job, batch, config };
}
function outputs(bundle: ContentBundle) {
  const basis = bundle.claims.map((c) => ({
    claim: c.claim,
    sourceId: c.sourceIds[0],
    quote: c.claim,
  }));
  return {
    source: {
      independentAnswer: 'Independent synthetic solution.',
      privacy: 'public',
      originality: 'original',
      issues: [],
      claims: basis.map((b) => ({
        ...b,
        verdict: 'supported',
        reason: 'The exact synthetic source states this claim.',
      })),
      executionRequired: false,
      executionPlan: [],
    },
    fixtures: {
      cases: kinds.map((kind, index) => ({
        kind,
        answer: `Synthetic answer ${kind}`,
        expected: kind === 'ambiguous' ? 'uncertain' : 'scored',
        minScore:
          kind === 'ambiguous'
            ? null
            : index === 0
              ? 0
              : index === 1
                ? 1
                : index === 2
                  ? 3
                  : 4,
        maxScore:
          kind === 'ambiguous'
            ? null
            : index === 0
              ? 0
              : index === 1
                ? 2
                : index === 2
                  ? 3
                  : 5,
        expectedPass: kind === 'ambiguous' ? null : index >= 2,
        reason:
          'The synthetic source and critical claim distinguish this answer.',
        basis,
      })),
    },
    critic: {
      independentAnswer: 'Blind independent synthetic solution.',
      privacy: 'public',
      originality: 'original',
      objections: [],
      proofLimits: [
        'Does not prove universal correctness, undefined-behavior absence, all schedules or portability.',
      ],
      fixtures:
        bundle.kind === 'term'
          ? []
          : kinds.map((kind) => ({
              kind,
              verdict: 'supported',
              reason: 'Independent synthetic expectation check.',
            })),
      links:
        bundle.kind === 'term'
          ? []
          : bundle.payload.terms.map((l) => ({
              ...l,
              required: undefined,
              verdict:
                l.exposure === 'pre_attempt_safe' ? 'safe' : 'post_grade_only',
              reason: 'Synthetic contextual link check.',
            })),
    },
  };
}
function response(output: unknown, knownUsage = true) {
  return Response.json({
    object: 'response',
    id: 'synthetic-response',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify(output),
            annotations: [],
          },
        ],
      },
    ],
    ...(knownUsage ? { usage: { input_tokens: 100, output_tokens: 50 } } : {}),
  });
}
function provider(
  bundle: ContentBundle,
  transform?: (stage: string, value: unknown) => unknown,
  knownUsage = true,
) {
  const values = outputs(bundle);
  const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body));
    expect(sent.model).toBe('gpt-5.4-mini-2026-03-17');
    expect(sent.store).toBe(false);
    expect(sent.tools).toBeUndefined();
    expect(sent.max_output_tokens).toBe(3000);
    expect(sent.text.format.strict).toBe(true);
    expect(JSON.stringify(sent.text.format.schema)).not.toContain('"oneOf"');
    const data = JSON.parse(sent.input);
    let stage = 'source';
    let value: unknown = values.source;
    if (sent.instructions.startsWith('Act as an independent fixture author')) {
      stage = 'fixtures';
      value = values.fixtures;
      expect(data).not.toHaveProperty('artifacts');
    } else if (
      sent.instructions.startsWith('Act as an independent adversarial critic')
    ) {
      stage = 'critic';
      value = values.critic;
      expect(data).not.toHaveProperty('source');
      expect(sent.input).not.toContain('Independent synthetic solution.');
    } else if (sent.instructions.startsWith('Grade only')) {
      expect(sent.instructions).toBe(gradingInstructions(false));
      stage = `evaluate_${data.learnerAnswer.split(' ').at(-1)}`;
      expect(Object.keys(data).sort()).toEqual([
        'assumptions',
        'learnerAnswer',
        'question',
        'rubric',
      ]);
      expect(Object.keys(data.rubric).sort()).toEqual([
        'pass_score',
        'reference_answer',
        'required_claims',
        'version',
      ]);
      const kind = stage.replace('evaluate_', '');
      value = {
        assessment:
          kind === 'ambiguous'
            ? {
                outcome: 'uncertain',
                reason: 'The synthetic answer is ambiguous.',
              }
            : {
                outcome: 'scored',
                score:
                  kind === 'wrong'
                    ? 0
                    : kind === 'partial'
                      ? 2
                      : kind === 'borderline_pass'
                        ? 3
                        : 5,
                criticalClaimsMet: !['wrong', 'partial'].includes(kind),
                correctClaims: ['Synthetic claim.'],
                missingClaims: [],
                incorrectClaims: [],
                idealAnswer: 'Synthetic ideal answer.',
                explanation: 'Synthetic grading consistency only.',
              },
      };
    }
    return response(
      transform ? transform(stage, structuredClone(value)) : value,
      knownUsage,
    );
  });
  vi.stubGlobal('fetch', transport);
  return transport;
}
const prompt = (config: Configuration) => ({
  input: 'Synthetic durable request.',
  instructions: 'Synthetic task.',
  schema: { type: 'object' },
  modelVersion: config.modelVersion,
  promptVersion: config.promptVersion,
  schemaVersion: config.schemaVersion,
});

beforeEach(() => {
  admin("update private.provider_requests set created_at='2020-01-01'");
  const dir = mkdtempSync(join(tmpdir(), 'qualification-test-'));
  const path = join(dir, 'pg_service.conf');
  writeFileSync(
    path,
    '[qualification-test]\nhost=127.0.0.1\nport=54322\ndbname=postgres\nuser=postgres\n',
    { mode: 0o600 },
  );
  vi.stubEnv('PGSERVICE', 'qualification-test');
  vi.stubEnv('PGSERVICEFILE', path);
  vi.stubEnv('PGOPTIONS', '-c role=qualification_worker');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('trusted imported-candidate qualification', () => {
  it('runs independent SDK stages, derives a publishable receipt, and never publishes itself', async () => {
    const bundle = candidate();
    const { job } = enqueue(bundle);
    const transport = provider(bundle);
    expect(await qualifyOnce(job)).toMatchObject({
      state: 'qualified',
      requestsUsed: 8,
    });
    expect(transport).toHaveBeenCalledTimes(8);
    const receipt = JSON.parse(
      admin(
        `select evidence from private.qualification_runs where candidate_id='${bundle.id}'`,
      ),
    );
    expect(receipt.authorTask).not.toBe(receipt.criticTask);
    expect(receipt.fixtureAuthorTask).not.toBe(receipt.authorTask);
    expect(receipt.requestsUsed).toBe(8);
    expect(
      admin(
        `select count(*) from public.question_versions where id='${bundle.id}'`,
      ),
    ).toBe('0');
    expect(
      admin(`select count(*) from private.provider_requests r join private.qualification_artifacts a on a.request_id=r.id
      where r.qualification_job='${job}' and a.input_digest=private.content_digest(r.qualification_prompt)`),
    ).toBe('8');
    const qualificationId = admin(
      `select id from private.qualification_runs where candidate_id='${bundle.id}'`,
    );
    expect(
      admin(
        `select private.passing_qualification('${bundle.id}','${qualificationId}')`,
      ),
    ).toBe('t');
    expect(publish([release(bundle, qualificationId)])).toBeTruthy();
    const lease = admin(
      `select lease from private.qualification_jobs where id='${job}'`,
    );
    expect(qualificationSql('finish', [job, lease])).toMatchObject({
      state: 'qualified',
    });
    expect(
      admin(
        `select count(*) from private.qualification_runs where candidate_id='${bundle.id}'`,
      ),
    ).toBe('1');
    expect(() =>
      admin(
        `update private.qualification_artifacts set output='{}' where job_id='${job}'`,
      ),
    ).toThrow(/IMMUTABLE_HISTORY/);
    expect(await qualifyOnce(job)).toBeNull();
    expect(transport).toHaveBeenCalledTimes(8);
  });
  it('marks term-only fixture and execution applicability without grading learner attempts', async () => {
    const bundle = candidate('term');
    const { job } = enqueue(bundle);
    provider(bundle);
    expect(await qualifyOnce(job)).toMatchObject({
      state: 'qualified',
      requestsUsed: 2,
    });
    const receipt = JSON.parse(
      admin(
        `select evidence from private.qualification_runs where candidate_id='${bundle.id}'`,
      ),
    );
    expect(receipt.fixtureKinds).toEqual([]);
    expect(receipt.applicability).toContain('not applicable');
    expect(receipt.execution.status).toBe('not_applicable');
  });
  it('denies untrusted roles and keeps worker/operator capabilities disjoint', () => {
    for (const role of [
      'anon',
      'authenticated',
      'service_role',
      'content_importer',
      'content_publisher',
      'qualification_worker',
      'qualification_operator',
    ]) {
      for (const table of [
        'qualification_batches',
        'qualification_inputs',
        'qualification_jobs',
        'qualification_artifacts',
        'qualification_runs',
        'provider_requests',
      ])
        expect(() =>
          admin(`set role ${role}; select * from private.${table}`),
        ).toThrow();
      expect(() =>
        admin(
          `set role ${role}; insert into private.qualification_runs(id) values(gen_random_uuid())`,
        ),
      ).toThrow();
      if (role !== 'qualification_worker')
        expect(() =>
          admin(`set role ${role}; select private.qualification_claim(null)`),
        ).toThrow();
      if (role !== 'qualification_operator')
        expect(() =>
          admin(
            `set role ${role}; select private.qualification_open_batch(${literal(configuration())})`,
          ),
        ).toThrow();
      if (role.startsWith('qualification_')) {
        expect(() =>
          admin(`set role ${role}; select private.publish_content_batch('[]')`),
        ).toThrow();
        expect(() =>
          admin(`set role ${role}; select answer_text from public.attempts`),
        ).toThrow();
        expect(() =>
          admin(`set role ${role}; select details from public.attempt_grades`),
        ).toThrow();
      }
    }
    expect(
      admin(
        "select count(*) from pg_roles where rolname like 'qualification_%' and (rolsuper or rolbypassrls or rolcanlogin or rolcreaterole)",
      ),
    ).toBe('0');
  });
  it('fails closed before dispatch on missing evidence, changed locators, rights, digests, privacy and duplicates', async () => {
    const transport = vi.fn();
    vi.stubGlobal('fetch', transport);
    const original = candidate();
    enqueue(original);
    const duplicate = rehash({
      ...original,
      id: randomUUID(),
      stableId: `worker-${randomUUID()}`,
    });
    const cases: [ContentBundle, unknown, string][] = [
      [candidate(), [], 'EVIDENCE_MISSING'],
      [duplicate, snapshots(duplicate), 'DUPLICATE_CONTENT'],
    ];
    for (const [field, value] of [
      ['locator', 'missing section'],
      ['digest', '0'.repeat(64)],
      ['authority', 'interview_bank'],
      ['permissionBasis', ''],
    ] as const) {
      const bundle = candidate();
      const evidence = snapshots(bundle);
      Object.assign(evidence[0], { [field]: value });
      cases.push([bundle, evidence, 'EVIDENCE_UNVERIFIED']);
    }
    const reused = candidate();
    reused.sources[0] = {
      ...reused.sources[0],
      useMode: 'permitted_reuse',
      rightsBasis: 'Synthetic permission',
      attribution: 'Synthetic author',
      payloadDigest: 'a'.repeat(64),
    };
    cases.push([rehash(reused), snapshots(reused), 'REUSE_RIGHTS_REQUIRED']);
    const confidential = candidate();
    if (confidential.kind === 'question')
      confidential.payload.blocks.push({
        type: 'text',
        text: 'password=synthetic-secret-marker',
      });
    cases.push([
      rehash(confidential),
      snapshots(confidential),
      'PRIVATE_MATERIAL',
    ]);
    for (const [bundle, evidence, reason] of cases) {
      const { job } = enqueue(bundle, configuration(), evidence);
      expect(await qualifyOnce(job)).toMatchObject({
        state: 'quarantined',
        reason,
        requestsUsed: 0,
      });
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it('rejects unsupported claims and independent critic objections before fixture grading', async () => {
    for (const failure of ['claim', 'critic', 'privacy', 'fixture']) {
      const bundle = candidate();
      const { job } = enqueue(bundle);
      const transport = provider(bundle, (stage, value) => {
        if (stage === 'source' && failure === 'claim')
          return {
            ...outputs(bundle).source,
            claims: [
              {
                ...outputs(bundle).source.claims[0],
                quote: 'Not in this source.',
              },
            ],
          };
        if (stage === 'critic' && failure === 'critic')
          return {
            ...outputs(bundle).critic,
            objections: ['Unresolved alternative answer.'],
          };
        if (stage === 'source' && failure === 'privacy')
          return { ...outputs(bundle).source, privacy: 'private_or_uncertain' };
        if (stage === 'fixtures' && failure === 'fixture')
          return {
            ...outputs(bundle).fixtures,
            cases: outputs(bundle).fixtures.cases.map((f) => ({
              ...f,
              basis: [{ ...f.basis[0], quote: 'Invented quotation.' }],
            })),
          };
        return value;
      });
      expect(await qualifyOnce(job)).toMatchObject({
        state: 'quarantined',
        reason: 'CHECK_FAILED',
      });
      expect(transport.mock.calls.length).toBeLessThanOrEqual(3);
      expect(
        admin(
          `select count(*) from private.qualification_runs where candidate_id='${bundle.id}'`,
        ),
      ).toBe('0');
    }
  });
  it('rejects grader reversals, out-of-range scores and scored ambiguity', async () => {
    for (const failure of ['reversal', 'range', 'ambiguous']) {
      const bundle = candidate();
      const { job } = enqueue(bundle);
      provider(bundle, (stage, value) => {
        if (stage === 'evaluate_wrong' && failure === 'reversal')
          return {
            assessment: {
              ...(value as { assessment: object }).assessment,
              score: 5,
              criticalClaimsMet: true,
            },
          };
        if (stage === 'evaluate_borderline_pass' && failure === 'range')
          return {
            assessment: {
              ...(value as { assessment: object }).assessment,
              score: 4,
            },
          };
        if (stage === 'evaluate_ambiguous' && failure === 'ambiguous')
          return {
            assessment: {
              outcome: 'scored',
              score: 3,
              criticalClaimsMet: true,
              correctClaims: [],
              missingClaims: [],
              incorrectClaims: [],
              idealAnswer: 'Synthetic.',
              explanation: 'Synthetic.',
            },
          };
        return value;
      });
      expect(await qualifyOnce(job)).toMatchObject({
        state: 'quarantined',
        reason: 'GRADER_MISMATCH',
      });
    }
  });
  it('checks the exact term-definition link for spoilers without exposing source-review verdicts', async () => {
    const term = candidate('term');
    const setup = enqueue(term);
    provider(term);
    await qualifyOnce(setup.job);
    let question = candidate();
    if (question.kind !== 'question') throw new Error('Question required');
    question.dependencies = [{ id: term.id, digest: term.digest }];
    question.payload.terms = [
      { termId: term.id, required: true, exposure: 'pre_attempt_safe' },
    ];
    question = rehash(question);
    const { job } = enqueue(question);
    const transport = provider(question, (stage, value) =>
      stage === 'critic'
        ? {
            ...outputs(question).critic,
            links: [
              {
                termId: term.id,
                exposure: 'pre_attempt_safe',
                verdict: 'spoiler_or_uncertain',
                reason: 'Definition reveals a required claim.',
              },
            ],
          }
        : value,
    );
    expect(await qualifyOnce(job)).toMatchObject({
      state: 'quarantined',
      reason: 'CHECK_FAILED',
    });
    expect(transport).toHaveBeenCalledTimes(3);
    const critic = transport.mock.calls
      .map(([, init]) => JSON.parse(String(init?.body)))
      .find((s) =>
        s.instructions.startsWith('Act as an independent adversarial'),
      );
    expect(JSON.parse(critic.input).dependencies[0].id).toBe(term.id);
  });
  it('blocks executable claims when verified isolation is absent instead of calling them not applicable', async () => {
    let bundle = candidate();
    if (bundle.kind !== 'question') throw new Error('Question required');
    bundle.payload.blocks = [
      { type: 'code', language: 'python', text: "print('synthetic')" },
    ];
    bundle = rehash(bundle);
    const { job } = enqueue(bundle);
    provider(bundle, (stage, value) =>
      stage === 'source'
        ? {
            ...outputs(bundle).source,
            executionRequired: true,
            executionPlan: [
              {
                blockIndex: 0,
                expectedStdout: 'synthetic\n',
                reason: 'Execute supplied code.',
              },
            ],
          }
        : value,
    );
    vi.stubEnv('QUALIFICATION_EXECUTOR', '');
    expect(await qualifyOnce(job)).toMatchObject({
      state: 'quarantined',
      reason: 'EXECUTOR_UNAVAILABLE',
      requestsUsed: 1,
    });
  });
  it('allows one repair, counts transport attempts, and retains unknown-cost reservations', async () => {
    const bundle = candidate('term');
    const { job } = enqueue(bundle);
    const transport = provider(bundle, () => ({ passed: true }), false);
    expect(await qualifyOnce(job)).toMatchObject({
      state: 'quarantined',
      reason: 'INVALID_OUTPUT',
      requestsUsed: 2,
    });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(
      admin(
        `select sum(coalesce(actual_cents,reserved_cents)) from private.provider_requests where qualification_job='${job}'`,
      ),
    ).toBe('20');
    expect(
      admin(
        `select count(*) from private.provider_requests where qualification_job='${job}' and repair`,
      ),
    ).toBe('1');
  });
  it('keeps crash/replay allowances, rejects stale completion, and accepts only one concurrent claim', async () => {
    const bundle = candidate();
    const { job, batch, config } = enqueue(bundle);
    expect(
      admin(
        `set role qualification_operator;select private.qualification_enqueue('${bundle.id}','${batch}',${literal(snapshots(bundle))})`,
      ),
    ).toBe(job);
    expect(() =>
      admin(
        `set role qualification_operator;select private.qualification_enqueue('${bundle.id}','${batch}','[]')`,
      ),
    ).toThrow(/IMMUTABLE_REVISION_REQUIRED/);
    const run = promisify(execFile);
    const claims = await Promise.all(
      [1, 2].map(() =>
        run('psql', [
          '-X',
          '-w',
          '-q',
          '-v',
          'ON_ERROR_STOP=1',
          '-Atc',
          `select private.qualification_claim('${job}')`,
        ]),
      ),
    );
    const claimed = claims.map((c) => c.stdout.trim()).filter(Boolean);
    expect(claimed).toHaveLength(1);
    const work = JSON.parse(claimed[0]);
    const request = qualificationSql('reserve_cost', [
      job,
      work.lease,
      'source',
      false,
      prompt(config),
    ]);
    admin(
      `update private.qualification_jobs set lease_until=now()-interval '1 second' where id='${job}'`,
    );
    const replacement = qualificationSql('claim', [job]) as {
      lease: string;
      requestsUsed: number;
    };
    expect(replacement.requestsUsed).toBe(1);
    expect(() =>
      qualificationSql('complete', [
        job,
        work.lease,
        'source',
        request,
        outputs(bundle).source,
        null,
        1,
        {},
      ]),
    ).toThrow('STALE_LEASE');
    expect(() =>
      qualificationSql('finish', [job, replacement.lease]),
    ).toThrow();
    const second = qualificationSql('reserve_cost', [
      job,
      replacement.lease,
      'source',
      false,
      prompt(config),
    ]);
    qualificationSql('complete', [
      job,
      replacement.lease,
      'source',
      second,
      null,
      'PROVIDER_TIMEOUT',
      null,
      null,
    ]);
    const third = qualificationSql('reserve_cost', [
      job,
      replacement.lease,
      'source',
      false,
      prompt(config),
    ]);
    qualificationSql('complete', [
      job,
      replacement.lease,
      'source',
      third,
      null,
      'PROVIDER_TIMEOUT',
      null,
      null,
    ]);
    expect(() =>
      qualificationSql('reserve_cost', [
        job,
        replacement.lease,
        'source',
        false,
        prompt(config),
      ]),
    ).toThrow('STALE_LEASE');
    expect(
      admin(
        `select count(*) from private.provider_requests where qualification_job='${job}'`,
      ),
    ).toBe('3');
  });
  it('requires an explicit immutable revision, shares lineage counts, and rejects a second failed run', async () => {
    const first = candidate('term');
    const initial = enqueue(first);
    provider(first, () => ({ passed: true }));
    await qualifyOnce(initial.job);
    const second = rehash({
      ...first,
      id: randomUUID(),
      version: 2,
      parentId: first.id,
    });
    importBundles([second]);
    expect(() =>
      admin(
        `set role qualification_operator;select private.qualification_enqueue('${second.id}','${initial.batch}',${literal(snapshots(second))})`,
      ),
    ).toThrow(/IMMUTABLE_REVISION_REQUIRED/);
    const revised = enqueue(second);
    provider(second, () => ({ passed: true }));
    expect(await qualifyOnce(revised.job)).toMatchObject({
      state: 'rejected',
      requestsUsed: 2,
    });
    const third = rehash({
      ...second,
      id: randomUUID(),
      version: 3,
      parentId: second.id,
    });
    expect(() => enqueue(third)).toThrow(/LINEAGE_EXHAUSTED/);
    expect(
      admin(
        `select count(*) from private.provider_requests r join private.qualification_inputs i on i.id=r.qualification_job where i.lineage='${first.id}'`,
      ),
    ).toBe('4');
  });
  it('enforces three transport requests per term run and six across the two-run lineage without SDK retries', async () => {
    const first = candidate('term');
    const initial = enqueue(first);
    const transport = vi.fn(async () =>
      Response.json(
        { error: { message: 'Synthetic unavailable provider.' } },
        { status: 500 },
      ),
    );
    vi.stubGlobal('fetch', transport);
    expect(await qualifyOnce(initial.job)).toMatchObject({
      state: 'quarantined',
      reason: 'PROVIDER_TIMEOUT',
      requestsUsed: 3,
    });
    const second = rehash({
      ...first,
      id: randomUUID(),
      version: 2,
      parentId: first.id,
    });
    const revised = enqueue(second);
    expect(await qualifyOnce(revised.job)).toMatchObject({
      state: 'rejected',
      reason: 'PROVIDER_TIMEOUT',
      requestsUsed: 3,
    });
    expect(transport).toHaveBeenCalledTimes(6);
    expect(
      admin(
        `select sum(coalesce(actual_cents,reserved_cents)) from private.provider_requests r join private.qualification_inputs i on i.id=r.qualification_job where i.lineage='${first.id}'`,
      ),
    ).toBe('60');
  });
  it('retains the question run allowance across recovered stages and bounds the revised lineage', () => {
    const first = candidate();
    const initial = enqueue(first);
    const claimed = qualificationSql('claim', [initial.job]) as {
      lease: string;
    };
    admin(`insert into private.provider_requests(qualification_job,worker_lease,task,ordinal,reserved_cents,qualification_prompt,created_at)
      select '${initial.job}','${claimed.lease}','synthetic_stage_'||n,1,10,${literal(prompt(initial.config))},'2020-01-01' from generate_series(1,12) n`);
    expect(() =>
      qualificationSql('reserve_cost', [
        initial.job,
        claimed.lease,
        'source',
        false,
        prompt(initial.config),
      ]),
    ).toThrow('REQUEST_LIMIT');
    qualificationSql('yield', [initial.job, claimed.lease, 'REQUEST_LIMIT']);
    const second = rehash({
      ...first,
      id: randomUUID(),
      version: 2,
      parentId: first.id,
    });
    const revised = enqueue(second);
    const recovered = qualificationSql('claim', [revised.job]) as {
      lease: string;
    };
    admin(`insert into private.provider_requests(qualification_job,worker_lease,task,ordinal,reserved_cents,qualification_prompt,created_at)
      select '${revised.job}','${recovered.lease}','synthetic_stage_'||n,1,10,${literal(prompt(revised.config))},'2020-01-01' from generate_series(1,12) n`);
    expect(() =>
      qualificationSql('reserve_cost', [
        revised.job,
        recovered.lease,
        'source',
        false,
        prompt(revised.config),
      ]),
    ).toThrow('REQUEST_LIMIT');
    expect(
      qualificationSql('yield', [
        revised.job,
        recovered.lease,
        'REQUEST_LIMIT',
      ]),
    ).toMatchObject({ state: 'rejected', requestsUsed: 12 });
    expect(
      admin(
        `select count(*) from private.provider_requests r join private.qualification_inputs i on i.id=r.qualification_job where i.lineage='${first.id}'`,
      ),
    ).toBe('24');
  });
  it('requires independent exact gates and performs no dispatch when disabled or evidence approvals change', async () => {
    const bundle = candidate();
    const { job, config } = enqueue(bundle);
    const transport = provider(bundle);
    for (const gate of [
      'QUALIFICATION_ENABLED',
      'QUALIFICATION_MODEL_EVAL_APPROVED',
      'QUALIFICATION_PRIVACY_APPROVED',
      'QUALIFICATION_DEPLOYMENT_APPROVED',
    ]) {
      vi.stubEnv(gate, 'false');
      await expect(qualifyOnce(job)).rejects.toThrow('QUALIFICATION_DISABLED');
      enable(config);
    }
    vi.stubEnv('QUALIFICATION_MODEL_EVALUATION_DIGEST', 'f'.repeat(64));
    expect(await qualifyOnce(job)).toMatchObject({
      state: 'queued',
      reason: 'QUALIFICATION_DISABLED',
    });
    expect(transport).not.toHaveBeenCalled();
    expect(
      admin(
        `select count(*) from private.provider_requests where qualification_job='${job}'`,
      ),
    ).toBe('0');
  });
  it('uses one atomic grading-plus-qualification budget and prevents learner settlement of its reservations', async () => {
    const bundle = candidate('term');
    const { job, config } = enqueue(bundle, configuration({ dailyCap: 10 }));
    const work = qualificationSql('claim', [job]) as { lease: string };
    const request = qualificationSql('reserve_cost', [
      job,
      work.lease,
      'source',
      false,
      prompt(config),
    ]);
    admin(
      `set role service_role; select public.settle_provider_request('${request}',0,'{}')`,
    );
    expect(
      admin(
        `select actual_cents is null from private.provider_requests where id='${request}'`,
      ),
    ).toBe('t');
    const other = candidate('term');
    const queued = enqueue(other, config);
    provider(other);
    expect(await qualifyOnce(queued.job)).toMatchObject({
      state: 'queued',
      reason: 'BUDGET_EXCEEDED',
    });
    expect(
      admin(
        `select count(*) from private.provider_requests where qualification_job='${queued.job}'`,
      ),
    ).toBe('0');
    vi.unstubAllGlobals();
    vi.stubEnv('PGOPTIONS', '');
    const user = await testUser();
    const publicQuestion = questionBundle(`shared-budget-${randomUUID()}`);
    importBundles([publicQuestion]);
    const { installEvidence } = await import('./helpers');
    publish([release(publicQuestion, installEvidence(publicQuestion))]);
    const item = await user.db.rpc('start_study', {
      p_question: publicQuestion.id,
      p_timezone: 'UTC',
    });
    const submitted = await user.db.rpc('submit_answer', {
      p_item: item.data!,
      p_version: 0,
      p_answer: 'Synthetic.',
      p_confidence: 'guess',
      p_assisted: false,
      p_device: randomUUID(),
      p_question: publicQuestion.id,
      p_key: randomUUID(),
    });
    expect(submitted.error).toBeNull();
    const attempt = submitted.data!;
    const lease = randomUUID();
    admin(
      `update public.grading_jobs set state='grading',lease_token='${lease}',lease_until=now()+interval '90 seconds' where attempt_id='${attempt}'`,
    );
    expect(() =>
      admin(
        `set role service_role;select public.reserve_provider_request('${attempt}',1,'${lease}',10,10,2000,false)`,
      ),
    ).toThrow(/BUDGET_EXCEEDED/);
    admin("update private.provider_requests set created_at='2020-01-01'");
    const rival = candidate('term');
    const race = enqueue(rival, config);
    vi.stubEnv('PGOPTIONS', '-c role=qualification_worker');
    const rivalWork = qualificationSql('claim', [race.job]) as {
      lease: string;
    };
    const run = promisify(execFile);
    const results = await Promise.allSettled(
      [
        `set role qualification_worker;select private.qualification_reserve_cost('${race.job}','${rivalWork.lease}','source',false,${literal(prompt(config))})`,
        `set role service_role;select public.reserve_provider_request('${attempt}',1,'${lease}',10,10,2000,false)`,
      ].map((statement) =>
        run('psql', [
          '-X',
          '-w',
          '-q',
          '-v',
          'ON_ERROR_STOP=1',
          '-Atc',
          statement,
        ]),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      admin(
        "select sum(coalesce(actual_cents,reserved_cents)) from private.provider_requests where created_at>=date_trunc('day',now())",
      ),
    ).toBe('10');
    admin(
      `update public.grading_jobs set state='failed' where attempt_id='${attempt}'`,
    );
  });
  it('runs the actual batch and evidence-intake CLI with only the operator capability', () => {
    const bundle = candidate('term');
    importBundles([bundle]);
    const dir = mkdtempSync(join(tmpdir(), 'qualification-cli-'));
    const config = configuration();
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const run = (mode: string, path: string) =>
      spawnSync(process.execPath, ['scripts/content-qualify.ts', mode, path], {
        env: { ...process.env, PGOPTIONS: '-c role=qualification_operator' },
        encoding: 'utf8',
      });
    const opened = run('batch', configPath);
    expect(opened.status).toBe(0);
    const { batchId } = JSON.parse(opened.stdout);
    const intakePath = join(dir, 'intake.json');
    writeFileSync(
      intakePath,
      JSON.stringify({
        candidateId: bundle.id,
        batchId,
        evidence: snapshots(bundle),
      }),
      { mode: 0o600 },
    );
    const intake = run('enqueue', intakePath);
    expect(intake.status).toBe(0);
    expect(JSON.parse(run('enqueue', intakePath).stdout)).toEqual(
      JSON.parse(intake.stdout),
    );
    expect(
      admin(
        `select count(*) from private.qualification_runs where candidate_id='${bundle.id}'`,
      ),
    ).toBe('0');
  });
  it('runs the disabled real CLI without loading a provider or exposing configuration data', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/content-qualify.ts', 'once'],
      {
        env: { ...process.env, QUALIFICATION_ENABLED: 'false' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toContain('QUALIFICATION_DISABLED');
  });
});
