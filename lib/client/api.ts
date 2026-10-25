import { z } from 'zod';
import { stateSchema, type StudyAction } from '@/lib/contracts/study';

export async function readState() {
  const response = await fetch('/api/study', { cache: 'no-store' });
  if (response.status === 401) return null;
  if (!response.ok)
    throw new Error(
      'The study service is unavailable. Your local draft is not deleted.',
    );
  return stateSchema.parse(await response.json());
}

export async function changeState(action: StudyAction) {
  const response = await fetch('/api/study', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action),
  });
  const raw: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(raw);
    throw new Error(error.success ? error.data.error : 'UNAVAILABLE');
  }
  return z.object({ state: stateSchema, result: z.unknown() }).parse(raw);
}
