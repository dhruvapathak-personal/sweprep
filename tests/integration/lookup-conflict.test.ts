// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { createElement } from 'react';
import { randomUUID } from 'node:crypto';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AnswerEditor } from '@/components/answer-editor';
import { changeState, readState } from '@/lib/client/api';
import { clearDrafts, readDraft } from '@/lib/client/drafts';
import type { StudyAction } from '@/lib/contracts/study';
import { questionBundle, termBundle } from '@/tests/fixtures/content';
import { cookieHeader, installBundles, testUser } from './helpers';

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await clearDrafts();
});

it('preserves another device save during lookup until the user chooses a draft', async () => {
  const term = termBundle('concurrent-lookup-token');
  const question = questionBundle(
    'concurrent-lookup-question',
    {
      terms: [
        { termId: term.id, required: true, exposure: 'pre_attempt_safe' },
      ],
    },
    { dependencies: [{ id: term.id, digest: term.digest }] },
  );
  installBundles([term, question]);
  const owner = await testUser();
  const started = await owner.db.rpc('start_study', {
    p_question: question.id,
    p_timezone: 'UTC',
  });
  expect(started.error).toBeNull();
  const itemId = started.data!;
  const deviceA = randomUUID(),
    deviceB = randomUUID();
  const paused = await owner.db.rpc('checkpoint', {
    p_item: itemId,
    p_version: 0,
    p_answer: 'Reasoning on device A',
    p_confidence: 'unsure',
    p_assisted: false,
    p_device: deviceA,
    p_action: 'pause',
  });
  expect(paused.error).toBeNull();
  expect(paused.data).toMatchObject({
    paused: true,
    lease_device: null,
    version: 1,
  });
  const origin = process.env.TEST_APP_URL!;
  const cookie = await cookieHeader(owner.db);
  const transport = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (typeof input !== 'string' || !input.startsWith('/'))
      return transport(input, init);
    if (input === '/api/content/vocabulary' && init?.method === 'POST') {
      const competing = await owner.db.rpc('checkpoint', {
        p_item: itemId,
        p_version: 1,
        p_answer: 'New reasoning saved by device B',
        p_confidence: 'certain',
        p_assisted: false,
        p_device: deviceB,
        p_action: 'save',
      });
      expect(competing.error).toBeNull();
      expect(competing.data?.version).toBe(2);
    }
    return transport(`${origin}${input}`, {
      ...init,
      headers: { ...init?.headers, cookie, origin },
    });
  });
  const initial = await readState();
  if (!initial) throw new Error('Synthetic session unavailable');
  const change = vi.fn(
    async (action: StudyAction) => (await changeState(action)).state,
  );
  render(
    createElement(AnswerEditor, {
      item: initial.items[0],
      state: initial,
      deviceId: deviceA,
      change,
      updated: () => {},
      leave: () => {},
    }),
  );
  await screen.findByDisplayValue('Reasoning on device A');
  fireEvent.click(
    await screen.findByRole('button', {
      name: `Look up ${term.payload.title}`,
    }),
  );
  await screen.findByText('Choose a draft to preserve');
  await screen.findByText(term.payload.definition);
  expect((await readDraft(owner.id, itemId, deviceA))?.baseVersion).toBe(1);
  expect((await readDraft(owner.id, itemId, deviceA))?.assisted).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save to cloud' }));
  expect(change).toHaveBeenCalledTimes(1);
  const remote = (
    await owner.db.from('session_items').select().eq('id', itemId).single()
  ).data;
  expect(remote).toMatchObject({
    version: 3,
    answer_text: 'New reasoning saved by device B',
    confidence: 'certain',
    assisted: true,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Use cloud copy' }));
  await waitFor(() =>
    expect(screen.queryByText('Choose a draft to preserve')).toBeNull(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save to cloud' }));
  await screen.findByText('Saved to cloud');
  expect(change.mock.calls[1][0]).toMatchObject({
    version: 3,
    answer: 'New reasoning saved by device B',
    confidence: 'certain',
    assisted: true,
  });
  expect(
    (await owner.db.from('session_items').select().eq('id', itemId).single())
      .data,
  ).toMatchObject({
    answer_text: 'New reasoning saved by device B',
    assisted: true,
  });
});
