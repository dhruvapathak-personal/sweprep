import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/contracts/database.types';
import { gradeDetailsSchema } from '@/lib/contracts/study';
import { assertLiveGrading, gradingMode, serverEnv } from '@/lib/server/env';
import {
  modelId,
  providerFailure,
  requestGrade,
  requestReservationCents,
  simulatedGrade,
  workSchema,
} from '@/lib/server/ai/grader';

function checked<T>(result: { data: T; error: { message: string } | null }) {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

export async function recoverOne(db: SupabaseClient<Database>) {
  const raw = checked(await db.rpc('claim_grading'));
  if (raw === null) return { processed: false };
  const work = workSchema.parse(raw);
  const identity = {
    p_attempt: work.job.attempt_id,
    p_generation: work.job.generation,
    p_lease: work.job.lease_token,
  };
  let requestCount = work.job.request_count;
  try {
    const mode = gradingMode();
    let result;
    if (mode === 'simulated') {
      result = simulatedGrade(work);
    } else {
      assertLiveGrading();
      if (work.question.content_review !== 'approved')
        throw new Error('CONTENT_NOT_REVIEWED');
      const env = serverEnv();
      const dispatch = async (repair: boolean) => {
        const reservation = checked(
          await db.rpc('reserve_provider_request', {
            ...identity,
            p_cents: requestReservationCents,
            p_daily_cap: env.AI_DAILY_CAP_CENTS,
            p_monthly_cap: env.AI_MONTHLY_CAP_CENTS,
            p_repair: repair,
          }),
        );
        if (!reservation) throw new Error('GRADING_UNAVAILABLE');
        requestCount += 1;
        const response = await requestGrade(work, repair);
        if (
          response.actualCents !== undefined &&
          response.actualCents <= requestReservationCents
        ) {
          checked(
            await db.rpc('settle_provider_request', {
              p_request: reservation,
              p_cents: response.actualCents,
              p_usage: response.metadata,
            }),
          );
        }
        return response.result;
      };
      result = await dispatch(false);
      if (!result && !work.job.repair_used) result = await dispatch(true);
      if (!result) throw new Error('INVALID_OUTPUT');
    }
    const validated = gradeDetailsSchema.parse(result);
    checked(
      await db.rpc('finalize_grade', {
        ...identity,
        p_result: validated as Json,
        p_simulated: mode === 'simulated',
        p_model: mode === 'simulated' ? 'local-simulator-v1' : modelId,
      }),
    );
    console.info(
      JSON.stringify({
        event: 'grading_complete',
        attemptId: work.job.attempt_id,
        generation: work.job.generation,
        simulated: mode === 'simulated',
      }),
    );
    return { processed: true, outcome: validated.outcome };
  } catch (error) {
    const failure = providerFailure(error, requestCount);
    const failed = await db.rpc('fail_grading', {
      ...identity,
      p_error: failure.code,
      p_retry_seconds: failure.retrySeconds,
    });
    if (failed.error) throw new Error('RECOVERY_FINALIZATION_UNAVAILABLE');
    console.info(
      JSON.stringify({
        event: 'grading_failed',
        code: failure.code,
        attemptId: work.job.attempt_id,
        generation: work.job.generation,
      }),
    );
    return { processed: true, outcome: failure.code };
  }
}
