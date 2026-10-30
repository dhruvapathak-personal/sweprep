import 'server-only';
import OpenAI from 'openai';
import { z } from 'zod';
import { gradeDetailsSchema, questionSchema } from '@/lib/contracts/study';
import { assertLiveGrading } from '@/lib/server/env';
import { contentPolicy } from '@/lib/contracts/content';
import { gradingTask, gradingOutput } from '@/lib/contracts/grading';
import { providerBaseUrl, structuredRequest } from '@/lib/content/provider';

export const workSchema = z.object({
  qualificationPolicy: z.string().nullable().default(null),
  modelEvaluationDigest: z.string().nullable().default(null),
  job: z.object({
    attempt_id: z.uuid(),
    generation: z.number().int().positive(),
    lease_token: z.uuid(),
    request_count: z.number().int().min(0).max(3),
    repair_used: z.boolean(),
  }),
  attempt: z.object({
    answer_text: z.string().max(12000),
    confidence: z.string().max(30),
  }),
  question: questionSchema,
  rubric: z.object({
    version: z.string().max(100),
    pass_score: z.number().int().min(0).max(5),
    required_claims: z.array(z.string().max(1000)).max(20),
    reference_answer: z.string().max(10000),
  }),
});
export type GradingWork = z.infer<typeof workSchema>;
export const requestReservationCents = 10;
export const modelId = 'gpt-5.4-mini-2026-03-17';

export function simulatedGrade(work: GradingWork) {
  if (
    work.attempt.answer_text.startsWith('[simulate-failure]') &&
    work.job.generation === 1
  )
    throw new Error('SIMULATED_FAILURE');
  if (work.attempt.answer_text.startsWith('[simulate-uncertain]')) {
    return gradeDetailsSchema.parse({
      outcome: 'uncertain',
      reason: 'Simulated uncertainty. No model assessed this answer.',
    });
  }
  return gradeDetailsSchema.parse({
    outcome: 'scored',
    score: 3,
    criticalClaimsMet: true,
    correctClaims: ['Simulation only: no claims were assessed.'],
    missingClaims: [],
    incorrectClaims: [],
    idealAnswer: work.rubric.reference_answer,
    explanation:
      'Simulated grading / not readiness evidence. This fixed demonstration score does not assess your answer.',
  });
}

export function providerFailure(error: unknown, requestCount: number) {
  if (error instanceof OpenAI.APIConnectionError)
    return {
      code: 'PROVIDER_TIMEOUT',
      retrySeconds: requestCount <= 1 ? 30 : 120,
    };
  if (error instanceof OpenAI.APIError) {
    const retryable =
      error.status === 408 ||
      error.status === 409 ||
      error.status === 429 ||
      (error.status !== undefined && error.status >= 500);
    const header = error.headers?.get('retry-after');
    const seconds = header ? Number(header) : NaN;
    const until = header
      ? Math.ceil((Date.parse(header) - Date.now()) / 1000)
      : NaN;
    const delay = Number.isFinite(seconds)
      ? seconds
      : Number.isFinite(until)
        ? until
        : 0;
    return {
      code: retryable ? 'PROVIDER_TRANSIENT' : 'PROVIDER_REJECTED',
      retrySeconds: retryable
        ? Math.min(86400, Math.max(requestCount <= 1 ? 30 : 120, delay))
        : 0,
    };
  }
  const code =
    error instanceof Error &&
    [
      'LIVE_GRADING_DISABLED',
      'QUALIFICATION_REQUIRED',
      'BUDGET_EXCEEDED',
      'REQUEST_LIMIT',
      'SIMULATED_FAILURE',
      'INVALID_OUTPUT',
    ].includes(error.message)
      ? error.message
      : 'GRADING_UNAVAILABLE';
  return { code, retrySeconds: 0 };
}

export async function requestGrade(work: GradingWork, repair: boolean) {
  const env = assertLiveGrading();
  if (
    work.question.content_review !== 'approved' ||
    work.qualificationPolicy !== contentPolicy ||
    work.modelEvaluationDigest !== env.MODEL_EVAL_RELEASE_DIGEST
  )
    throw new Error('QUALIFICATION_REQUIRED');
  const task = gradingTask(
    {
      question: work.question.content_blocks,
      assumptions: work.question.assumptions ?? null,
      rubric: work.rubric,
      learnerAnswer: work.attempt.answer_text,
    },
    repair,
  );
  const client = new OpenAI({
    baseURL: providerBaseUrl,
    apiKey: process.env.OPENAI_API_KEY,
    maxRetries: 0,
    timeout: 30000,
  });
  const started = Date.now();
  const response = await client.responses.create(
    structuredRequest(task, env.OPENAI_MODEL ?? modelId, 'technical_grade'),
  );
  const parsedUsage = z
    .object({
      input_tokens: z.number().int().min(0).max(1000000),
      output_tokens: z.number().int().min(0).max(3000),
    })
    .safeParse(response.usage);
  const usage = parsedUsage.success ? parsedUsage.data : undefined;
  const actualCents = usage
    ? Math.ceil((usage.input_tokens * 0.75 + usage.output_tokens * 4.5) / 10000)
    : undefined;
  const metadata = {
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    latencyMs: Date.now() - started,
  };
  return {
    result: gradingOutput(response) ?? undefined,
    actualCents,
    metadata,
  };
}
