import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { questionBundle, termBundle } from '@/tests/fixtures/content';
import {
  catalogPageSchema,
  linkedTermsSchema,
  termDefinitionSchema,
} from '@/lib/contracts/content';
import { cookieHeader, installBundles, sql, testUser } from './helpers';

describe('safe vocabulary disclosure', () => {
  it('freezes exact links, commits irreversible assistance before returning text, and never awards mastery', async () => {
    const safe = termBundle('neutral-token'),
      spoiler = termBundle('private-solution-context');
    const question = questionBundle(
      'vocabulary-question',
      {
        terms: [
          { termId: safe.id, required: true, exposure: 'pre_attempt_safe' },
          { termId: spoiler.id, required: false, exposure: 'post_grade_only' },
        ],
      },
      {
        dependencies: [safe, spoiler].map((t) => ({
          id: t.id,
          digest: t.digest,
        })),
      },
    );
    installBundles([safe, spoiler, question]);
    const owner = await testUser(),
      outsider = await testUser();
    const started = await owner.db.rpc('start_study', {
      p_question: question.id,
      p_timezone: 'UTC',
    });
    expect(started.error).toBeNull();
    const item = started.data!;
    const exposureKey = randomUUID();
    const exposure = await owner.db.rpc('record_vocabulary_exposure', {
      p_term: safe.id,
      p_key: exposureKey,
    });
    expect(exposure.error).toBeNull();
    expect(
      (
        await owner.db.rpc('record_vocabulary_exposure', {
          p_term: safe.id,
          p_key: exposureKey,
        })
      ).data,
    ).toBe(exposure.data);
    expect(
      (
        await owner.db
          .from('session_items')
          .select('assisted')
          .eq('id', item)
          .single()
      ).data?.assisted,
    ).toBe(false);
    const device = randomUUID();
    expect(
      (
        await owner.db.rpc('checkpoint', {
          p_item: item,
          p_version: 0,
          p_answer: 'Preserved local reasoning',
          p_confidence: 'certain',
          p_assisted: false,
          p_device: device,
          p_action: 'claim',
        })
      ).error,
    ).toBeNull();
    const links = await owner.db.rpc('item_vocabulary', { p_item: item });
    expect(linkedTermsSchema.parse(links.data)).toEqual([
      { id: safe.id, title: safe.payload.title },
    ]);
    expect(JSON.stringify(links.data)).not.toContain('definition');
    expect(
      (await outsider.db.rpc('item_vocabulary', { p_item: item })).error
        ?.message,
    ).toBe('FORBIDDEN');
    expect(
      (await owner.db.from('question_terms').select()).data?.some(
        (l) => l.term_version_id === spoiler.id,
      ),
    ).toBe(false);
    const key = randomUUID(),
      input = { p_item: item, p_term: safe.id, p_key: key };
    expect(
      (await outsider.db.rpc('lookup_vocabulary', input)).error?.message,
    ).toBe('FORBIDDEN');
    expect(
      (
        await owner.db.rpc('lookup_vocabulary', {
          ...input,
          p_term: spoiler.id,
        })
      ).error?.message,
    ).toBe('FORBIDDEN');
    const lookup = await Promise.all([
      owner.db.rpc('lookup_vocabulary', input),
      owner.db.rpc('lookup_vocabulary', input),
    ]);
    expect(lookup.every((r) => r.error === null)).toBe(true);
    expect(termDefinitionSchema.parse(lookup[0].data).definition).toBe(
      safe.payload.definition,
    );
    expect(
      (await owner.db.from('vocabulary_events').select().eq('kind', 'lookup'))
        .data,
    ).toHaveLength(1);
    expect((await outsider.db.from('vocabulary_events').select()).data).toEqual(
      [],
    );
    expect(
      (
        await owner.db.rpc('lookup_vocabulary', {
          ...input,
          p_term: spoiler.id,
        })
      ).error?.message,
    ).toBe('IDEMPOTENCY_CONFLICT');
    let saved = (
      await owner.db.from('session_items').select().eq('id', item).single()
    ).data!;
    expect(saved).toMatchObject({
      assisted: true,
      version: 2,
      answer_text: 'Preserved local reasoning',
      confidence: 'certain',
    });
    expect(
      (
        await owner.db.rpc('checkpoint', {
          p_item: item,
          p_version: 1,
          p_answer: 'Stale copy',
          p_confidence: 'unsure',
          p_assisted: false,
          p_device: device,
          p_action: 'save',
        })
      ).error?.message,
    ).toBe('SYNC_CONFLICT');
    expect(
      (
        await owner.db.rpc('checkpoint', {
          p_item: item,
          p_version: 2,
          p_answer: saved.answer_text,
          p_confidence: saved.confidence,
          p_assisted: false,
          p_device: device,
          p_action: 'pause',
        })
      ).error,
    ).toBeNull();
    saved = (
      await owner.db.from('session_items').select().eq('id', item).single()
    ).data!;
    expect(saved.assisted).toBe(true);
    expect((await owner.db.from('review_episodes').select()).data).toEqual([]);
    expect((await owner.db.from('attempts').select()).data).toEqual([]);
    expect((await owner.db.from('attempt_grades').select()).data).toEqual([]);
    const submitted = await owner.db.rpc('submit_answer', {
      p_item: item,
      p_version: 2,
      p_question: question.id,
      p_answer: saved.answer_text,
      p_confidence: 'certain',
      p_assisted: false,
      p_device: device,
      p_key: randomUUID(),
    });
    expect(submitted.error).toBeNull();
    expect(
      (await owner.db.from('attempts').select('assisted').single()).data
        ?.assisted,
    ).toBe(true);
    const catalog = catalogPageSchema.parse(
      (await owner.db.rpc('content_catalog', { p_kind: 'term' })).data,
    );
    expect(catalog.entries.some((entry) => entry.id === safe.id)).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain('definition');
    expect(() =>
      sql(
        `update public.question_terms set exposure='pre_attempt_safe' where term_version_id='${spoiler.id}'`,
      ),
    ).toThrow(/IMMUTABLE_HISTORY/);
    expect(() =>
      sql(`set role content_publisher; select * from public.vocabulary_events`),
    ).toThrow();
    sql(
      `update public.grading_jobs set state='failed' where user_id='${owner.id}'`,
    );
  });
  it('requires owned same-origin HTTP lookup and hides definitions on generic reads', async () => {
    const term = termBundle('http-token');
    const question = questionBundle(
      'http-vocabulary',
      {
        terms: [
          { termId: term.id, required: true, exposure: 'pre_attempt_safe' },
        ],
      },
      { dependencies: [{ id: term.id, digest: term.digest }] },
    );
    installBundles([term, question]);
    const owner = await testUser(),
      outsider = await testUser();
    const start = await owner.db.rpc('start_study', {
      p_question: question.id,
      p_timezone: 'UTC',
    });
    const origin = process.env.TEST_APP_URL!;
    const input = { itemId: start.data, termId: term.id, key: randomUUID() };
    const request = (cookie: string, extra = {}, from = origin) =>
      fetch(`${origin}/api/content/vocabulary`, {
        method: 'POST',
        headers: { origin: from, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, ...extra }),
      });
    const ownerCookie = await cookieHeader(owner.db),
      otherCookie = await cookieHeader(outsider.db);
    expect((await request(otherCookie)).status).toBe(403);
    expect(
      (await request(ownerCookie, {}, 'https://other.example.test')).status,
    ).toBe(403);
    expect(
      (await request(ownerCookie, { assisted: false, approved: true })).status,
    ).toBe(400);
    const result = await request(ownerCookie);
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toContain('no-store');
    expect(termDefinitionSchema.parse(await result.json()).id).toBe(term.id);
    expect(() =>
      sql(
        'set role authenticated; select * from private.vocabulary_definitions;',
      ),
    ).toThrow();
    expect(
      (
        await owner.db.from('vocabulary_events').insert({
          user_id: owner.id,
          item_id: start.data!,
          term_version_id: term.id,
          kind: 'lookup',
          idempotency_key: randomUUID(),
        })
      ).error,
    ).not.toBeNull();
  });
});
