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
import {
  gradingInstructions,
  providerResultSchema,
} from '@/lib/contracts/grading';

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
  qualificationPolicy: 'content-policy-v2',
  modelEvaluationDigest: 'a'.repeat(64),
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
    CONTENT_POLICY_VERSION: 'content-policy-v2',
    MODEL_EVAL_APPROVED: 'true',
    MODEL_EVAL_PROTOCOL_VERSION: 'release-evaluation-v2',
    MODEL_EVAL_RELEASE_DIGEST: 'a'.repeat(64),
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
  it('requires coherent critical flags for every score while preserving historical details', () => {
    for (let score = 0; score <= 5; score++) {
      const coherent = { ...assessment, score, criticalClaimsMet: score >= 3 };
      expect(
        providerResultSchema.safeParse({ assessment: coherent }).success,
      ).toBe(true);
      expect(
        providerResultSchema.safeParse({
          assessment: { ...coherent, criticalClaimsMet: score < 3 },
        }).success,
      ).toBe(false);
    }
    expect(
      gradeDetailsSchema.safeParse({
        ...assessment,
        score: 1,
        criticalClaimsMet: true,
      }).success,
    ).toBe(true);
    const instructions = gradingInstructions(false);
    for (const anchor of [
      'Score 0',
      'Score 1',
      'Score 2',
      'Score 3',
      'Score 4',
      'Score 5',
    ])
      expect(instructions).toContain(anchor);
    expect(instructions).toContain('concise');
    expect(instructions).toContain('non-answer');
    expect(instructions).toContain('contradictory');
  });
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
  it('round-trips frozen card anchors and a separate defective-context control through the learner adapter', async () => {
    environment(true);
    const examples = [
      ['Blue square', 0],
      ['I will answer later', 0],
      ['The color starts with a', 1],
      ['Amber', 2],
      ['Amber circle, therefore every card has those labels', 3],
      ['Amber circle', 4],
      [
        'Its printed labels are amber and circle; these do not assert physical properties',
        5,
      ],
    ] as const;
    for (const [answer, score] of examples) {
      const expected = {
        outcome: 'scored',
        score,
        criticalClaimsMet: score >= 3,
        correctClaims: score ? ['A correct card-label fragment.'] : [],
        missingClaims: score < 3 ? ['At least one required label.'] : [],
        incorrectClaims:
          score === 3 ? ['The unsupported all-card generalization.'] : [],
        idealAnswer:
          'Its printed labels are amber and circle, not physical properties.',
        explanation:
          'Frozen synthetic contract observation, not a model-quality result.',
      };
      const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const sent = JSON.parse(String(init?.body));
        const input = JSON.parse(sent.input);
        expect(input.learnerAnswer).toBe(answer);
        expect(input.rubric.pass_score).toBe(4);
        expect(input).not.toHaveProperty('expected');
        expect(sent.instructions).toContain(
          'Missing or contradicted required claims cap the score at 2',
        );
        expect(sent.instructions).toContain(
          'a concise complete answer qualifies',
        );
        return Response.json({
          object: 'response',
          id: 'synthetic-card-response',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({ assessment: expected }),
                  annotations: [],
                },
              ],
            },
          ],
        });
      });
      vi.stubGlobal('fetch', transport);
      const result = await requestGrade(
        {
          ...work,
          question: {
            ...work.question,
            content_blocks: [
              {
                type: 'text',
                text: 'A fictional card prints color: amber; shape: circle. State both labels.',
              },
            ],
          },
          rubric: {
            version: 'synthetic-card-v2',
            pass_score: 4,
            required_claims: [
              'The printed color is amber.',
              'The printed shape is circle.',
            ],
            reference_answer:
              'Amber circle. Score 5: Explicitly identify both as printed labels, not physical properties.',
          },
          attempt: { ...work.attempt, answer_text: answer },
        },
        false,
      );
      expect(result.result).toEqual(expected);
    }
    const uncertain = {
      outcome: 'uncertain',
      reason:
        'Two authoritative color labels conflict, with no precedence rule.',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          object: 'response',
          id: 'synthetic-context-response',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({ assessment: uncertain }),
                  annotations: [],
                },
              ],
            },
          ],
        }),
      ),
    );
    expect(
      (
        await requestGrade(
          {
            ...work,
            question: {
              ...work.question,
              assumptions:
                'The authoritative color labels conflict: amber and blue. No precedence rule exists.',
            },
          },
          false,
        )
      ).result,
    ).toEqual(uncertain);
    expect(
      providerResultSchema.parse({ assessment: uncertain }).assessment,
    ).toEqual(uncertain);
    expect(
      providerResultSchema.safeParse({ assessment: { ...uncertain, score: 0 } })
        .success,
    ).toBe(false);
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
    ).rejects.toThrow('QUALIFICATION_REQUIRED');
    vi.stubEnv('MODEL_EVAL_PROTOCOL_VERSION', 'release-evaluation-v1');
    await expect(requestGrade(work, false)).rejects.toThrow(
      'LIVE_GRADING_DISABLED',
    );
    vi.stubEnv('MODEL_EVAL_PROTOCOL_VERSION', 'release-evaluation-v2');
    await expect(
      requestGrade({ ...work, modelEvaluationDigest: 'b'.repeat(64) }, false),
    ).rejects.toThrow('QUALIFICATION_REQUIRED');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects hosted simulation and budgets above approved caps', () => {
    environment();
    vi.stubEnv('GRADING_MODE', 'simulated');
    vi.stubEnv('ALLOW_LOCAL_SIMULATION', 'true');
    expect(gradingMode()).toBe('simulated');
    vi.stubEnv(
      'NEXT_PUBLIC_SUPABASE_URL',
      'http://host.containers.internal:54321',
    );
    expect(() => gradingMode()).toThrow('SIMULATION_NOT_LOCAL');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
    expect(() => gradingMode()).toThrow('SIMULATION_NOT_LOCAL');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('DEPLOYMENT_ENV', 'production');
    expect(() => gradingMode()).toThrow('SIMULATION_NOT_LOCAL');
    vi.stubEnv('DEPLOYMENT_ENV', '');
    vi.stubEnv('APP_URL', 'https://trainer.example.test');
    expect(() => gradingMode()).toThrow('SIMULATION_NOT_LOCAL');
    vi.stubEnv('AI_DAILY_CAP_CENTS', '1001');
    expect(() => assertLiveGrading()).toThrow('SETUP_REQUIRED');
  });
  it('supports hosted development without enabling grading or bypassing live approvals', async () => {
    environment();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(gradingMode()).toBe('disabled');
    await expect(requestGrade(work, false)).rejects.toThrow(
      'LIVE_GRADING_DISABLED',
    );
    vi.stubEnv('GRADING_MODE', 'live');
    vi.stubEnv('PROVIDER_DATA_POLICY_APPROVED', 'false');
    expect(gradingMode()).toBe('live');
    await expect(requestGrade(work, false)).rejects.toThrow(
      'LIVE_GRADING_DISABLED',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses the real SDK with strict structured output, no storage/tools and one transport dispatch', async () => {
    environment(true);
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      expect(sent.store).toBe(false);
      expect(sent.tools).toBeUndefined();
      expect(sent.max_output_tokens).toBe(3000);
      expect(sent.text.format.strict).toBe(true);
      const schema = JSON.stringify(sent.text.format.schema);
      expect(schema).not.toContain('"oneOf"');
      expect(sent.text.format.schema.properties.assessment.anyOf).toHaveLength(
        2,
      );
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
    expect(providerFailure(new OpenAI.APIConnectionTimeoutError(), 1)).toEqual({
      code: 'PROVIDER_TIMEOUT',
      retrySeconds: 30,
    });
    expect(providerFailure(new OpenAI.APIConnectionTimeoutError(), 2)).toEqual({
      code: 'PROVIDER_TIMEOUT',
      retrySeconds: 120,
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
