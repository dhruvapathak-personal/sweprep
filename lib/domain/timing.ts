export function formatActiveTime(ms: number) {
  return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
}

export type AcknowledgedSegment = { startedAt: number; endedAt: number };

export function activeMsOnLocalDay(
  segments: readonly AcknowledgedSegment[],
  date: string,
  timezone: string,
) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const localDate = (instant: number) => {
    const parts = formatter.formatToParts(instant);
    return ['year', 'month', 'day']
      .map((part) => parts.find((entry) => entry.type === part)?.value)
      .join('-');
  };
  return segments.reduce((sum, segment) => {
    if (
      segment.endedAt < segment.startedAt ||
      segment.endedAt - segment.startedAt > 30000
    )
      throw new Error('Invalid acknowledged segment');
    if (segment.endedAt === segment.startedAt) return sum;
    const startDate = localDate(segment.startedAt);
    const endDate = localDate(segment.endedAt - 1);
    if (startDate === endDate)
      return (
        sum + (startDate === date ? segment.endedAt - segment.startedAt : 0)
      );
    let low = segment.startedAt;
    let high = segment.endedAt;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (localDate(middle) === startDate) low = middle;
      else high = middle;
    }
    return (
      sum +
      (startDate === date
        ? high - segment.startedAt
        : endDate === date
          ? segment.endedAt - high
          : 0)
    );
  }, 0);
}
