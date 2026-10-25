import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import type { Database, Json } from '@/lib/contracts/database.types';
import { workSchema } from '@/lib/server/ai/grader';
import { recoverOne } from '@/lib/server/services/recover-grading';
import { stateSchema } from '@/lib/contracts/study';
import { replayReview, type ReviewEvent } from '@/lib/domain/review';
import { activeMsOnLocalDay } from '@/lib/domain/timing';

const url = process.env.TEST_SUPABASE_URL ?? '';
const key = process.env.TEST_SUPABASE_KEY ?? '';
const serviceKey = process.env.TEST_SERVICE_KEY ?? '';
const client = (credential = key) =>
  createClient<Database>(url, credential, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
let admin: SupabaseClient<Database>;
let a: SupabaseClient<Database>;
let b: SupabaseClient<Database>;
let uid: string;
const question = '10000000-0000-4000-8000-000000000001';
const device = randomUUID();
const scored = {
  outcome: 'scored',
  score: 3,
  criticalClaimsMet: true,
  correctClaims: ['Lifetime ends.'],
  missingClaims: [],
  incorrectClaims: [],
  idealAnswer: 'Return an owning string.',
  explanation: 'The view does not own storage.',
};

function sql(statement: string) {
  return execFileSync(
    'docker',
    [
      'exec',
      'supabase_db_sweprep',
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-Atc',
      statement,
    ],
    { encoding: 'utf8' },
  ).trim();
}

async function user() {
  const db = client();
  const email = `integration-${randomUUID()}@example.test`;
  const password = randomBytes(24).toString('hex');
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  expect(created.error).toBeNull();
  const signed = await db.auth.signInWithPassword({ email, password });
  expect(signed.error).toBeNull();
  return { db, id: signed.data.user?.id ?? '' };
}

async function start(db = a) {
  const result = await db.rpc('start_study', {
    p_question: question,
    p_timezone: 'America/New_York',
  });
  expect(result.error).toBeNull();
  return result.data as string;
}

function checkpoint(
  item: string,
  version = 0,
  answer = 'The local string is destroyed.',
) {
  return {
    p_item: item,
    p_version: version,
    p_answer: answer,
    p_confidence: 'certain',
    p_assisted: false,
    p_device: device,
    p_action: 'claim',
  };
}

async function submit(
  db = a,
  answer = 'The non-owning view dangles.',
  assisted = false,
) {
  const item = await start(db);
  const input = {
    p_item: item,
    p_version: 0,
    p_question: question,
    p_answer: answer,
    p_confidence: 'certain',
    p_assisted: assisted,
    p_device: device,
    p_key: randomUUID(),
  };
  const result = await db.rpc('submit_answer', input);
  expect(result.error).toBeNull();
  return { id: result.data as string, item, input };
}

async function claim() {
  const result = await admin.rpc('claim_grading');
  expect(result.error).toBeNull();
  return workSchema.parse(result.data);
}

function identity(work: ReturnType<typeof workSchema.parse>) {
  return {
    p_attempt: work.job.attempt_id,
    p_generation: work.job.generation,
    p_lease: work.job.lease_token,
  };
}

async function finish(
  work: ReturnType<typeof workSchema.parse>,
  result: Json = scored,
  simulated = false,
) {
  return admin.rpc('finalize_grade', {
    ...identity(work),
    p_result: result,
    p_simulated: simulated,
    p_model: 'fixture-no-network',
  });
}

beforeAll(async () => {
  if (new URL(url).hostname !== '127.0.0.1')
    throw new Error('Local database required.');
  admin = client(serviceKey);
  ({ db: a, id: uid } = await user());
  ({ db: b } = await user());
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = key;
  process.env.APP_URL = 'http://localhost:3000';
  process.env.GRADING_MODE = 'simulated';
  process.env.ALLOW_LOCAL_SIMULATION = 'true';
});

describe('real authenticated database', { concurrent: false }, () => {
  it('keeps drafts private, rejects direct writes and protects rubric and grader functions', async () => {
    const item = await start();
    expect((await a.rpc('checkpoint', checkpoint(item))).error).toBeNull();
    expect(
      (await b.from('session_items').select().eq('id', item)).data,
    ).toEqual([]);
    expect(
      (await client().from('question_versions').select()).error,
    ).not.toBeNull();
    expect(
      (await b.rpc('checkpoint', checkpoint(item, 1))).error?.message,
    ).toBe('FORBIDDEN');
    expect(
      (
        await a
          .from('session_items')
          .update({ user_id: randomUUID() })
          .eq('id', item)
      ).error,
    ).not.toBeNull();
    expect(
      (
        await a.from('attempt_grades').insert({
          attempt_id: randomUUID(),
          user_id: uid,
          generation: 1,
          outcome: 'scored',
          score: 5,
          passed: true,
          details: scored,
          rubric_version: 'fake',
          grader_version: 'fake',
          model: 'fake',
          prompt_version: 'fake',
          validator_version: 'fake',
          worker_lease: randomUUID(),
          simulated: false,
        })
      ).error,
    ).not.toBeNull();
    expect(
      (
        await a.from('review_episodes').insert({
          id: randomUUID(),
          user_id: uid,
          question_id: 'x',
          first_missed_at: new Date().toISOString(),
          streak: 999,
        })
      ).error,
    ).not.toBeNull();
    expect((await a.rpc('claim_grading')).error).not.toBeNull();
    expect(
      (
        await a.rpc('finalize_grade', {
          p_attempt: randomUUID(),
          p_generation: 1,
          p_lease: randomUUID(),
          p_result: scored,
          p_simulated: false,
          p_model: 'forged',
        })
      ).error,
    ).not.toBeNull();
    const session = await a.auth.getSession();
    const response = await fetch(`${url}/rest/v1/rubrics?select=*`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${session.data.session?.access_token}`,
      },
    });
    expect(response.ok).toBe(false);
    const privateResponse = await fetch(`${url}/rest/v1/rubrics?select=*`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${session.data.session?.access_token}`,
        'Accept-Profile': 'private',
      },
    });
    expect(privateResponse.ok).toBe(false);
    const saved = await a
      .from('session_items')
      .select()
      .eq('id', item)
      .single();
    expect(saved.data?.answer_text).toBe('The local string is destroyed.');
    expect(
      (
        await a.rpc('submit_answer', {
          p_item: item,
          p_version: 1,
          p_question: question,
          p_answer: 'The view dangles.',
          p_confidence: 'certain',
          p_assisted: false,
          p_device: device,
          p_key: randomUUID(),
        })
      ).error,
    ).toBeNull();
    expect((await finish(await claim(), scored, true)).error).toBeNull();
  });

  it('rejects stale draft versions and stale timing owners without overlapping segments', async () => {
    const item = await start();
    const first = await a.rpc('checkpoint', checkpoint(item));
    expect(first.error).toBeNull();
    const heartbeat = await a.rpc('checkpoint', {
      ...checkpoint(item, 1),
      p_action: 'save',
    });
    expect(heartbeat.error).toBeNull();
    expect(heartbeat.data?.version).toBe(1);
    const pause = await a.rpc('checkpoint', {
      ...checkpoint(item, 1),
      p_action: 'pause',
    });
    expect(pause.error).toBeNull();
    expect(pause.data?.version).toBe(1);
    const resume = await a.rpc('checkpoint', {
      ...checkpoint(item, 1),
      p_action: 'resume',
    });
    expect(resume.error).toBeNull();
    expect(resume.data?.version).toBe(1);
    expect(
      (await a.rpc('checkpoint', checkpoint(item, 0, 'Stale other copy'))).error
        ?.message,
    ).toBe('SYNC_CONFLICT');
    const otherDevice = randomUUID();
    expect(
      (
        await a.rpc('checkpoint', {
          ...checkpoint(item, 1),
          p_device: otherDevice,
          p_action: 'claim',
        })
      ).error?.message,
    ).toBe('TIMER_OWNED');
    expect(
      (
        await a.rpc('checkpoint', {
          ...checkpoint(item, 1, 'Cloud second device'),
          p_device: otherDevice,
          p_action: 'takeover',
        })
      ).error,
    ).toBeNull();
    expect(
      (await a.rpc('checkpoint', { ...checkpoint(item, 2), p_action: 'save' }))
        .error?.message,
    ).toBe('TIMER_OWNED');
    sql(
      `update public.session_items set lease_until=now()-interval '1 second',last_ack_at=now()-interval '40 seconds' where id='${item}'`,
    );
    expect(
      (
        await a.rpc('checkpoint', {
          ...checkpoint(item, 2),
          p_device: otherDevice,
          p_action: 'save',
        })
      ).error,
    ).toBeNull();
    const segments = await a
      .from('timing_segments')
      .select()
      .eq('item_id', item);
    expect(segments.data).toHaveLength(2);
    const ordered = [...(segments.data ?? [])].sort(
      (left, right) =>
        Date.parse(left.started_at) - Date.parse(right.started_at),
    );
    expect(Date.parse(ordered[0].ended_at)).toBeLessThanOrEqual(
      Date.parse(ordered[1].started_at),
    );
    expect(
      (await a.from('session_items').select('paused').eq('id', item).single())
        .data?.paused,
    ).toBe(true);
    expect(
      (
        await a.rpc('submit_answer', {
          p_item: item,
          p_version: 3,
          p_question: question,
          p_answer: 'Saved after expiry',
          p_confidence: 'certain',
          p_assisted: false,
          p_device: otherDevice,
          p_key: randomUUID(),
        })
      ).error,
    ).toBeNull();
    expect((await finish(await claim(), scored, true)).error).toBeNull();
  });

  it('serializes duplicate submission and detects key payload changes', async () => {
    const item = await start();
    const input = {
      p_item: item,
      p_version: 0,
      p_question: question,
      p_answer: 'Return an owning string.',
      p_confidence: 'certain',
      p_assisted: false,
      p_device: device,
      p_key: randomUUID(),
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => a.rpc('submit_answer', input)),
    );
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(new Set(results.map((r) => r.data)).size).toBe(1);
    expect(
      (await a.rpc('submit_answer', { ...input, p_answer: 'Changed payload' }))
        .error?.message,
    ).toBe('IDEMPOTENCY_CONFLICT');
    expect(
      (await a.rpc('submit_answer', { ...input, p_key: randomUUID() })).error
        ?.message,
    ).toBe('ALREADY_SUBMITTED');
    const saved = await a.from('attempts').select().eq('item_id', item);
    expect(saved.data).toHaveLength(1);
    expect(
      (await b.from('attempts').select().eq('item_id', item)).data,
    ).toEqual([]);
    expect(
      (await b.rpc('retry_grade', { p_attempt: results[0].data as string }))
        .error?.message,
    ).toBe('FORBIDDEN');
    expect(
      (
        await a
          .from('attempts')
          .update({ score: 5 } as never)
          .eq('item_id', item)
      ).error,
    ).not.toBeNull();
    expect((await finish(await claim())).error).toBeNull();
  });

  it('recovers expired work and rejects stale finalization; finalization is atomic and idempotent', async () => {
    const submitted = await submit();
    const old = await claim();
    sql(
      `update public.grading_jobs set lease_until=now()-interval '1 second' where attempt_id='${submitted.id}'`,
    );
    const recovered = await claim();
    expect(recovered.job.lease_token).not.toBe(old.job.lease_token);
    expect((await finish(old)).error?.message).toBe('STALE_LEASE');
    expect(
      (await finish(recovered, { ...scored, score: 9 })).error?.message,
    ).toBe('VALIDATION_ERROR');
    expect(
      (await a.from('attempt_grades').select().eq('attempt_id', submitted.id))
        .data,
    ).toEqual([]);
    expect(
      (
        await a
          .from('grading_jobs')
          .select('state')
          .eq('attempt_id', submitted.id)
          .single()
      ).data?.state,
    ).toBe('grading');
    const completions = await Promise.all([
      finish(recovered),
      finish(recovered),
    ]);
    expect(completions.every((r) => r.error === null)).toBe(true);
    expect(completions[0].data).toBe(completions[1].data);
    expect((await finish(old)).error?.message).toBe('STALE_LEASE');
    expect(
      (await a.from('grade_selections').select().eq('attempt_id', submitted.id))
        .data,
    ).toHaveLength(1);
    expect(
      (
        await a
          .from('session_items')
          .select('state')
          .eq('id', submitted.item)
          .single()
      ).data?.state,
    ).toBe('graded');
  });

  it('reserves concurrent provider costs before dispatch, persists repair and request limits across recovery', async () => {
    await submit();
    const work = await claim();
    const reservation = {
      ...identity(work),
      p_cents: 60,
      p_daily_cap: 100,
      p_monthly_cap: 2000,
      p_repair: false,
    };
    const results = await Promise.all([
      admin.rpc('reserve_provider_request', reservation),
      admin.rpc('reserve_provider_request', reservation),
    ]);
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect(results.find((r) => r.error)?.error?.message).toBe(
      'BUDGET_EXCEEDED',
    );
    const accepted = results.find((r) => !r.error)?.data as string;
    expect(
      (
        await admin.rpc('settle_provider_request', {
          p_request: accepted,
          p_cents: 0,
          p_usage: { inputTokens: 0 },
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await admin.rpc('reserve_provider_request', {
          ...reservation,
          p_cents: 10,
          p_repair: true,
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await admin.rpc('reserve_provider_request', {
          ...reservation,
          p_cents: 10,
          p_repair: true,
        })
      ).error?.message,
    ).toBe('REQUEST_LIMIT');
    expect(
      (
        await admin.rpc('fail_grading', {
          ...identity(work),
          p_error: 'PROVIDER_TIMEOUT',
          p_retry_seconds: 30,
        })
      ).error,
    ).toBeNull();
    sql(
      `update public.grading_jobs set next_attempt_at=now()-interval '1 second' where attempt_id='${work.job.attempt_id}'`,
    );
    const retry = await claim();
    expect(retry.job.request_count).toBe(2);
    expect(retry.job.repair_used).toBe(true);
    expect(
      (
        await admin.rpc('reserve_provider_request', {
          ...reservation,
          ...identity(retry),
          p_cents: 10,
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await admin.rpc('reserve_provider_request', {
          ...reservation,
          ...identity(retry),
          p_cents: 10,
        })
      ).error?.message,
    ).toBe('REQUEST_LIMIT');
    expect(
      (
        await admin.rpc('fail_grading', {
          ...identity(retry),
          p_error: 'PROVIDER_TIMEOUT',
          p_retry_seconds: 120,
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await a
          .from('grading_jobs')
          .select('state')
          .eq('attempt_id', work.job.attempt_id)
          .single()
      ).data?.state,
    ).toBe('failed');
  });

  it('uses the second-request delay when malformed output is followed by a repair timeout', async () => {
    const learner = await user();
    const approvedQuestion = randomUUID();
    sql(`insert into public.question_versions(id,question_id,version,title,skill,skill_id,content_blocks,content_review,prompt_version)
      select '${approvedQuestion}','synthetic-repair-test',1,title,skill,skill_id,content_blocks,'approved',prompt_version from public.question_versions where id='${question}';
      insert into private.rubrics(question_version_id,version,pass_score,required_claims,reference_answer)
      select '${approvedQuestion}',version,pass_score,required_claims,reference_answer from private.rubrics where question_version_id='${question}'`);
    const item = await learner.db.rpc('start_study', {
      p_question: approvedQuestion,
      p_timezone: 'UTC',
    });
    expect(item.error).toBeNull();
    const attempt = await learner.db.rpc('submit_answer', {
      p_item: item.data as string,
      p_version: 0,
      p_question: approvedQuestion,
      p_answer: 'Synthetic provider-transport test.',
      p_confidence: 'unsure',
      p_assisted: false,
      p_device: device,
      p_key: randomUUID(),
    });
    expect(attempt.error).toBeNull();
    for (const [name, value] of Object.entries({
      GRADING_MODE: 'live',
      CONTENT_REVIEW_APPROVED: 'true',
      MODEL_EVAL_APPROVED: 'true',
      PROVIDER_DATA_POLICY_APPROVED: 'true',
      DEPLOYMENT_RECOVERY_APPROVED: 'true',
      AI_DAILY_CAP_CENTS: '100',
      AI_MONTHLY_CAP_CENTS: '2000',
      OPENAI_MODEL: 'gpt-5.4-mini-2026-03-17',
      OPENAI_API_KEY: 'synthetic-test-only-not-a-credential',
    }))
      vi.stubEnv(name, value);
    const realFetch = globalThis.fetch;
    let providerCalls = 0;
    const transport = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const target = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (target.origin === 'https://api.openai.com') {
          providerCalls++;
          if (providerCalls > 1)
            throw new DOMException('Synthetic repair timeout', 'AbortError');
          return Response.json({
            object: 'response',
            id: 'synthetic-invalid-response',
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [
                  {
                    type: 'output_text',
                    text: '{"assessment":{"score":99}}',
                    annotations: [],
                  },
                ],
              },
            ],
            usage: { input_tokens: 2000, output_tokens: 50 },
          });
        }
        if (target.origin !== new URL(url).origin)
          throw new Error('Unexpected network destination');
        return realFetch(input, init);
      });
    try {
      expect(await recoverOne(admin)).toEqual({
        processed: true,
        outcome: 'PROVIDER_TIMEOUT',
      });
      expect(providerCalls).toBe(2);
      const job = (
        await learner.db
          .from('grading_jobs')
          .select()
          .eq('attempt_id', attempt.data as string)
          .single()
      ).data;
      expect(job).toMatchObject({
        request_count: 2,
        repair_used: true,
        state: 'retry_wait',
      });
      expect(
        Date.parse(job?.next_attempt_at ?? '') -
          Date.parse(job?.updated_at ?? ''),
      ).toBe(120000);
      expect(
        sql(
          `select count(*) from private.provider_requests where attempt_id='${attempt.data}'`,
        ),
      ).toBe('2');
    } finally {
      transport.mockRestore();
      vi.unstubAllEnvs();
      sql(
        `update public.grading_jobs set state='failed' where attempt_id='${attempt.data}'`,
      );
    }
  });

  it('preserves prior scored grades during failed/uncertain regrade and replays corrections and invalidation', async () => {
    const { id } = await submit();
    const first = await finish(await claim(), {
      ...scored,
      score: 5,
      criticalClaimsMet: false,
    });
    expect(first.error).toBeNull();
    expect(
      (await a.from('review_episodes').select().eq('user_id', uid)).data,
    ).toHaveLength(1);
    expect((await a.rpc('retry_grade', { p_attempt: id })).data).toBe(2);
    expect(
      (
        await finish(await claim(), {
          outcome: 'uncertain',
          reason: 'Insufficient evidence.',
        })
      ).error,
    ).toBeNull();
    expect(
      (await a.from('grade_selections').select().eq('attempt_id', id)).data,
    ).toHaveLength(1);
    expect((await a.rpc('retry_grade', { p_attempt: id })).data).toBe(3);
    expect((await finish(await claim(), scored)).error).toBeNull();
    expect(
      (await a.from('review_episodes').select().eq('user_id', uid)).data,
    ).toEqual([]);
    expect((await a.rpc('retry_grade', { p_attempt: id })).data).toBe(4);
    expect(
      (await finish(await claim(), { ...scored, score: 1 })).error,
    ).toBeNull();
    expect(
      (await a.from('review_episodes').select().eq('user_id', uid)).data,
    ).toHaveLength(1);
    expect((await a.rpc('retry_grade', { p_attempt: id })).data).toBe(5);
    expect(
      (
        await finish(await claim(), {
          outcome: 'invalidated',
          reason: 'Question content needs review.',
        })
      ).error,
    ).toBeNull();
    expect(
      (await a.from('review_episodes').select().eq('user_id', uid)).data,
    ).toEqual([]);
    expect(
      (await a.from('attempt_grades').select().eq('attempt_id', id)).data,
    ).toHaveLength(5);
    expect(() =>
      sql(`update public.attempts set answer_text='changed' where id='${id}'`),
    ).toThrow();
  });

  it('uses browser-independent recovery for failed, retried, scored and uncertain local simulation', async () => {
    const { id } = await submit(a, '[simulate-failure] Demonstrate recovery.');
    expect(await recoverOne(admin)).toEqual({
      processed: true,
      outcome: 'SIMULATED_FAILURE',
    });
    expect((await a.rpc('retry_grade', { p_attempt: id })).data).toBe(2);
    expect(await recoverOne(admin)).toEqual({
      processed: true,
      outcome: 'scored',
    });
    const grades = (
      await a.from('attempt_grades').select().eq('attempt_id', id)
    ).data;
    expect(grades?.[0].simulated).toBe(true);
    await submit(a, '[simulate-uncertain] Context is ambiguous.');
    expect(await recoverOne(admin)).toEqual({
      processed: true,
      outcome: 'uncertain',
    });
    const state = await a.rpc('study_state');
    expect(state.error).toBeNull();
    expect(
      stateSchema.safeParse({
        ...(state.data as object),
        userId: uid,
        email: 'test@example.test',
        gradingMode: 'simulated',
      }).success,
    ).toBe(true);
    const invalidConfiguration = await submit(
      a,
      'Synthetic configuration failure.',
    );
    process.env.ALLOW_LOCAL_SIMULATION = 'false';
    try {
      expect(await recoverOne(admin)).toEqual({
        processed: true,
        outcome: 'GRADING_UNAVAILABLE',
      });
      expect(
        (
          await a
            .from('grading_jobs')
            .select('state')
            .eq('attempt_id', invalidConfiguration.id)
            .single()
        ).data?.state,
      ).toBe('failed');
    } finally {
      process.env.ALLOW_LOCAL_SIMULATION = 'true';
    }
  });

  it('replays out-of-order grades with elapsed-day graduation, neutral uncertainty and a fresh relapse episode', async () => {
    const learner = await user();
    const day = 86400000;
    const epoch = Date.parse('2026-01-01T00:00:00Z');
    const events: ReviewEvent[] = [
      {
        id: randomUUID(),
        submittedAt: epoch,
        outcome: 'failed',
        assisted: false,
        source: 'first',
        jitter: 0.5,
      },
      ...Array.from({ length: 10 }, (_, index): ReviewEvent => ({
        id: randomUUID(),
        submittedAt: epoch + (index === 9 ? 29 : index + 1) * day,
        outcome: 'passed',
        assisted: false,
        source: 'review',
        jitter: 0.5,
      })),
      {
        id: randomUUID(),
        submittedAt: epoch + 30 * day,
        outcome: 'unscored',
        assisted: false,
        source: 'review',
        jitter: 0.5,
      },
      {
        id: randomUUID(),
        submittedAt: epoch + 30 * day + 1000,
        outcome: 'passed',
        assisted: false,
        source: 'review',
        jitter: 0.5,
      },
      {
        id: randomUUID(),
        submittedAt: epoch + 31 * day,
        outcome: 'failed',
        assisted: false,
        source: 'review',
        jitter: 0.5,
      },
      {
        id: randomUUID(),
        submittedAt: epoch + 32 * day,
        outcome: 'passed',
        assisted: true,
        source: 'review',
        jitter: 0.5,
      },
      {
        id: randomUUID(),
        submittedAt: epoch + 33 * day,
        outcome: 'passed',
        assisted: false,
        source: 'review',
        jitter: 0.5,
      },
    ];
    for (const event of events) {
      const session = randomUUID(),
        item = randomUUID();
      sql(`insert into public.sessions(id,user_id,state) values('${session}','${learner.id}','submitted');
        insert into public.session_items(id,user_id,session_id,question_version_id,source,state) values('${item}','${learner.id}','${session}','${question}','${event.source}','submitted');
        insert into public.attempts(id,user_id,item_id,question_version_id,answer_text,confidence,assisted,source,active_ms,submitted_at,idempotency_key,request_fingerprint,scheduling_jitter)
          values('${event.id}','${learner.id}','${item}','${question}','Synthetic historical answer','unsure',${event.assisted},'${event.source}',0,'${new Date(event.submittedAt).toISOString()}','${randomUUID()}','fixture',0.5);
        insert into public.grading_jobs(attempt_id,user_id) values('${event.id}','${learner.id}');`);
    }
    const jobs = new Map<string, Awaited<ReturnType<typeof claim>>>();
    for (let index = 0; index < events.length; index++) {
      const job = await claim();
      jobs.set(job.job.attempt_id, job);
    }
    const finishEvent = async (event: ReviewEvent) => {
      const job = jobs.get(event.id);
      if (!job) throw new Error('Missing historical grading work');
      expect(
        (
          await finish(
            job,
            event.outcome === 'unscored'
              ? { outcome: 'uncertain', reason: 'Synthetic uncertainty.' }
              : { ...scored, score: event.outcome === 'failed' ? 1 : 3 },
          )
        ).error,
      ).toBeNull();
    };
    for (const event of events.slice(0, 11).reverse()) await finishEvent(event);
    let rows = (
      await learner.db.from('review_episodes').select().order('first_missed_at')
    ).data;
    expect(rows?.[0]).toMatchObject({ streak: 10, graduated_at: null });
    for (const event of events.slice(11)) await finishEvent(event);
    rows = (
      await learner.db.from('review_episodes').select().order('first_missed_at')
    ).data;
    const reference = replayReview(events);
    expect(rows).toHaveLength(2);
    for (const [index, expected] of reference.entries()) {
      const actual = rows?.[index];
      expect(actual?.id).toBe(expected.id);
      expect(actual?.streak).toBe(expected.streak);
      expect(
        actual?.graduated_at ? Date.parse(actual.graduated_at) : null,
      ).toBe(expected.graduatedAt);
      expect(actual?.next_due_at ? Date.parse(actual.next_due_at) : null).toBe(
        expected.nextDueAt,
      );
      expect(
        actual?.first_missed_at ? Date.parse(actual.first_missed_at) : null,
      ).toBe(expected.firstMissedAt);
    }
  });

  it('rejects null CAS versions, oversized direct requests and forged composite ownership', async () => {
    const learner = await user();
    const item = await start(learner.db);
    const session = await learner.db.auth.getSession();
    const response = await fetch(`${url}/rest/v1/rpc/checkpoint`, {
      method: 'POST',
      headers: {
        apikey: key,
        authorization: `Bearer ${session.data.session?.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...checkpoint(item), p_version: null }),
    });
    expect(response.ok).toBe(false);
    expect((await response.json()).message).toBe('SYNC_CONFLICT');
    expect(
      (
        await learner.db.rpc(
          'checkpoint',
          checkpoint(item, 0, 'x'.repeat(12001)),
        )
      ).error?.message,
    ).toBe('VALIDATION_ERROR');
    const foreignSession = randomUUID();
    sql(
      `insert into public.sessions(id,user_id,state) values('${foreignSession}','${learner.id}','submitted')`,
    );
    expect(() =>
      sql(`insert into public.session_items(user_id,session_id,question_version_id,source)
      values('${uid}','${foreignSession}','${question}','first')`),
    ).toThrow(/session_items_session_id_user_id_fkey/);
    sql(
      `insert into private.grading_requests(user_id) select '${learner.id}' from generate_series(1,30);`,
    );
    expect(
      (
        await learner.db.rpc('submit_answer', {
          p_item: item,
          p_version: 0,
          p_question: question,
          p_answer: 'Synthetic text',
          p_confidence: 'unsure',
          p_assisted: false,
          p_device: device,
          p_key: randomUUID(),
        })
      ).error?.message,
    ).toBe('RETRY_LIMIT');
    expect((await learner.db.from('attempts').select()).data).toEqual([]);
  });

  it('aggregates UTC timing events across local midnight and rebuckets a changed profile timezone', async () => {
    const learner = await user();
    const item = await start(learner.db);
    sql(`insert into public.timing_segments(user_id,item_id,started_at,ended_at)
      select '${learner.id}','${item}',boundary - interval '10 seconds',boundary + interval '10 seconds'
      from (select (now() at time zone 'America/New_York')::date::timestamp at time zone 'America/New_York' as boundary) b`);
    const first = (await learner.db.rpc('study_state')).data as {
      todayMs: number;
    };
    expect(first.todayMs).toBe(10000);
    sql(
      `update public.profiles set timezone='UTC' where user_id='${learner.id}'`,
    );
    const second = (await learner.db.rpc('study_state')).data as {
      todayMs: number;
      serverNow: string;
    };
    const segments =
      (await learner.db.from('timing_segments').select()).data ?? [];
    expect(second.todayMs).toBe(
      activeMsOnLocalDay(
        segments.map((value) => ({
          startedAt: Date.parse(value.started_at),
          endedAt: Date.parse(value.ended_at),
        })),
        second.serverNow.slice(0, 10),
        'UTC',
      ),
    );
    expect(segments).toHaveLength(1);
  });

  it('verifies real HTTP cookies, rejects forged requests and recovers without a browser', async () => {
    const origin = process.env.TEST_APP_URL ?? '';
    const cookieHeader = async (db: SupabaseClient<Database>) => {
      const session = (await db.auth.getSession()).data.session;
      if (!session) throw new Error('Missing test session');
      const jar = new Map<string, string>();
      const ssr = createServerClient<Database>(url, key, {
        cookies: {
          getAll: () => [...jar].map(([name, value]) => ({ name, value })),
          setAll: (values) =>
            values.forEach(({ name, value }) => jar.set(name, value)),
        },
      });
      expect((await ssr.auth.setSession(session)).error).toBeNull();
      return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    };
    const owner = await user(),
      outsider = await user();
    const item = await start(owner.db);
    const ownerCookie = await cookieHeader(owner.db),
      outsiderCookie = await cookieHeader(outsider.db);
    expect((await fetch(`${origin}/api/study`)).status).toBe(401);
    const stateResponse = await fetch(`${origin}/api/study`, {
      headers: { cookie: ownerCookie },
    });
    expect(stateResponse.status).toBe(200);
    expect(stateResponse.headers.get('cache-control')).toContain('no-store');
    expect(
      stateSchema
        .parse(await stateResponse.json())
        .items.some((value) => value.id === item),
    ).toBe(true);
    const otherResponse = await fetch(`${origin}/api/study`, {
      headers: { cookie: outsiderCookie },
    });
    expect(stateSchema.parse(await otherResponse.json()).items).toEqual([]);
    const input = {
      action: 'checkpoint',
      itemId: item,
      version: 0,
      answer: 'Foreign attempt',
      confidence: 'unsure',
      assisted: false,
      deviceId: device,
      timingAction: 'save',
    };
    const denied = await fetch(`${origin}/api/study`, {
      method: 'POST',
      headers: {
        origin,
        cookie: outsiderCookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    expect(denied.status).toBe(403);
    const forged = await fetch(`${origin}/api/study`, {
      method: 'POST',
      headers: {
        origin,
        cookie: ownerCookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...input, userId: owner.id, score: 5 }),
    });
    expect(forged.status).toBe(400);
    const crossSite = await fetch(`${origin}/api/study`, {
      method: 'POST',
      headers: {
        origin: 'https://other.example.test',
        cookie: ownerCookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    expect(crossSite.status).toBe(403);
    const submitted = await fetch(`${origin}/api/study`, {
      method: 'POST',
      headers: {
        origin,
        cookie: ownerCookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'submit',
        itemId: item,
        version: 0,
        questionId: question,
        answer: 'Synthetic HTTP answer.',
        confidence: 'unsure',
        assisted: false,
        deviceId: device,
        key: randomUUID(),
      }),
    });
    expect(submitted.status).toBe(200);
    expect(
      (await fetch(`${origin}/api/internal/recover`, { method: 'POST' }))
        .status,
    ).toBe(403);
    const recovered = await fetch(`${origin}/api/internal/recover`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.TEST_RECOVERY_SECRET}` },
    });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({
      processed: true,
      outcome: 'scored',
    });
    expect(
      (await owner.db.from('attempt_grades').select()).data?.[0].simulated,
    ).toBe(true);
  });
});
