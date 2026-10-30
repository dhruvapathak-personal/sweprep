import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compileEvaluation,
  type EvaluationPlan,
} from '@/lib/content/evaluation-contract';
import { contentDigest, type ContentBundle } from '@/lib/content/manifest';
import { evaluateOnce, evaluationSql } from '@/lib/content/model-evaluation';
import {
  evaluationConfig,
  modelOutput,
  rehash,
  syntheticPackage,
} from '@/tests/fixtures/evaluation';
import { questionBundle, termBundle } from '@/tests/fixtures/content';
import {
  client,
  importBundles,
  installEvidence,
  literal,
  publish,
  release,
  sql,
  testUser,
} from './helpers';

const admin = (statement: string) => sql(`set role postgres; ${statement}`);
function enable(plan: EvaluationPlan) {
  const c = plan.configuration;
  for (const [key, value] of Object.entries({
    MODEL_EVALUATION_ENABLED: 'true',
    MODEL_EVALUATION_PROVIDER_POLICY_APPROVED: 'true',
    MODEL_EVALUATION_PRIVACY_APPROVED: 'true',
    MODEL_EVALUATION_DEPLOYMENT_APPROVED: 'true',
    MODEL_EVALUATION_RUN_AUTHORIZED: 'true',
    MODEL_EVALUATION_CONFIGURATION_DIGEST: plan.configurationDigest,
    MODEL_EVALUATION_PACKAGE_DIGEST: plan.packageDigest,
    MODEL_EVALUATION_PROVIDER_POLICY_DIGEST: c.providerPolicyDigest,
    MODEL_EVALUATION_PRIVACY_APPROVAL_DIGEST: c.privacyApprovalDigest,
    MODEL_EVALUATION_DEPLOYMENT_APPROVAL_DIGEST: c.deploymentApprovalDigest,
    MODEL_EVALUATION_RUN_AUTHORIZATION_DIGEST: c.runAuthorizationDigest,
    OPENAI_API_KEY: 'synthetic-test-key-not-a-credential',
    QUALIFICATION_MODEL_EVAL_APPROVED: 'false',
  }))
    vi.stubEnv(key, String(value));
}
function enroll(overrides: Parameters<typeof evaluationConfig>[0] = {}) {
  const plan = compileEvaluation(
    syntheticPackage(),
    evaluationConfig(overrides),
  );
  const run = admin(
    `set role evaluation_operator; select private.evaluation_open(${literal(plan)})`,
  );
  enable(plan);
  return { plan, run };
}
function response(output: unknown, known = true) {
  return Response.json({
    object: 'response',
    id: `synthetic-${randomUUID()}`,
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
    ...(known
      ? { usage: { input_tokens: 100, output_tokens: 100, total_tokens: 200 } }
      : {}),
  });
}
function provider(
  plan: EvaluationPlan,
  transform?: (id: string, value: unknown) => unknown,
  known = true,
) {
  const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
    expect(String(_url)).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(String(init?.body));
    const entry = plan.cases.find(
      (c) =>
        c.requests &&
        Object.values(c.requests).some(
          (r) => contentDigest(r) === contentDigest(body),
        ),
    );
    expect(entry).toBeTruthy();
    expect(body.store).toBe(false);
    expect(body.service_tier).toBe('default');
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.tools).toBeUndefined();
    expect(body.max_output_tokens).toBe(3000);
    const reserved = JSON.parse(
      admin(
        `select qualification_prompt from private.provider_requests where evaluation_run='${currentRun}' order by created_at desc limit 1`,
      ),
    );
    expect(reserved).toEqual(body);
    const output = modelOutput(entry!);
    return response(transform ? transform(entry!.id, output) : output, known);
  });
  vi.stubGlobal('fetch', transport);
  return transport;
}
let currentRun: string;
const claim = (run: string) =>
  evaluationSql('claim', [run]) as {
    lease: string;
    requestsUsed: number;
    case: { id: string };
  };
const report = (run: string) =>
  JSON.parse(
    admin(
      `select report from private.evaluation_reports where run_id='${run}'`,
    ),
  );
beforeEach(() => {
  admin("update private.provider_requests set created_at='2020-01-01'");
  const dir = mkdtempSync(join(tmpdir(), 'evaluation-test-'));
  const path = join(dir, 'pg_service.conf');
  writeFileSync(
    path,
    '[evaluation-test]\nhost=127.0.0.1\nport=54322\ndbname=postgres\nuser=postgres\n',
    { mode: 0o600 },
  );
  vi.stubEnv('PGSERVICE', 'evaluation-test');
  vi.stubEnv('PGSERVICEFILE', path);
  vi.stubEnv('PGOPTIONS', '-c role=evaluation_worker');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('separately authorized release evaluation', () => {
  it('refuses missing, duplicate and ungrounded facet expectations before enrollment', () => {
    for (const variant of [
      'missing',
      'duplicate',
      'unknown-source',
      'masked-negative',
    ]) {
      const plan = compileEvaluation(syntheticPackage(), evaluationConfig());
      const entry = plan.package.dataset.cases.find(
        (c) => c.id === 'source-unsupported',
      )!;
      if (variant === 'missing') entry.expected.facets = null;
      if (variant === 'duplicate')
        entry.expected.facets!.claims.push(entry.expected.facets!.claims[0]);
      if (variant === 'unknown-source')
        entry.expected.facets!.claims[0].sourceId = 'unsupplied';
      if (variant === 'masked-negative')
        entry.expected.facets!.claims[0].verdict = 'supported';
      plan.cases.find((c) => c.id === entry.id)!.expected = entry.expected;
      plan.package = rehash(plan.package);
      plan.packageDigest = plan.package.digest;
      plan.datasetDigest = contentDigest(plan.package.dataset);
      expect(() =>
        admin(
          `set role evaluation_operator; select private.evaluation_open(${literal(plan)})`,
        ),
      ).toThrow(/EVALUATION_INPUT_INVALID/);
    }
  });
  it('rejects extra and duplicate critic links at the privileged acceptance boundary', () => {
    const input = syntheticPackage();
    const clear = input.dataset.cases.find((c) => c.id === 'critic-clear')!;
    const linked = input.dataset.cases.find((c) => c.id === 'critic-spoiler')!;
    const candidate = linked.candidate as ReturnType<typeof questionBundle>;
    const finding = {
      termId: candidate.payload.terms[0].termId,
      exposure: 'pre_attempt_safe',
      verdict: 'safe',
      reason: 'Synthetic contextual check.',
    };
    for (const entry of [clear, linked]) {
      const output = modelOutput(entry) as Record<string, unknown>;
      const valid = entry === clear ? [] : [finding];
      const accepts = (links: unknown[]) =>
        admin(
          `begin; grant evaluation_engine to postgres; set role evaluation_engine; select private.evaluation_acceptance(${literal(entry)},${literal({ ...output, links })}); rollback`,
        );
      expect(accepts(valid)).toBe('t');
      for (const links of [
        [...valid, { ...finding, termId: randomUUID() }],
        ...(entry === linked
          ? [
              [],
              [finding, finding],
              [{ ...finding, termId: randomUUID() }],
              [{ ...finding, exposure: 'post_grade_only' }],
              [{ ...finding, verdict: 'spoiler_or_uncertain' }],
            ]
          : []),
      ])
        expect(accepts(links)).toBe('f');
    }
  });
  it('compares target negative facets even when unrelated flags already reject the output', () => {
    const input = syntheticPackage();
    for (const [id, facet] of [
      ['source-unsupported', 'claims'],
      ['critic-spoiler', 'links'],
      ['critic-clear', 'fixtures'],
    ] as const) {
      const entry = input.dataset.cases.find((c) => c.id === id)!;
      const output = modelOutput(entry) as Record<string, unknown>;
      const expected = structuredClone(entry.expected);
      if (facet === 'fixtures') {
        expected.accepted = false;
        expected.facets!.fixtures[0].verdict = 'unsupported';
      }
      const wrong = {
        ...output,
        privacy: 'private_or_uncertain',
        [facet]: (output[facet] as Record<string, unknown>[]).map(
          (finding) => ({
            ...finding,
            verdict: facet === 'links' ? 'safe' : 'supported',
          }),
        ),
      };
      const mismatches = JSON.parse(
        admin(
          `begin; grant evaluation_engine to postgres; set role evaluation_engine; select private.evaluation_mismatches(${literal({ ...entry, expected })},${literal(wrong)},'CHECK_FAILED'); rollback`,
        ),
      );
      expect(mismatches).toContain(`FACET_${facet.toUpperCase()}_MISMATCH`);
      expect(mismatches).toContain('FACET_PRIVACY_MISMATCH');
      const corrected = {
        ...output,
        [facet]: (output[facet] as Record<string, unknown>[]).map(
          (finding, index) => ({
            ...finding,
            verdict: expected.facets![facet][index].verdict,
          }),
        ),
      };
      expect(
        JSON.parse(
          admin(
            `begin; grant evaluation_engine to postgres; set role evaluation_engine; select private.evaluation_mismatches(${literal({ ...entry, expected })},${literal(corrected)},'CHECK_FAILED'); rollback`,
          ),
        ),
      ).toEqual([]);
    }
  });
  it.each([1, 2])(
    'stops in-flight v%s evaluation work on upgrade without rewriting its frozen evidence',
    (version) => {
      const plan = compileEvaluation(syntheticPackage(), evaluationConfig());
      const legacy = {
        ...plan,
        configuration: Object.fromEntries(
          Object.entries(plan.configuration).map(([key, value]) => [
            key,
            typeof value === 'string'
              ? value
                  .replace(/-(prompts|schema)?v3$/, (suffix) =>
                    suffix.replace('3', String(version)),
                  )
                  .replace(/-v2$/, version === 1 ? '-v1' : '-v2')
              : value,
          ]),
        ),
      };
      legacy.configurationDigest = contentDigest(legacy.configuration);
      legacy.identity = contentDigest({
        packageDigest: legacy.packageDigest,
        datasetDigest: legacy.datasetDigest,
        codeDigest: legacy.code.digest,
        protocolVersion: legacy.configuration.protocolVersion,
        modelVersion: legacy.configuration.modelVersion,
      });
      const original = readFileSync(
        version === 1
          ? 'supabase/migrations/202610290007_model_evaluation.sql'
          : 'supabase/migrations/202610300008_calibration_v2.sql',
        'utf8',
      );
      const entryPoints = ['open', 'reserve']
        .map((name) =>
          original
            .match(
              new RegExp(
                `create (?:or replace )?function private\\.evaluation_${name}\\([\\s\\S]*?\\n\\$\\$;`,
              ),
            )![0]
            .replace('create function', 'create or replace function'),
        )
        .join('\n');
      const upgrade = readFileSync(
        'supabase/migrations/202610300010_evaluation_v3.sql',
        'utf8',
      ).replaceAll('create function', 'create or replace function');
      expect(
        admin(`
        begin;
        grant evaluation_engine to postgres;
        ${entryPoints}
        set role evaluation_operator;
        select private.evaluation_open(${literal(legacy)}) as run \\gset
        set role evaluation_worker;
        select private.evaluation_claim(:'run')->>'lease' as lease \\gset
        select private.evaluation_reserve(:'run',:'lease',false) as request \\gset
        set role postgres;
        select set_config('test.legacy_run',:'run',true),
          set_config('test.legacy_lease',:'lease',true),
          set_config('test.legacy_request',:'request',true);
        create temporary table legacy_evidence as
          select private.evaluation_export(:'run') as exported,
            (select jsonb_agg(to_jsonb(o)) from private.evaluation_observations o where run_id=:'run') as observations,
            (select jsonb_agg(to_jsonb(r)) from private.provider_requests r where evaluation_run=:'run') as requests;
        ${upgrade}
        set role evaluation_worker;
        do $test$
        declare run uuid:=current_setting('test.legacy_run')::uuid;
          lease uuid:=current_setting('test.legacy_lease')::uuid;
          request uuid:=current_setting('test.legacy_request')::uuid;
        begin
          begin
            perform private.evaluation_complete(run,lease,request,null,'PROVIDER_REJECTED',null,null);
            raise exception 'LATE_COMPLETION_ACCEPTED';
          exception when others then
            if sqlerrm not in ('EVALUATION_DISABLED','STALE_LEASE') then raise; end if;
          end;
          begin
            perform private.evaluation_reserve(run,lease,false);
            raise exception 'LATE_RESERVATION_ACCEPTED';
          exception when others then
            if sqlerrm not in ('EVALUATION_DISABLED','STALE_LEASE') then raise; end if;
          end;
          begin
            perform private.evaluation_finish(run,lease,null);
            raise exception 'LATE_FINALIZATION_ACCEPTED';
          exception when others then
            if sqlerrm not in ('EVALUATION_DISABLED','STALE_LEASE') then raise; end if;
          end;
          if private.evaluation_claim(run) is not null then raise exception 'LEGACY_WORK_RECLAIMED'; end if;
        end;
        $test$;
        set role evaluation_operator;
        select set_config('test.legacy_export',private.evaluation_export(current_setting('test.legacy_run')::uuid)::text,true);
        set role postgres;
        do $test$
        declare run uuid:=current_setting('test.legacy_run')::uuid;
        begin
          if exists(select 1 from legacy_evidence e where
            e.exported is distinct from current_setting('test.legacy_export')::jsonb
            or e.observations is distinct from (select jsonb_agg(to_jsonb(o)) from private.evaluation_observations o where run_id=run)
            or e.requests is distinct from (select jsonb_agg(to_jsonb(r)) from private.provider_requests r where evaluation_run=run))
            then raise exception 'LEGACY_EVIDENCE_CHANGED'; end if;
        end;
        $test$;
        rollback;
      `),
      ).not.toContain('ERROR');
    },
  );
  it('requires coherent frozen scored and uncertain expectations at the SQL boundary', () => {
    for (const change of [
      { minScore: null },
      { minScore: 3 },
      { minScore: 5, maxScore: 4 },
      { pass: false },
      { kind: 'uncertain_context', outcome: 'scored' },
    ]) {
      const plan = compileEvaluation(syntheticPackage(), evaluationConfig());
      const entry = plan.package.dataset.cases.find(
        (c) => c.id === 'grade-borderline_pass',
      )!;
      Object.assign(entry.expected.grade!, change);
      Object.assign(
        plan.cases.find((c) => c.id === entry.id)!.expected.grade!,
        change,
      );
      plan.package = rehash(plan.package);
      plan.packageDigest = plan.package.digest;
      plan.datasetDigest = contentDigest(plan.package.dataset);
      expect(() =>
        admin(
          `set role evaluation_operator;select private.evaluation_open(${literal(plan)})`,
        ),
      ).toThrow(/EVALUATION_INPUT_INVALID/);
    }
  });
  it.each([
    'source-unsupported',
    'critic-spoiler',
    'fixtures-independent',
    'grade-uncertain-context',
  ])(
    'rejects malformed nested observations for %s in database comparisons',
    async (id) => {
      const input = syntheticPackage();
      const entry = input.dataset.cases.find((c) => c.id === id)!;
      input.dataset.cases = [
        entry,
        ...input.dataset.cases.filter((c) => c !== entry),
      ];
      const plan = compileEvaluation(rehash(input), evaluationConfig());
      const run = admin(
        `set role evaluation_operator;select private.evaluation_open(${literal(plan)})`,
      );
      enable(plan);
      currentRun = run;
      const valid = modelOutput(entry) as Record<string, unknown>;
      const invalid =
        id === 'source-unsupported'
          ? { ...valid, executionPlan: [{}] }
          : id === 'critic-spoiler'
            ? { ...valid, objections: [{}] }
            : id === 'fixtures-independent'
              ? {
                  cases: (valid.cases as object[]).map((c) => ({
                    ...c,
                    basis: [{}],
                  })),
                }
              : { outcome: 'uncertain' };
      const work = claim(run);
      const request = evaluationSql('reserve', [run, work.lease, false]);
      evaluationSql('complete', [
        run,
        work.lease,
        request,
        invalid,
        'CHECK_FAILED',
        null,
        null,
      ]);
      admin(
        `update private.evaluation_jobs set lease_until=now()-interval '1 second' where id='${run}'`,
      );
      provider(plan);
      await evaluateOnce(run);
      expect(
        report(run).cases.find((c: { id: string }) => c.id === id).mismatches,
      ).toEqual(['INVALID_OUTPUT']);
    },
  );
  it('retains the batch reservation across budget yields and cannot dispatch again by resuming', async () => {
    const { plan, run } = enroll({ batchCap: 10 });
    currentRun = run;
    const transport = provider(plan, undefined, false);
    for (let n = 0; n < 2; n++)
      expect(await evaluateOnce(run)).toMatchObject({
        state: 'queued',
        reason: 'BUDGET_EXCEEDED',
        requestsUsed: 1,
        costCents: 10,
      });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('does not issue a reserved repair again after a crash', async () => {
    const { plan, run } = enroll();
    currentRun = run;
    const work = claim(run);
    const original = evaluationSql('reserve', [run, work.lease, false]);
    evaluationSql('complete', [
      run,
      work.lease,
      original,
      {},
      'INVALID_OUTPUT',
      null,
      null,
    ]);
    evaluationSql('reserve', [run, work.lease, true]);
    admin(
      `update private.evaluation_jobs set lease_until=now()-interval '1 second' where id='${run}'`,
    );
    const transport = provider(plan);
    expect(await evaluateOnce(run)).toMatchObject({
      state: 'completed',
      requestsUsed: 12,
    });
    expect(transport).toHaveBeenCalledTimes(10);
    expect(
      admin(
        `select count(*) from private.provider_requests where evaluation_run='${run}' and repair`,
      ),
    ).toBe('1');
    expect(
      report(run).cases.find((c: { id: string }) => c.id === 'source-supported')
        .mismatches,
    ).toEqual(['REQUEST_LIMIT']);
  });
  it.each([null, { claims: [] }])(
    'does not credit a schema-invalid observation labeled as a valid rejection by the worker (%j)',
    async (invalid) => {
      const { plan, run } = enroll();
      currentRun = run;
      const work = claim(run);
      const first = evaluationSql('reserve', [run, work.lease, false]);
      evaluationSql('complete', [
        run,
        work.lease,
        first,
        modelOutput(plan.package.dataset.cases[0]),
        null,
        1,
        {},
      ]);
      const second = evaluationSql('reserve', [run, work.lease, false]);
      evaluationSql('complete', [
        run,
        work.lease,
        second,
        invalid,
        'CHECK_FAILED',
        null,
        null,
      ]);
      admin(
        `update private.evaluation_jobs set lease_until=now()-interval '1 second' where id='${run}'`,
      );
      provider(plan);
      await evaluateOnce(run);
      expect(
        report(run).cases.find(
          (c: { id: string }) => c.id === 'source-unsupported',
        ).mismatches,
      ).toEqual(['INVALID_OUTPUT']);
    },
  );
  it('persists exact SDK requests and derived comparisons without qualification, publication or learner writes', async () => {
    const { plan, run } = enroll();
    currentRun = run;
    vi.stubEnv('OPENAI_BASE_URL', 'https://unapproved.example.test/v1');
    const transport = provider(plan);
    expect(await evaluateOnce(run)).toMatchObject({
      state: 'completed',
      requestsUsed: 11,
      costCents: 11,
    });
    expect(transport).toHaveBeenCalledTimes(11);
    const result = report(run);
    expect(result).toMatchObject({
      schemaVersion: 'evaluation-report-v3',
      identity: plan.identity,
      packageDigest: plan.packageDigest,
      datasetDigest: plan.datasetDigest,
      configurationDigest: plan.configurationDigest,
      status: 'not_evaluated',
      approvalAuthority: 'none',
    });
    expect(
      result.cases.every(
        (c: { mismatches: unknown[] }) => c.mismatches.length === 0,
      ),
    ).toBe(true);
    expect(
      result.cases.find((c: { id: string }) => c.id === 'critic-spoiler')
        .facetResults,
    ).toMatchObject({
      links: { matched: true },
      privacy: { expected: 'public', observed: 'public', matched: true },
      originality: {
        expected: 'original',
        observed: 'original',
        matched: true,
      },
    });
    expect(
      result.cases.find(
        (c: { id: string }) => c.id === 'grade-uncertain-context',
      ).output,
    ).toMatchObject({ outcome: 'uncertain' });
    expect(
      result.cases.find((c: { id: string }) => c.id === 'policy-rights'),
    ).toMatchObject({
      category: 'deterministic_policy',
      output: { policyIssues: ['REUSE_RIGHTS_REQUIRED'] },
    });
    expect(
      result.cases.find((c: { id: string }) => c.id === 'source-supported')
        .category,
    ).toBe('mock_transport');
    expect(
      admin(
        `set role evaluation_operator; select private.evaluation_open(${literal(plan)})`,
      ),
    ).toBe(run);
    expect(await evaluateOnce(run)).toBeNull();
    expect(transport).toHaveBeenCalledTimes(11);
    const ids = (plan.package.manifest as { bundles: ContentBundle[] }).bundles
      .map((b) => `'${b.id}'`)
      .join(',');
    expect(
      admin(
        `select count(*) from private.content_candidates where id in (${ids})`,
      ),
    ).toBe('0');
    for (const table of [
      'evaluation_inputs',
      'evaluation_observations',
      'evaluation_reports',
    ])
      expect(() =>
        admin(`update private.${table} set actor=session_user`),
      ).toThrow(/IMMUTABLE_HISTORY/);
    const lease = admin(
      `select lease from private.evaluation_jobs where id='${run}'`,
    );
    expect(evaluationSql('finish', [run, lease, null])).toMatchObject({
      state: 'completed',
    });
    expect(
      admin(
        `select count(*) from private.evaluation_reports where run_id='${run}'`,
      ),
    ).toBe('1');
    const changed = compileEvaluation(plan.package, {
      ...plan.configuration,
      batchCap: 100,
    });
    expect(changed.identity).toBe(plan.identity);
    expect(() =>
      admin(
        `set role evaluation_operator; select private.evaluation_open(${literal(changed)})`,
      ),
    ).toThrow(/EVALUATION_REVISION_REQUIRED/);
    const relabeled = rehash({ ...plan.package, id: 'renamed-package' });
    expect(() =>
      admin(
        `set role evaluation_operator; select private.evaluation_open(${literal(compileEvaluation(relabeled, plan.configuration))})`,
      ),
    ).toThrow(/EVALUATION_REVISION_REQUIRED/);
  });
  it('records false acceptance, critical-claim pass reversals, score-range violations and scored ambiguity separately from policy checks', async () => {
    const { plan, run } = enroll();
    currentRun = run;
    provider(plan, (id, value) => {
      const out = value as Record<string, unknown>;
      if (id === 'grade-partial') return { invalid: true };
      if (id === 'source-unsupported')
        return {
          ...out,
          claims: (out.claims as object[]).map((c) => ({
            ...c,
            verdict: 'supported',
          })),
        };
      if (id === 'critic-spoiler')
        return {
          ...out,
          links: (out.links as object[]).map((c) => ({
            ...c,
            verdict: 'safe',
          })),
        };
      if (id === 'grade-wrong' || id === 'grade-uncertain-context')
        return {
          assessment: {
            ...(
              modelOutput(
                plan.package.dataset.cases.find(
                  (c) => c.id === 'grade-strong',
                )!,
              ) as { assessment: object }
            ).assessment,
            score: 5,
          },
        };
      if (id === 'grade-borderline_pass')
        return {
          assessment: {
            ...(out.assessment as object),
            criticalClaimsMet: false,
          },
        };
      return value;
    });
    await evaluateOnce(run);
    const results = report(run).cases as { id: string; mismatches: string[] }[];
    const reasons = (id: string) =>
      results.find((c) => c.id === id)!.mismatches;
    expect(reasons('source-unsupported')).toEqual([
      'ACCEPTANCE_REVERSAL',
      'FACET_CLAIMS_MISMATCH',
    ]);
    expect(reasons('critic-spoiler')).toEqual([
      'ACCEPTANCE_REVERSAL',
      'FACET_LINKS_MISMATCH',
    ]);
    expect(reasons('grade-wrong')).toEqual([
      'SCORE_RANGE',
      'PASS_FAIL_REVERSAL',
    ]);
    expect(reasons('grade-borderline_pass')).toEqual(['INVALID_OUTPUT']);
    expect(reasons('grade-uncertain-context')).toEqual(['OUTCOME_REVERSAL']);
    expect(reasons('grade-partial')).toEqual(['INVALID_OUTPUT']);
    expect(
      report(run).cases.find((c: { id: string }) => c.id === 'grade-partial')
        .output,
    ).toEqual({ invalid: true });
  });
  it('allows one schema repair and never treats invalid output as a successful negative case', async () => {
    const { plan, run } = enroll({ maxRequests: 4 });
    currentRun = run;
    const transport = provider(plan, () => ({ invalid: true }), false);
    expect(await evaluateOnce(run)).toMatchObject({
      state: 'completed',
      requestsUsed: 4,
      costCents: 40,
      reason: 'REQUEST_LIMIT',
    });
    expect(transport).toHaveBeenCalledTimes(4);
    expect(
      admin(
        `select count(*) from private.provider_requests where evaluation_run='${run}' and repair`,
      ),
    ).toBe('2');
    expect(
      report(run).cases.find(
        (c: { id: string }) => c.id === 'source-unsupported',
      ).mismatches,
    ).toEqual(['INVALID_OUTPUT']);
    expect(await evaluateOnce(run)).toBeNull();
    expect(transport).toHaveBeenCalledTimes(4);
  });
  it('does not replenish an exhausted allowance when candidate and linked identities are relabeled', async () => {
    const { plan, run } = enroll({ maxRequests: 1 });
    currentRun = run;
    const transport = provider(plan);
    expect(await evaluateOnce(run)).toMatchObject({
      state: 'completed',
      requestsUsed: 1,
      reason: 'REQUEST_LIMIT',
    });
    const input = structuredClone(plan.package);
    input.id = `relabeled-${randomUUID()}`;
    input.dataset.id = `relabeled-${randomUUID()}`;
    const identities = new Map<string, string>();
    for (const entry of input.dataset.cases)
      for (const bundle of [
        entry.candidate as ContentBundle,
        ...entry.dependencies,
      ])
        identities.set(bundle.id, identities.get(bundle.id) ?? randomUUID());
    input.dataset.cases = JSON.parse(
      JSON.stringify(input.dataset.cases),
      (_key, value) =>
        typeof value === 'string' ? (identities.get(value) ?? value) : value,
    );
    const rehashCandidates = () => {
      for (const entry of input.dataset.cases) {
        entry.dependencies = entry.dependencies.map((b) => rehash(b));
        const candidate = entry.candidate as ContentBundle;
        candidate.dependencies = candidate.dependencies.map((d) => ({
          ...d,
          digest: entry.dependencies.find((b) => b.id === d.id)!.digest,
        }));
        entry.candidate = rehash(candidate);
      }
    };
    rehashCandidates();
    const relabeled = compileEvaluation(rehash(input), plan.configuration);
    expect(() =>
      admin(
        `set role evaluation_operator;select private.evaluation_open(${literal(relabeled)})`,
      ),
    ).toThrow(/EVALUATION_REVISION_REQUIRED/);
    identities.clear();
    for (const entry of input.dataset.cases) {
      identities.set(entry.id, `relabeled-${randomUUID()}`);
      for (const bundle of [
        entry.candidate as ContentBundle,
        ...entry.dependencies,
      ]) {
        identities.set(bundle.stableId, `relabeled-${randomUUID()}`);
        for (const source of bundle.sources)
          identities.set(source.id, `source-${randomUUID()}`);
        bundle.version = 2;
        bundle.parentId = randomUUID();
        for (const source of bundle.sources)
          source.accessedAt = '2026-10-29T00:00:00Z';
      }
    }
    input.dataset.cases = JSON.parse(
      JSON.stringify(input.dataset.cases),
      (_key, value) =>
        typeof value === 'string' ? (identities.get(value) ?? value) : value,
    ).reverse();
    rehashCandidates();
    expect(() =>
      admin(
        `set role evaluation_operator;select private.evaluation_open(${literal(compileEvaluation(rehash(input), plan.configuration))})`,
      ),
    ).toThrow(/EVALUATION_REVISION_REQUIRED/);
    expect(await evaluateOnce(run)).toBeNull();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(
      admin(
        `select count(*) from private.provider_requests where evaluation_run='${run}'`,
      ),
    ).toBe('1');
    const linked = input.dataset.cases.find((c) => c.dependencies.length)!;
    const term = linked.dependencies[0];
    if (term.kind !== 'term') throw new Error('TERM_REQUIRED');
    term.payload.definition += ' A different synthetic meaning.';
    input.dataset.version++;
    rehashCandidates();
    const changed = compileEvaluation(rehash(input), plan.configuration);
    const changedRun = admin(
      `set role evaluation_operator;select private.evaluation_open(${literal(changed)})`,
    );
    expect(changedRun).not.toBe(run);
    const work = claim(changedRun);
    expect(
      evaluationSql('reserve', [changedRun, work.lease, false]),
    ).toBeTruthy();
  });
  it('bounds crashes and stale leases without replacing the run or refunding unknown usage', async () => {
    const { plan, run } = enroll();
    currentRun = run;
    let staleLease: string = '';
    let staleRequest: unknown;
    for (let n = 0; n < 3; n++) {
      const work = claim(run);
      expect(work.requestsUsed).toBe(n);
      const request = evaluationSql('reserve', [run, work.lease, false]);
      if (!n) {
        staleLease = work.lease;
        staleRequest = request;
      }
      admin(
        `set role service_role; select public.settle_provider_request('${request}',0,'{}')`,
      );
      expect(
        admin(
          `select actual_cents is null from private.provider_requests where id='${request}'`,
        ),
      ).toBe('t');
      if (!n) {
        evaluationSql('complete', [
          run,
          work.lease,
          request,
          null,
          'PROVIDER_TIMEOUT',
          0,
          { inputTokens: 0, outputTokens: 0 },
        ]);
        expect(
          admin(
            `select actual_cents is null from private.provider_requests where id='${request}'`,
          ),
        ).toBe('t');
      }
      admin(
        `update private.evaluation_jobs set lease_until=now()-interval '1 second' where id='${run}'`,
      );
    }
    const transport = provider(plan);
    await evaluateOnce(run);
    expect(transport).toHaveBeenCalledTimes(10);
    expect(
      report(run).cases.find((c: { id: string }) => c.id === 'source-supported')
        .mismatches,
    ).toEqual(['REQUEST_LIMIT']);
    expect(
      admin(
        `select count(*) from private.provider_requests where evaluation_run='${run}' and actual_cents is null`,
      ),
    ).toBe('3');
    expect(() =>
      evaluationSql('complete', [
        run,
        staleLease,
        staleRequest,
        {},
        null,
        0,
        {},
      ]),
    ).toThrow('STALE_LEASE');
    expect(() => evaluationSql('reserve', [run, staleLease, false])).toThrow(
      'STALE_LEASE',
    );
    expect(
      admin(
        `set role evaluation_operator; select private.evaluation_open(${literal(plan)})`,
      ),
    ).toBe(run);
  });
  it('requires independent exact authorizations and denies zero-budget enrollment without dispatch', async () => {
    const { plan, run } = enroll();
    currentRun = run;
    const transport = provider(plan);
    for (const gate of [
      'MODEL_EVALUATION_ENABLED',
      'MODEL_EVALUATION_PROVIDER_POLICY_APPROVED',
      'MODEL_EVALUATION_PRIVACY_APPROVED',
      'MODEL_EVALUATION_DEPLOYMENT_APPROVED',
      'MODEL_EVALUATION_RUN_AUTHORIZED',
    ]) {
      vi.stubEnv(gate, 'false');
      await expect(evaluateOnce(run)).rejects.toThrow('EVALUATION_DISABLED');
      enable(plan);
    }
    vi.stubEnv('MODEL_EVALUATION_PACKAGE_DIGEST', 'f'.repeat(64));
    expect(await evaluateOnce(run)).toMatchObject({
      state: 'queued',
      reason: 'EVALUATION_DISABLED',
      requestsUsed: 0,
    });
    expect(transport).not.toHaveBeenCalled();
    for (const overrides of [{ dailyCap: 0 }, { providerPolicyDigest: null }]) {
      const invalid = compileEvaluation(
        syntheticPackage(),
        evaluationConfig(overrides),
      );
      expect(() =>
        admin(
          `set role evaluation_operator; select private.evaluation_open(${literal(invalid)})`,
        ),
      ).toThrow(/EVALUATION_DISABLED/);
    }
  });
  it('keeps operator/worker/engine capabilities isolated and private RPCs absent from HTTP', async () => {
    for (const role of [
      'anon',
      'authenticated',
      'service_role',
      'content_importer',
      'content_publisher',
      'qualification_operator',
      'qualification_worker',
      'evaluation_operator',
      'evaluation_worker',
    ]) {
      for (const table of [
        'evaluation_inputs',
        'evaluation_jobs',
        'evaluation_observations',
        'evaluation_reports',
        'qualification_runs',
        'content_candidates',
        'provider_requests',
        'rubrics',
      ])
        expect(() =>
          admin(`set role ${role}; select * from private.${table}`),
        ).toThrow();
      for (const statement of [
        'insert into private.qualification_runs(id) values(gen_random_uuid())',
        "select private.evaluation_mismatches('{}','{}',null)",
        'select private.evaluation_advance(gen_random_uuid())',
      ])
        expect(() => admin(`set role ${role}; ${statement}`)).toThrow();
    }
    expect(() =>
      admin("set role evaluation_worker; select private.evaluation_open('{}')"),
    ).toThrow();
    expect(() =>
      admin(
        'set role evaluation_operator; select private.evaluation_claim(gen_random_uuid())',
      ),
    ).toThrow();
    for (const table of [
      'public.attempts',
      'public.attempt_grades',
      'private.rubrics',
      'private.content_candidates',
      'private.qualification_runs',
    ])
      expect(
        admin(
          `select has_table_privilege('evaluation_engine','${table}','select')`,
        ),
      ).toBe('f');
    for (const signature of [
      'private.qualification_open_batch(jsonb)',
      'private.import_content_manifest(jsonb)',
      'private.publish_content_batch(jsonb)',
    ])
      expect(
        admin(
          `select has_function_privilege('evaluation_engine','${signature}','execute')`,
        ),
      ).toBe('f');
    expect(
      admin(
        "select count(*) from pg_auth_members where roleid=(select oid from pg_roles where rolname='evaluation_engine') and (inherit_option or set_option)",
      ),
    ).toBe('0');
    vi.unstubAllGlobals();
    const anon = client();
    const rpc = await anon.rpc('evaluation_open' as never, {} as never);
    expect(rpc.error).not.toBeNull();
    const privateTable = await anon
      .from('evaluation_reports' as never)
      .select('*');
    expect(privateTable.error).not.toBeNull();
  });
  it('serializes concurrent claims and enforces shared grading and qualification ceilings in both directions', async () => {
    const { plan, run } = enroll({ dailyCap: 10 });
    currentRun = run;
    const exec = promisify(execFile);
    const claims = await Promise.all(
      [1, 2].map(() =>
        exec('psql', [
          '-X',
          '-w',
          '-q',
          '-v',
          'ON_ERROR_STOP=1',
          '-Atc',
          `select private.evaluation_claim('${run}')`,
        ]),
      ),
    );
    expect(claims.filter((c) => c.stdout.trim())).toHaveLength(1);
    const work = JSON.parse(claims.find((c) => c.stdout.trim())!.stdout);
    evaluationSql('reserve', [run, work.lease, false]);
    const second = enroll({ dailyCap: 10 });
    currentRun = second.run;
    const transport = provider(second.plan);
    expect(await evaluateOnce(second.run)).toMatchObject({
      state: 'queued',
      reason: 'BUDGET_EXCEEDED',
      requestsUsed: 0,
    });
    expect(transport).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    const bundle = termBundle(`evaluation-shared-${randomUUID()}`);
    importBundles([bundle]);
    const config = {
      policyVersion: 'content-policy-v2',
      modelVersion: plan.configuration.modelVersion,
      promptVersion: plan.configuration.promptVersion,
      schemaVersion: plan.configuration.schemaVersion,
      fixtureVersion: plan.configuration.fixtureVersion,
      graderVersion: plan.configuration.graderVersion,
      gradingPromptVersion: plan.configuration.gradingPromptVersion,
      reasoningEffort: 'low',
      gradingSchemaVersion: plan.configuration.gradingSchemaVersion,
      toolchainVersion: 'nonexecutable-tests-v1',
      modelEvaluationDigest: '1'.repeat(64),
      modelEvaluationProtocolVersion: 'release-evaluation-v3',
      privacyApprovalDigest: '2'.repeat(64),
      deploymentApprovalDigest: '3'.repeat(64),
      providerConfigurationDigest: '4'.repeat(64),
      enabled: true,
      publicationEnabled: false,
      requestCents: 10,
      dailyCap: 10,
      monthlyCap: 2000,
      batchCap: 2000,
      expiresAt: plan.configuration.expiresAt,
    };
    const batch = admin(
      `set role qualification_operator; select private.qualification_open_batch(${literal(config)})`,
    );
    const { snapshots } = await import('@/tests/fixtures/evaluation');
    const job = admin(
      `set role qualification_operator; select private.qualification_enqueue('${bundle.id}','${batch}',${literal(snapshots(bundle))})`,
    );
    const q = JSON.parse(
      admin(
        `set role qualification_worker; select private.qualification_claim('${job}')`,
      ),
    );
    const prompt = {
      input: 'Synthetic.',
      instructions: 'Synthetic.',
      schema: { type: 'object' },
      modelVersion: config.modelVersion,
      promptVersion: config.promptVersion,
      schemaVersion: config.schemaVersion,
      reasoningEffort: config.reasoningEffort,
    };
    expect(() =>
      admin(
        `set role qualification_worker; select private.qualification_reserve_cost('${job}','${q.lease}','source',false,${literal(prompt)})`,
      ),
    ).toThrow(/BUDGET_EXCEEDED/);
    vi.stubEnv('PGOPTIONS', '');
    const user = await testUser();
    const question = questionBundle(`evaluation-shared-${randomUUID()}`);
    importBundles([question]);
    publish([release(question, installEvidence(question))]);
    const item = await user.db.rpc('start_study', {
      p_question: question.id,
      p_timezone: 'UTC',
    });
    const submitted = await user.db.rpc('submit_answer', {
      p_item: item.data!,
      p_version: 0,
      p_answer: 'Synthetic.',
      p_confidence: 'guess',
      p_assisted: false,
      p_device: randomUUID(),
      p_question: question.id,
      p_key: randomUUID(),
    });
    expect(submitted.error).toBeNull();
    const lease = randomUUID();
    admin(
      `update public.grading_jobs set state='grading',lease_token='${lease}',lease_until=now()+interval '90 seconds' where attempt_id='${submitted.data}'`,
    );
    expect(() =>
      admin(
        `set role service_role;select public.reserve_provider_request('${submitted.data}',1,'${lease}',10,10,2000,false)`,
      ),
    ).toThrow(/BUDGET_EXCEEDED/);
    admin("update private.provider_requests set created_at='2020-01-01'");
    const learner = admin(
      `set role service_role;select public.reserve_provider_request('${submitted.data}',1,'${lease}',10,10,2000,false)`,
    );
    expect(learner).toBeTruthy();
    vi.stubEnv('PGOPTIONS', '-c role=evaluation_worker');
    const recovered = claim(second.run);
    expect(() =>
      evaluationSql('reserve', [second.run, recovered.lease, false]),
    ).toThrow('BUDGET_EXCEEDED');
    admin("update private.provider_requests set created_at='2020-01-01'");
    const competing = await Promise.allSettled([
      exec('psql', [
        '-X',
        '-w',
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
        '-Atc',
        `set role postgres;set role service_role;select public.reserve_provider_request('${submitted.data}',1,'${lease}',10,10,2000,false)`,
      ]),
      exec('psql', [
        '-X',
        '-w',
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
        '-Atc',
        `select private.evaluation_reserve('${second.run}','${recovered.lease}',false)`,
      ]),
    ]);
    expect(competing.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const denied = competing.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(String(denied.reason.stderr)).toContain('BUDGET_EXCEEDED');
    expect(
      admin(
        "select sum(coalesce(actual_cents,reserved_cents)) from private.provider_requests where created_at>=date_trunc('day',now())",
      ),
    ).toBe('10');
    admin(
      "update private.provider_requests set created_at=now()-interval '1 day' where created_at>'2020-01-02'",
    );
    const monthly = enroll({ monthlyCap: 10 });
    currentRun = monthly.run;
    const noTransport = provider(monthly.plan);
    expect(await evaluateOnce(monthly.run)).toMatchObject({
      state: 'queued',
      reason: 'BUDGET_EXCEEDED',
      requestsUsed: 0,
    });
    expect(noTransport).not.toHaveBeenCalled();
  });
});
