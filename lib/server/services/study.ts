import 'server-only';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { Database } from '@/lib/contracts/database.types';
import { stateSchema, type StudyAction } from '@/lib/contracts/study';
import { gradingMode } from '@/lib/server/env';
import { dbError } from '@/lib/server/http';

export async function readStudy(db: SupabaseClient<Database>, user: User) {
  const { data, error } = await db.rpc('study_state');
  dbError(error);
  const value =
    typeof data === 'object' && data !== null && !Array.isArray(data)
      ? data
      : {};
  return stateSchema.parse({
    ...value,
    userId: user.id,
    email: user.email ?? '',
    gradingMode: gradingMode(),
  });
}

export async function changeStudy(
  db: SupabaseClient<Database>,
  input: StudyAction,
) {
  if (input.action === 'start') {
    const result = await db.rpc('start_study', {
      p_question: input.questionId,
      p_timezone: input.timezone,
    });
    dbError(result.error);
    return result.data;
  }
  if (input.action === 'retry') {
    const result = await db.rpc('retry_grade', { p_attempt: input.attemptId });
    dbError(result.error);
    return result.data;
  }
  const params = {
    p_item: input.itemId,
    p_version: input.version,
    p_answer: input.answer,
    p_confidence: input.confidence,
    p_assisted: input.assisted,
    p_device: input.deviceId,
  };
  if (input.action === 'checkpoint') {
    const result = await db.rpc('checkpoint', {
      ...params,
      p_action: input.timingAction,
    });
    dbError(result.error);
    return result.data;
  }
  const result = await db.rpc('submit_answer', {
    ...params,
    p_question: input.questionId,
    p_key: input.key,
  });
  dbError(result.error);
  return result.data;
}
