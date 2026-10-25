import { afterEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import content from '@/tests/fixtures/candidate-content.json';
import { gradeDetailsSchema, studyActionSchema } from '@/lib/contracts/study';
import { assertLiveGrading, gradingMode } from '@/lib/server/env';
import {
  providerFailure,
  requestGrade,
  workSchema,
} from '@/lib/server/ai/grader';
import { readJson, sameOrigin } from '@/lib/server/http';

const assessment = {
  outcome: 'scored',
  score: 3,
  criticalClaimsMet: true,
  correctClaims: ['The local object dies at return.'],
  missingClaims: [],
  incorrectClaims: [],
  idealAnswer: 'Return an owning string.',
  explanation: 'The view does not extend lifetime.',
};
const work = workSchema.parse({
  job: {
    attempt_id: '20000000-0000-4000-8000-000000000001',
    generation: 1,
    lease_token: '20000000-0000-4000-8000-000000000002',
    request_count: 0,
    repair_used: false,
  },
  attempt: { answer_text: 'Return an owning string.', confidence: 'certain' },
  question: {
    id: content.questions[0].id,
    question_id: content.questions[0].questionId,
    version: 1,
    title: content.questions[0].title,
    skill: content.questions[0].skill,
    content_blocks: content.questions[0].blocks,
    content_review: 'approved',
  },
  rubric: {
    version: 'rubric-v1',
    pass_score: 3,
    required_claims: content.questions[0].rubric.requiredClaims,
    reference_answer: content.questions[0].rubric.referenceAnswer,
  },
});

function environment(live = false) {
  const values = {
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'synthetic-key',
    APP_URL: 'http://localhost:3000',
    GRADING_MODE: live ? 'live' : 'disabled',
    CONTENT_REVIEW_APPROVED: 'true',
    MODEL_EVAL_APPROVED: 'true',
    PROVIDER_DATA_POLICY_APPROVED: 'true',
    DEPLOYMENT_RECOVERY_APPROVED: 'true',
    AI_DAILY_CAP_CENTS: '100',
    AI_MONTHLY_CAP_CENTS: '2000',
    OPENAI_MODEL: 'gpt-5.4-mini-2026-03-17',
    OPENAI_API_KEY: 'synthetic-test-key-not-a-credential',
  };
  Object.entries(values).forEach(([key, value]) => vi.stubEnv(key, value));
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('grading boundaries without paid calls', () => {
  it('keeps all five questions and 25 example assessments pending human review', () => {
    expect(content.reviewStatus).toBe('pending_human_review');
    expect(content.reviewer).toBeNull();
    expect(content.questions).toHaveLength(5);
    expect(content.questions.flatMap((value) => value.examples)).toHaveLength(
      25,
    );
    expect(
      content.questions.every((value) =>
        value.examples.some((example) => example.expected === 'uncertain'),
      ),
    ).toBe(true);
  });
  it('rejects out-of-range scores, raw HTML blocks, forged identity and unbounded request fields', () => {
    expect(
      gradeDetailsSchema.safeParse({ ...assessment, score: 6 }).success,
    ).toBe(false);
    expect(
      gradeDetailsSchema.safeParse({ ...assessment, score: 3.5 }).success,
    ).toBe(false);
    expect(
      studyActionSchema.safeParse({
        action: 'retry',
        attemptId: work.job.attempt_id,
        userId: work.job.attempt_id,
        score: 5,
      }).success,
    ).toBe(false);
    expect(
      workSchema.safeParse({
        ...work,
        question: {
          ...work.question,
          content_blocks: [{ type: 'html', text: '<script>bad()</script>' }],
        },
      }).success,
    ).toBe(false);
    expect(
      gradeDetailsSchema.safeParse({
        outcome: 'uncertain',
        reason: 'Cannot justify a score.',
      }).success,
    ).toBe(true);
  });
  it('never dispatches while disabled, lacking approvals, or using candidate content', async () => {
    environment();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(requestGrade(work, false)).rejects.toThrow(
      'LIVE_GRADING_DISABLED',
    );
    environment(true);
    vi.stubEnv('MODEL_EVAL_APPROVED', 'false');
    expect(() => assertLiveGrading()).toThrow('LIVE_GRADING_DISABLED');
    vi.stubEnv('MODEL_EVAL_APPROVED', 'true');
    await expect(
      requestGrade(
        {
          ...work,
          question: { ...work.question, content_review: 'candidate' },
        },
        false,
      ),
    ).rejects.toThrow('CONTENT_NOT_REVIEWED');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects hosted simulation and budgets above approved caps', () => {
    environment();
    vi.stubEnv('GRADING_MODE', 'simulated');
    vi.stubEnv('ALLOW_LOCAL_SIMULATION', 'true');
    expect(gradingMode()).toBe('simulated');
    vi.stubEnv('APP_URL', 'https://trainer.example.test');
    expect(() => gradingMode()).toThrow('SIMULATION_NOT_LOCAL');
    vi.stubEnv('AI_DAILY_CAP_CENTS', '101');
    expect(() => assertLiveGrading()).toThrow('SETUP_REQUIRED');
  });
  it('uses the real SDK with strict structured output, no storage/tools and one transport dispatch', async () => {
    environment(true);
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      expect(sent.store).toBe(false);
      expect(sent.tools).toBeUndefined();
      expect(sent.max_output_tokens).toBe(3000);
      expect(sent.text.format.strict).toBe(true);
      expect(sent.model).toBe('gpt-5.4-mini-2026-03-17');
      return Response.json({
        object: 'response',
        id: 'fixture-response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({ assessment }),
                annotations: [],
              },
            ],
          },
        ],
        usage: { input_tokens: 2000, output_tokens: 500 },
      });
    });
    vi.stubGlobal('fetch', transport);
    const result = await requestGrade(work, false);
    expect(result.result).toEqual(assessment);
    expect(result.actualCents).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('does not let SDK retries multiply transient errors and classifies timeout/rate limit delays', async () => {
    environment(true);
    const transport = vi.fn(async () =>
      Response.json({ error: { message: 'fixture failure' } }, { status: 500 }),
    );
    vi.stubGlobal('fetch', transport);
    await expect(requestGrade(work, false)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(providerFailure(new OpenAI.APIConnectionTimeoutError(), 0)).toEqual({
      code: 'PROVIDER_TIMEOUT',
      retrySeconds: 30,
    });
    const error = new OpenAI.RateLimitError(
      429,
      {},
      'fixture',
      new Headers({ 'retry-after': '180' }),
    );
    expect(providerFailure(error, 1)).toEqual({
      code: 'PROVIDER_TRANSIENT',
      retrySeconds: 180,
    });
  });
  it('keeps malformed, refused or incomplete model output unscored', async () => {
    environment(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          object: 'response',
          id: 'fixture-response',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: '{"assessment":{"score":99}}',
                  annotations: [],
                },
              ],
            },
          ],
        }),
      ),
    );
    expect((await requestGrade(work, true)).result).toBeUndefined();
  });
});

it('bounds streamed JSON even without content length and rejects cross-origin mutation', async () => {
  environment();
  const request = new Request('http://localhost:3000/api/study', {
    method: 'POST',
    body: JSON.stringify({ text: 'a'.repeat(64000) }),
  });
  await expect(readJson(request)).rejects.toThrow('VALIDATION_ERROR');
  expect(() =>
    sameOrigin(
      new Request('http://localhost:3000/api/study', {
        headers: { origin: 'https://other.example.test' },
      }),
    ),
  ).toThrow('FORBIDDEN');
});
