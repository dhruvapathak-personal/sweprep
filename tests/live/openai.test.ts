import { beforeAll, describe, expect, it } from 'vitest';
import {
  requestGrade,
  requestReservationCents,
  workSchema,
} from '@/lib/server/ai/grader';

beforeAll(() => {
  if (process.env.RUN_LIVE_SERVICE_TESTS !== 'true')
    throw new Error(
      'Set RUN_LIVE_SERVICE_TESTS=true to run live service tests.',
    );
});

describe('live OpenAI Responses API', () => {
  it('grades synthetic, non-sensitive content using the configured live model', async () => {
    const work = workSchema.parse({
      job: {
        attempt_id: '20000000-0000-4000-8000-000000000001',
        generation: 1,
        lease_token: '20000000-0000-4000-8000-000000000002',
        request_count: 0,
        repair_used: false,
      },
      attempt: { answer_text: '4', confidence: 'certain' },
      question: {
        id: '10000000-0000-4000-8000-000000000001',
        question_id: 'live-api-smoke-test',
        version: 1,
        title: 'Simple arithmetic',
        skill: 'arithmetic',
        content_blocks: [{ type: 'text', text: 'What is 2 + 2?' }],
        content_review: 'approved',
      },
      rubric: {
        version: 'live-api-smoke-v1',
        pass_score: 3,
        required_claims: ['States that 2 + 2 equals 4.'],
        reference_answer: '2 + 2 equals 4.',
      },
    });

    const result = await requestGrade(work, false);
    expect(result.result?.outcome).toBe('scored');
    if (result.result?.outcome === 'scored') {
      expect(result.result.criticalClaimsMet).toBe(true);
      expect(result.result.score).toBeGreaterThanOrEqual(3);
    }
    expect(result.actualCents).toBeDefined();
    expect(result.actualCents).toBeLessThanOrEqual(requestReservationCents);
    expect(result.metadata.inputTokens).toBeGreaterThan(0);
    expect(result.metadata.outputTokens).toBeGreaterThan(0);
  });
});
