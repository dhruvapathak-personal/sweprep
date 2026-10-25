import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/contracts/database.types';
import { workSchema } from '@/lib/server/ai/grader';
import { recoverOne } from '@/lib/server/services/recover-grading';
import { stateSchema } from '@/lib/contracts/study';

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
        await a
          .from('attempt_grades')
          .insert({
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
            simulated: false,
          })
      ).error,
    ).not.toBeNull();
    expect(
      (
        await a
          .from('review_episodes')
          .insert({
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
    expect(segments.data).toEqual([]);
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

  it('preserves prior scored grades during failed/uncertain regrade and replays corrections and invalidation', async () => {
    const { id } = await submit();
    const first = await finish(await claim(), { ...scored, score: 1 });
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
  });
});
