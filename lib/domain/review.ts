export type ReviewEvent = {
  id: string;
  submittedAt: number;
  outcome: 'passed' | 'failed' | 'unscored';
  assisted: boolean;
  source: 'first' | 'review';
  jitter: number;
};
export type ReviewEpisode = {
  id: string;
  firstMissedAt: number;
  streak: number;
  graduatedAt: number | null;
  nextDueAt: number | null;
};
const dayMs = 86400000;

export function replayReview(events: readonly ReviewEvent[]): ReviewEpisode[] {
  const episodes: ReviewEpisode[] = [];
  const ordered = [...events].sort(
    (a, b) => a.submittedAt - b.submittedAt || a.id.localeCompare(b.id),
  );
  for (const event of ordered) {
    if (event.outcome === 'unscored') continue;
    let episode = episodes.at(-1);
    if (event.outcome === 'failed') {
      if (!episode || episode.graduatedAt !== null) {
        episode = {
          id: event.id,
          firstMissedAt: event.submittedAt,
          streak: 0,
          graduatedAt: null,
          nextDueAt: null,
        };
        episodes.push(episode);
      }
      episode.streak = 0;
    } else if (
      episode &&
      episode.graduatedAt === null &&
      !event.assisted &&
      event.source === 'review'
    ) {
      episode.streak += 1;
      if (
        episode.streak >= 10 &&
        event.submittedAt - episode.firstMissedAt >= 30 * dayMs
      )
        episode.graduatedAt = event.submittedAt;
    }
    if (episode) {
      episode.nextDueAt =
        episode.graduatedAt === null
          ? event.submittedAt +
            Math.min(30, 2 ** Math.min(episode.streak, 5)) *
              dayMs *
              (0.9 + event.jitter * 0.2)
          : null;
    }
  }
  return episodes;
}

export type EvidenceEvent = {
  track: 'concept' | 'vocabulary';
  source: 'first' | 'review';
  assisted: boolean;
  passed: boolean | null;
  simulated: boolean;
};

export function evidenceCounts(events: readonly EvidenceEvent[]) {
  const counts = {
    first: { scored: 0, passed: 0 },
    review: { scored: 0, passed: 0 },
    vocabulary: { scored: 0, passed: 0 },
  };
  for (const event of events) {
    if (event.passed === null || event.simulated) continue;
    if (event.track === 'concept' && event.source === 'first' && event.assisted)
      continue;
    const group =
      event.track === 'vocabulary' ? counts.vocabulary : counts[event.source];
    group.scored++;
    if (event.passed) group.passed++;
  }
  return counts;
}
