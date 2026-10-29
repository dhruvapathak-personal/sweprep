import { z } from 'zod';

export const confidenceSchema = z.enum([
  'guess',
  'unsure',
  'fairly_sure',
  'certain',
]);
export const blockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(10000) }).strict(),
  z
    .object({
      type: z.literal('code'),
      language: z.enum(['cpp', 'python', 'text']),
      text: z.string().max(10000),
    })
    .strict(),
]);
export const questionSchema = z.object({
  id: z.uuid(),
  question_id: z.string().max(100),
  version: z.number().int().positive(),
  title: z.string().max(200),
  skill: z.string().max(100),
  content_blocks: z.array(blockSchema).max(20),
  content_review: z.enum(['candidate', 'approved']),
  domain: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  assumptions: z.string().max(2000).nullable().optional(),
  secondary_skills: z.array(z.string()).nullable().optional(),
  prerequisites: z.array(z.string()).nullable().optional(),
  difficulty: z.number().int().min(1).max(5).nullable().optional(),
});
export const draftFields = {
  itemId: z.uuid(),
  version: z.number().int().nonnegative(),
  answer: z.string().max(12000),
  confidence: confidenceSchema,
  assisted: z.boolean(),
  deviceId: z.uuid(),
};
export const studyActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('start'),
      questionId: z.uuid(),
      timezone: z
        .string()
        .max(100)
        .refine((zone) => {
          try {
            new Intl.DateTimeFormat('en', { timeZone: zone });
            return true;
          } catch {
            return false;
          }
        }),
    })
    .strict(),
  z
    .object({
      action: z.literal('checkpoint'),
      ...draftFields,
      timingAction: z.enum([
        'save',
        'claim',
        'takeover',
        'pause',
        'resume',
        'disconnect',
      ]),
    })
    .strict(),
  z
    .object({
      action: z.literal('submit'),
      ...draftFields,
      answer: z
        .string()
        .max(12000)
        .refine((text) => text.trim().length > 0),
      questionId: z.uuid(),
      key: z.uuid(),
    })
    .strict(),
  z.object({ action: z.literal('retry'), attemptId: z.uuid() }).strict(),
]);
export const itemSchema = z.object({
  id: z.uuid(),
  question_version_id: z.uuid(),
  version: z.number().int(),
  answer_text: z.string().max(12000),
  confidence: confidenceSchema,
  assisted: z.boolean(),
  state: z.enum(['answering', 'submitted', 'graded']),
  source: z.enum(['first', 'review']),
  displayed_at: z.string(),
  saved_at: z.string(),
  lease_device: z.uuid().nullable(),
  lease_until: z.string().nullable(),
  last_ack_at: z.string().nullable(),
  paused: z.boolean(),
  active_ms: z.number().nonnegative(),
});
export const gradeDetailsSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('scored'),
      score: z.number().int().min(0).max(5),
      criticalClaimsMet: z.boolean(),
      correctClaims: z.array(z.string().min(1).max(500)).max(10),
      missingClaims: z.array(z.string().min(1).max(500)).max(10),
      incorrectClaims: z.array(z.string().min(1).max(500)).max(10),
      idealAnswer: z.string().min(1).max(5000),
      explanation: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('uncertain'),
      reason: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('invalidated'),
      reason: z.string().min(1).max(250),
    })
    .strict(),
]);
export const stateSchema = z.object({
  userId: z.uuid(),
  email: z.string(),
  timezone: z.string(),
  gradingMode: z.enum(['disabled', 'simulated', 'live']),
  serverNow: z.string(),
  todayMs: z.number().nonnegative(),
  pinnedQuestions: z.array(questionSchema).max(101),
  items: z.array(itemSchema).max(101),
  attempts: z
    .array(
      z.object({
        id: z.uuid(),
        item_id: z.uuid(),
        question_version_id: z.uuid(),
        answer_text: z.string(),
        submitted_at: z.string(),
        active_ms: z.number(),
        confidence: confidenceSchema,
        assisted: z.boolean(),
        source: z.enum(['first', 'review']),
      }),
    )
    .max(100),
  jobs: z
    .array(
      z.object({
        attempt_id: z.uuid(),
        state: z.enum([
          'pending',
          'grading',
          'retry_wait',
          'failed',
          'uncertain',
          'scored',
        ]),
        generation: z.number().int(),
        error_code: z.string().nullable(),
        request_count: z.number().int(),
      }),
    )
    .max(100),
  grades: z
    .array(
      z.object({
        id: z.uuid(),
        attempt_id: z.uuid(),
        generation: z.number().int(),
        outcome: z.enum(['scored', 'uncertain', 'invalidated']),
        score: z.number().int().nullable(),
        passed: z.boolean().nullable(),
        details: gradeDetailsSchema,
        simulated: z.boolean(),
        rubric_version: z.string(),
        grader_version: z.string(),
        model: z.string(),
        prompt_version: z.string(),
        validator_version: z.string(),
        created_at: z.string(),
      }),
    )
    .max(1000),
  selections: z
    .array(
      z.object({
        id: z.number(),
        attempt_id: z.uuid(),
        grade_id: z.uuid(),
        previous_grade_id: z.uuid().nullable(),
        reason: z.string(),
      }),
    )
    .max(1000),
});
export type StudyState = z.infer<typeof stateSchema>;
export type StudyItem = StudyState['items'][number];
export type StudyAction = z.infer<typeof studyActionSchema>;
export type GradeDetails = z.infer<typeof gradeDetailsSchema>;
export type Confidence = z.infer<typeof confidenceSchema>;
