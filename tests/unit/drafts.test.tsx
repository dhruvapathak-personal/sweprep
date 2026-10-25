// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AnswerEditor } from '@/components/answer-editor';
import { Trainer } from '@/components/trainer';
import { readState } from '@/lib/client/api';
import {
  clearDrafts,
  readDraft,
  writeDraft,
  type DraftSnapshot,
} from '@/lib/client/drafts';
import {
  stateSchema,
  type StudyAction,
  type StudyState,
} from '@/lib/contracts/study';

const userId = '30000000-0000-4000-8000-000000000001';
const itemId = '30000000-0000-4000-8000-000000000002';
const questionId = '10000000-0000-4000-8000-000000000001';
const writerId = '30000000-0000-4000-8000-000000000003';
const otherWriter = '30000000-0000-4000-8000-000000000004';
vi.mock('@/lib/client/api', () => ({ readState: vi.fn() }));
const state = () =>
  stateSchema.parse({
    userId,
    email: 'synthetic@example.test',
    timezone: 'UTC',
    gradingMode: 'simulated',
    serverNow: '2026-10-25T00:00:00Z',
    todayMs: 0,
    questions: [],
    attempts: [],
    jobs: [],
    grades: [],
    selections: [],
    items: [
      {
        id: itemId,
        question_version_id: questionId,
        version: 2,
        answer_text: 'Cloud answer',
        confidence: 'unsure',
        assisted: false,
        state: 'answering',
        source: 'first',
        displayed_at: '2026-10-25T00:00:00Z',
        saved_at: '2026-10-25T00:00:00Z',
        lease_device: otherWriter,
        lease_until: '2026-10-25T00:00:30Z',
        last_ack_at: '2026-10-25T00:00:00Z',
        paused: false,
        active_ms: 0,
      },
    ],
  });
const snapshot = (answer: string, writer = writerId): DraftSnapshot => ({
  userId,
  itemId,
  questionId,
  writerId: writer,
  baseVersion: 1,
  answer,
  confidence: 'unsure',
  assisted: false,
  updatedAt: new Date().toISOString(),
  submission: null,
  timingDisconnected: false,
});

it('discards prior-account poll results after logout and after another account loads', async () => {
  const original = {
    ...state(),
    items: [],
    email: 'prior-account@example.test',
  };
  original.jobs = [
    {
      attempt_id: itemId,
      state: 'pending',
      generation: 1,
      error_code: null,
      request_count: 0,
    },
  ];
  const next = {
    ...state(),
    items: [],
    jobs: [],
    userId: otherWriter,
    email: 'next-account@example.test',
  };
  let finishAfterLogout: (value: StudyState) => void = () => {};
  let finishAfterLogin: (value: StudyState) => void = () => {};
  vi.mocked(readState)
    .mockReset()
    .mockResolvedValueOnce(original)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishAfterLogout = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishAfterLogin = resolve;
        }),
    )
    .mockResolvedValue(next);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ signedOut: true }),
  );
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  render(<Trainer />);
  await screen.findByText('prior-account@example.test');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(readState).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByRole('heading', { name: 'Sign in with email' });
  await act(async () => {
    finishAfterLogout(original);
  });
  expect(screen.queryByText('prior-account@example.test')).toBeNull();
  expect(localStorage.getItem('sweprep-account')).toBeNull();
  act(() => {
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'sweprep-account',
        newValue: next.userId,
      }),
    );
  });
  await screen.findByText('next-account@example.test');
  await act(async () => {
    finishAfterLogin(original);
  });
  expect(screen.queryByText('prior-account@example.test')).toBeNull();
  expect(screen.queryByText('next-account@example.test')).not.toBeNull();
  expect(localStorage.getItem('sweprep-account')).toBe(next.userId);
});
const renderEditor = (
  initial: StudyState,
  change: (action: StudyAction) => Promise<StudyState>,
) =>
  render(
    <AnswerEditor
      item={initial.items[0]}
      state={initial}
      deviceId={writerId}
      change={change}
      updated={() => {}}
      leave={() => {}}
    />,
  );

beforeEach(async () => {
  await clearDrafts();
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('preserves two tab snapshots and never restores another account', async () => {
  await writeDraft(snapshot('Tab A text'));
  await writeDraft(snapshot('Tab B text', otherWriter));
  expect((await readDraft(userId, itemId, writerId))?.answer).toBe(
    'Tab A text',
  );
  expect((await readDraft(userId, itemId, otherWriter))?.answer).toBe(
    'Tab B text',
  );
  expect(
    await readDraft('30000000-0000-4000-8000-000000000009', itemId, writerId),
  ).toBeNull();
});

it('forks duplicated documents into separate offline snapshots and restores each original snapshot on reload', async () => {
  const initial = state();
  initial.questions = [
    {
      id: questionId,
      question_id: 'lifetime',
      version: 1,
      title: 'Object lifetime',
      skill: 'C++',
      content_blocks: [{ type: 'text', text: 'Explain ownership.' }],
      content_review: 'candidate',
    },
  ];
  vi.mocked(readState).mockResolvedValue(initial);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const first = render(<Trainer />);
  const firstAnswer = await within(first.container).findByRole('textbox', {
    name: 'Your answer',
  });
  const firstWriter = sessionStorage.getItem('sweprep-tab') ?? '';
  fireEvent.change(firstAnswer, {
    target: { value: 'Original tab offline answer' },
  });
  await waitFor(async () =>
    expect((await readDraft(userId, itemId, firstWriter))?.answer).toBe(
      'Original tab offline answer',
    ),
  );
  const duplicate = render(<Trainer />);
  const duplicateAnswer = await within(duplicate.container).findByRole(
    'textbox',
  );
  const duplicateWriter = sessionStorage.getItem('sweprep-tab') ?? '';
  expect(duplicateWriter).not.toBe(firstWriter);
  fireEvent.change(duplicateAnswer, {
    target: { value: 'Duplicate tab offline answer' },
  });
  await waitFor(async () =>
    expect((await readDraft(userId, itemId, duplicateWriter))?.answer).toBe(
      'Duplicate tab offline answer',
    ),
  );
  expect((await readDraft(userId, itemId, firstWriter))?.answer).toBe(
    'Original tab offline answer',
  );
  first.unmount();
  duplicate.unmount();

  sessionStorage.setItem('sweprep-tab', firstWriter);
  const reloaded = render(<Trainer />);
  await waitFor(() =>
    expect(
      (
        within(reloaded.container).getByRole('textbox', {
          name: 'Your answer',
        }) as HTMLTextAreaElement
      ).value,
    ).toBe('Original tab offline answer'),
  );
  const reloadedWriter = sessionStorage.getItem('sweprep-tab') ?? '';
  expect(reloadedWriter).not.toBe(firstWriter);
  await waitFor(async () =>
    expect((await readDraft(userId, itemId, reloadedWriter))?.answer).toBe(
      'Original tab offline answer',
    ),
  );
  reloaded.unmount();

  const reloadedAgain = render(<Trainer />);
  await waitFor(() =>
    expect(
      (
        within(reloadedAgain.container).getByRole('textbox', {
          name: 'Your answer',
        }) as HTMLTextAreaElement
      ).value,
    ).toBe('Original tab offline answer'),
  );
  reloadedAgain.unmount();
  sessionStorage.setItem('sweprep-tab', duplicateWriter);
  const duplicateReloaded = render(<Trainer />);
  await waitFor(() =>
    expect(
      (
        within(duplicateReloaded.container).getByRole('textbox', {
          name: 'Your answer',
        }) as HTMLTextAreaElement
      ).value,
    ).toBe('Duplicate tab offline answer'),
  );
});

it('adopts matching cloud data on a timer-owner rejection without forcing a draft choice', async () => {
  const initial = state();
  vi.mocked(readState).mockResolvedValue(initial);
  const change = vi.fn().mockRejectedValue(new Error('TIMER_OWNED'));
  renderEditor(initial, change);
  await screen.findByRole('textbox', { name: 'Your answer' });
  fireEvent.click(screen.getByRole('button', { name: 'Save to cloud' }));
  await screen.findByText(
    'Saved to cloud. Another tab or device owns the timer; take over explicitly to continue timing.',
  );
  expect(screen.queryByText('Choose a draft to preserve')).toBeNull();
  expect(
    (
      screen.getByRole('button', {
        name: 'Take over timer',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

it('keeps offline text and sends the explicit takeover instead of the stale disconnect action', async () => {
  await writeDraft({
    ...snapshot('Offline text to preserve'),
    timingDisconnected: true,
  });
  const initial = state();
  const change = vi.fn(async (action: StudyAction) => ({
    ...initial,
    items: [
      {
        ...initial.items[0],
        answer_text: action.action === 'checkpoint' ? action.answer : '',
        lease_device: writerId,
        version: 3,
      },
    ],
  }));
  renderEditor(initial, change);
  await screen.findByText('Choose a draft to preserve');
  fireEvent.click(
    screen.getByRole('button', { name: 'Keep this device copy & take over' }),
  );
  await waitFor(() => expect(change).toHaveBeenCalledTimes(1));
  expect(change.mock.calls[0][0]).toMatchObject({
    action: 'checkpoint',
    timingAction: 'takeover',
    answer: 'Offline text to preserve',
    version: 2,
  });
  await screen.findByText('Saved to cloud');
  expect(
    (
      screen.getByRole('textbox', {
        name: 'Your answer',
      }) as HTMLTextAreaElement
    ).value,
  ).toBe('Offline text to preserve');
});

it('does not replace newer typing when an earlier cloud save finishes', async () => {
  const initial = state();
  initial.items[0].paused = true;
  initial.items[0].lease_device = writerId;
  let complete: (value: StudyState) => void = () => {};
  const change = vi.fn(
    () =>
      new Promise<StudyState>((resolve) => {
        complete = resolve;
      }),
  );
  renderEditor(initial, change);
  const input = await screen.findByRole('textbox', { name: 'Your answer' });
  fireEvent.change(input, { target: { value: 'First edit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save to cloud' }));
  fireEvent.change(input, { target: { value: 'Newer typing while saving' } });
  await act(async () => {
    complete({
      ...initial,
      items: [{ ...initial.items[0], answer_text: 'First edit', version: 3 }],
    });
  });
  await waitFor(async () =>
    expect((await readDraft(userId, itemId, writerId))?.baseVersion).toBe(3),
  );
  expect((input as HTMLTextAreaElement).value).toBe(
    'Newer typing while saving',
  );
  expect((await readDraft(userId, itemId, writerId))?.answer).toBe(
    'Newer typing while saving',
  );
  expect(screen.queryByText('Choose a draft to preserve')).toBeNull();
});

it('keeps cloud save available when IndexedDB is unavailable', async () => {
  vi.stubGlobal('indexedDB', {
    open: () => {
      throw new Error('Storage denied');
    },
  });
  const initial = state();
  const change = vi.fn(async () => initial);
  renderEditor(initial, change);
  await screen.findByText(
    'Local recovery storage is unavailable. If a cloud save also fails, your answer exists only in this open tab.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save to cloud' }));
  await waitFor(() => expect(change).toHaveBeenCalledTimes(1));
  await screen.findByText('Saved to cloud');
});

it('freezes and retries the exact payload after an uncertain submission acknowledgment', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const initial = state();
  const change = vi
    .fn<(action: StudyAction) => Promise<StudyState>>()
    .mockRejectedValueOnce(new Error('UNAVAILABLE'))
    .mockResolvedValueOnce(initial);
  renderEditor(initial, change);
  await screen.findByRole('textbox', { name: 'Your answer' });
  fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }));
  await screen.findByText(
    'Submission is not confirmed. Retry the exact same submission; do not create a new answer.',
  );
  expect(
    (
      screen.getByRole('textbox', {
        name: 'Your answer',
      }) as HTMLTextAreaElement
    ).disabled,
  ).toBe(true);
  const persisted = await readDraft(userId, itemId, writerId);
  expect(persisted?.submission).toEqual(change.mock.calls[0][0]);
  fireEvent.click(
    screen.getByRole('button', { name: 'Retry exact submission' }),
  );
  await waitFor(() => expect(change).toHaveBeenCalledTimes(2));
  expect(change.mock.calls[1][0]).toEqual(change.mock.calls[0][0]);
});
