import { describe, expect, it } from 'vitest';
import {
  replayReview,
  evidenceCounts,
  type ReviewEvent,
} from '@/lib/domain/review';
import { activeMsOnLocalDay } from '@/lib/domain/timing';

const day = 86400000;
const event = (
  id: number,
  days: number,
  outcome: ReviewEvent['outcome'] = 'passed',
  assisted = false,
): ReviewEvent => ({
  id: String(id).padStart(4, '0'),
  submittedAt: days * day,
  outcome,
  assisted,
  source: id === 0 ? 'first' : 'review',
  jitter: 0.5,
});
const history = (finalDay: number, correctCount = 10) => [
  event(0, 0, 'failed'),
  ...Array.from({ length: correctCount }, (_, i) =>
    event(i + 1, i === correctCount - 1 ? finalDay : i + 1),
  ),
];

describe('deterministic review replay', () => {
  it.each([
    [29, 10, false],
    [30, 9, false],
    [30, 10, true],
  ])(
    'requires both elapsed days %i and streak %i',
    (days, streak, graduated) => {
      expect(replayReview(history(days, streak))[0].graduatedAt !== null).toBe(
        graduated,
      );
    },
  );
  it('keeps assisted and unscored outcomes neutral and resets on a scored failure', () => {
    const events = [
      event(0, 0, 'failed'),
      event(1, 1),
      event(2, 2, 'passed', true),
      event(3, 3, 'unscored'),
    ];
    expect(replayReview(events)[0].streak).toBe(1);
    expect(replayReview([...events, event(4, 4, 'failed')])[0].streak).toBe(0);
  });
  it('starts a fresh elapsed-day episode after relapse and preserves the graduated episode', () => {
    const result = replayReview([
      ...history(30),
      event(11, 31, 'failed'),
      ...Array.from({ length: 10 }, (_, i) => event(12 + i, 32 + i)),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].graduatedAt).toBe(30 * day);
    expect(result[1]).toMatchObject({
      firstMissedAt: 31 * day,
      streak: 10,
      graduatedAt: null,
    });
  });
  it('replays corrected effective history in submission order with stable due dates', () => {
    const wrong = [event(0, 0, 'failed'), event(1, 5), event(2, 10, 'failed')];
    const corrected = wrong.map((value) =>
      value.id === '0002' ? { ...value, outcome: 'passed' as const } : value,
    );
    expect(replayReview(wrong)[0].streak).toBe(0);
    expect(replayReview(corrected)[0].streak).toBe(2);
    expect(replayReview([...corrected].reverse())).toEqual(
      replayReview(corrected),
    );
    expect(replayReview(corrected)[0].nextDueAt).toBe(14 * day);
  });
});

it('separates concept first attempts, review and vocabulary and excludes unscored/simulated evidence', () => {
  expect(
    evidenceCounts([
      {
        track: 'concept',
        source: 'first',
        assisted: false,
        passed: true,
        simulated: false,
      },
      {
        track: 'concept',
        source: 'first',
        assisted: true,
        passed: false,
        simulated: false,
      },
      {
        track: 'concept',
        source: 'review',
        assisted: false,
        passed: false,
        simulated: false,
      },
      {
        track: 'vocabulary',
        source: 'review',
        assisted: false,
        passed: true,
        simulated: false,
      },
      {
        track: 'concept',
        source: 'first',
        assisted: false,
        passed: null,
        simulated: false,
      },
      {
        track: 'concept',
        source: 'first',
        assisted: false,
        passed: true,
        simulated: true,
      },
    ]),
  ).toEqual({
    first: { scored: 1, passed: 1 },
    review: { scored: 1, passed: 0 },
    vocabulary: { scored: 1, passed: 1 },
  });
});

it('splits acknowledged time at local midnight and rebuckets without changing UTC events', () => {
  const segments = [
    {
      startedAt: Date.parse('2026-10-25T03:59:50Z'),
      endedAt: Date.parse('2026-10-25T04:00:10Z'),
    },
  ];
  expect(activeMsOnLocalDay(segments, '2026-10-24', 'America/New_York')).toBe(
    10000,
  );
  expect(activeMsOnLocalDay(segments, '2026-10-25', 'America/New_York')).toBe(
    10000,
  );
  expect(activeMsOnLocalDay(segments, '2026-10-25', 'UTC')).toBe(20000);
});

it('counts both repeated daylight-saving hours and excludes gaps representing pause/offline time', () => {
  const segments = [
    {
      startedAt: Date.parse('2026-11-01T05:30:00Z'),
      endedAt: Date.parse('2026-11-01T05:30:10Z'),
    },
    {
      startedAt: Date.parse('2026-11-01T06:30:00Z'),
      endedAt: Date.parse('2026-11-01T06:30:10Z'),
    },
  ];
  expect(activeMsOnLocalDay(segments, '2026-11-01', 'America/New_York')).toBe(
    20000,
  );
});
