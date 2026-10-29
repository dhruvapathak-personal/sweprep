import 'server-only';
import { z } from 'zod';
import { contentPolicy } from '@/lib/contracts/content';

const serverSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  APP_URL: z.url().refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    );
  }),
  GRADING_MODE: z.enum(['disabled', 'simulated', 'live']).default('disabled'),
  ALLOW_LOCAL_SIMULATION: z.enum(['true', 'false']).default('false'),
  CONTENT_POLICY_VERSION: z.string().default(''),
  MODEL_EVAL_APPROVED: z.enum(['true', 'false']).default('false'),
  PROVIDER_DATA_POLICY_APPROVED: z.enum(['true', 'false']).default('false'),
  DEPLOYMENT_RECOVERY_APPROVED: z.enum(['true', 'false']).default('false'),
  AI_DAILY_CAP_CENTS: z.coerce.number().int().min(0).max(100).default(0),
  AI_MONTHLY_CAP_CENTS: z.coerce.number().int().min(0).max(2000).default(0),
  OPENAI_MODEL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.literal('gpt-5.4-mini-2026-03-17').optional(),
  ),
});

export function serverEnv() {
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) throw new Error('SETUP_REQUIRED');
  return parsed.data;
}

export function gradingMode() {
  const env = serverEnv();
  if (env.GRADING_MODE !== 'simulated') return env.GRADING_MODE;
  const local = (url: string) =>
    ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname);
  if (
    env.ALLOW_LOCAL_SIMULATION !== 'true' ||
    !local(env.APP_URL) ||
    !local(env.NEXT_PUBLIC_SUPABASE_URL) ||
    process.env.VERCEL ||
    process.env.DEPLOYMENT_ENV === 'production'
  ) {
    throw new Error('SIMULATION_NOT_LOCAL');
  }
  return 'simulated';
}

export function assertLiveGrading() {
  const env = serverEnv();
  if (
    env.GRADING_MODE !== 'live' ||
    env.CONTENT_POLICY_VERSION !== contentPolicy ||
    env.MODEL_EVAL_APPROVED !== 'true' ||
    env.PROVIDER_DATA_POLICY_APPROVED !== 'true' ||
    env.DEPLOYMENT_RECOVERY_APPROVED !== 'true' ||
    !env.OPENAI_MODEL ||
    !process.env.OPENAI_API_KEY ||
    env.AI_DAILY_CAP_CENTS <= 0 ||
    env.AI_MONTHLY_CAP_CENTS <= 0
  ) {
    throw new Error('LIVE_GRADING_DISABLED');
  }
  return env;
}

export function assertContentPolicy() {
  if (serverEnv().CONTENT_POLICY_VERSION !== contentPolicy)
    throw new Error('FEATURE_DISABLED');
}
