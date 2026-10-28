import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { questionBundle } from '@/tests/fixtures/content';
import { catalogPageSchema } from '@/lib/contracts/content';
import { stateSchema } from '@/lib/contracts/study';
import {
  client,
  cookieHeader,
  importBundles,
  installBundles,
  sql,
  testUser,
} from './helpers';

const bank = Array.from({ length: 151 }, (_, index) =>
  questionBundle(`catalog-${String(index).padStart(3, '0')}`, {
    domain: index % 2 ? 'python' : 'cpp',
    category: index % 2 ? 'Predict' : 'Explain',
  }),
);
let owner: Awaited<ReturnType<typeof testUser>>;
let outsider: Awaited<ReturnType<typeof testUser>>;
beforeAll(async () => {
  owner = await testUser();
  outsider = await testUser();
  for (let index = 0; index < bank.length; index += 10)
    installBundles(bank.slice(index, index + 10));
}, 30000);

describe('qualified current catalog and separately pinned history', () => {
  it('reaches more than 150 identities through bounded stable pages with no candidates or private data', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await owner.db.rpc('content_catalog', {
        p_kind: 'question',
        p_cursor: cursor,
      });
      expect(result.error).toBeNull();
      const page = catalogPageSchema.parse(result.data);
      expect(page.entries.length).toBeLessThanOrEqual(20);
      seen.push(...page.entries.map((row) => row.stableId));
      expect(JSON.stringify(result.data)).not.toMatch(
        /referenceAnswer|requiredClaims|fixtures|definition|sources/,
      );
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([...seen].sort());
    expect(seen.filter((id) => id.startsWith('catalog-'))).toHaveLength(151);
    const candidate = questionBundle('private-candidate');
    importBundles([candidate]);
    for (const db of [owner.db, outsider.db]) {
      expect(
        (await db.from('question_versions').select().eq('id', candidate.id))
          .data,
      ).toEqual([]);
      expect(
        (
          await db
            .from('question_versions')
            .select()
            .eq('id', '10000000-0000-4000-8000-000000000001')
        ).data,
      ).toEqual([]);
      expect(
        (
          await db.rpc('start_study', {
            p_question: '10000000-0000-4000-8000-000000000001',
            p_timezone: 'UTC',
          })
        ).error?.message,
      ).toBe('CONTENT_CHANGED');
    }
    expect(
      (await client().rpc('content_catalog', { p_kind: 'question' })).error,
    ).not.toBeNull();
    expect(
      (await client().from('question_versions').select()).error,
    ).not.toBeNull();
  });
  it('binds cursors to filters and revisions and enforces direct-RPC bounds', async () => {
    const first = catalogPageSchema.parse(
      (
        await owner.db.rpc('content_catalog', {
          p_kind: 'question',
          p_domain: 'cpp',
          p_category: 'Explain',
          p_limit: 50,
        })
      ).data,
    );
    expect(first.entries).toHaveLength(50);
    expect(
      first.entries.every(
        (r) => r.domain === 'cpp' && r.category === 'Explain',
      ),
    ).toBe(true);
    expect(
      (
        await owner.db.rpc('content_catalog', {
          p_kind: 'question',
          p_domain: 'python',
          p_cursor: first.nextCursor!,
        })
      ).error?.message,
    ).toBe('VALIDATION_ERROR');
    expect(
      (
        await owner.db.rpc('content_catalog', {
          p_kind: 'question',
          p_cursor: 'not-a-cursor',
        })
      ).error?.message,
    ).toBe('VALIDATION_ERROR');
    expect(
      (
        await owner.db.rpc('content_catalog', {
          p_kind: 'question',
          p_limit: 51,
        })
      ).error?.message,
    ).toBe('VALIDATION_ERROR');
    installBundles([questionBundle('revision-change')]);
    expect(
      (
        await owner.db.rpc('content_catalog', {
          p_kind: 'question',
          p_domain: 'cpp',
          p_category: 'Explain',
          p_limit: 50,
          p_cursor: first.nextCursor!,
        })
      ).error?.message,
    ).toBe('CATALOG_CHANGED');
    const empty = catalogPageSchema.parse(
      (
        await owner.db.rpc('content_catalog', {
          p_kind: 'question',
          p_domain: 'engineering',
          p_category: 'Critique',
        })
      ).data,
    );
    expect(empty.entries).toEqual([]);
  });
  it('retains exact owned attempts and drafts after supersession independently of any catalog page', async () => {
    const original = bank[150];
    const start = await owner.db.rpc('start_study', {
      p_question: original.id,
      p_timezone: 'UTC',
    });
    expect(start.error).toBeNull();
    const item = start.data!;
    const device = randomUUID();
    const checkpoint = await owner.db.rpc('checkpoint', {
      p_item: item,
      p_version: 0,
      p_answer: 'Saved synthetic draft.',
      p_confidence: 'certain',
      p_assisted: false,
      p_device: device,
      p_action: 'claim',
    });
    expect(checkpoint.error).toBeNull();
    const replacement = questionBundle(
      original.stableId,
      { title: 'Synthetic newer version' },
      { version: 2, parentId: original.id },
    );
    installBundles([replacement]);
    let state = stateSchema.parse({
      ...((await owner.db.rpc('study_state')).data as object),
      userId: owner.id,
      email: owner.email,
      gradingMode: 'simulated',
    });
    expect(state.pinnedQuestions.map((q) => q.id)).toContain(original.id);
    expect(state.pinnedQuestions.map((q) => q.id)).not.toContain(
      replacement.id,
    );
    expect(state.items[0]).toMatchObject({
      answer_text: 'Saved synthetic draft.',
      version: 1,
      assisted: false,
      question_version_id: original.id,
    });
    expect(
      (
        await outsider.db
          .from('question_versions')
          .select()
          .eq('id', original.id)
      ).data,
    ).toEqual([]);
    expect(
      (await owner.db.from('question_versions').select().eq('id', original.id))
        .data,
    ).toHaveLength(1);
    expect(
      (
        await outsider.db.rpc('start_study', {
          p_question: original.id,
          p_timezone: 'UTC',
        })
      ).error?.message,
    ).toBe('CONTENT_CHANGED');
    expect(
      (
        await owner.db.rpc('submit_answer', {
          p_item: item,
          p_version: 1,
          p_question: original.id,
          p_answer: 'Saved synthetic draft.',
          p_confidence: 'certain',
          p_assisted: false,
          p_device: device,
          p_key: randomUUID(),
        })
      ).error,
    ).toBeNull();
    state = stateSchema.parse({
      ...((await owner.db.rpc('study_state')).data as object),
      userId: owner.id,
      email: owner.email,
      gradingMode: 'simulated',
    });
    expect(state.attempts[0].question_version_id).toBe(original.id);
    expect(state.pinnedQuestions[0].title).toBe(original.payload.title);
    sql(
      `update public.grading_jobs set state='failed' where user_id='${owner.id}'`,
    );
  });
  it('authenticates HTTP catalogs, rejects forged filters and returns private no-store pages', async () => {
    const origin = process.env.TEST_APP_URL!;
    expect((await fetch(`${origin}/api/content/questions`)).status).toBe(401);
    expect((await fetch(`${origin}/api/content/terms`)).status).toBe(401);
    const headers = { cookie: await cookieHeader(owner.db) };
    const response = await fetch(
      `${origin}/api/content/questions?domain=python&category=Predict&limit=50`,
      { headers },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(
      catalogPageSchema
        .parse(await response.json())
        .entries.every((q) => q.domain === 'python'),
    ).toBe(true);
    for (const query of [
      'limit=51',
      'domain=cpp&domain=python',
      'approved=true',
      'cursor=invalid',
    ]) {
      expect(
        (await fetch(`${origin}/api/content/questions?${query}`, { headers }))
          .status,
      ).toBe(400);
    }
  });
});
