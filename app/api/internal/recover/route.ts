import { createHash, timingSafeEqual } from 'node:crypto';
import { workerClient } from '@/lib/server/db/worker-client';
import { errorResponse, json } from '@/lib/server/http';
import { recoverOne } from '@/lib/server/services/recover-grading';

export const dynamic = 'force-dynamic';
export const maxDuration = 90;

export async function POST(request: Request) {
  try {
    const secret = process.env.RECOVERY_SECRET;
    if (!secret || secret.length < 32) throw new Error('SETUP_REQUIRED');
    const supplied = request.headers.get('authorization') ?? '';
    const digest = (value: string) =>
      createHash('sha256').update(value).digest();
    if (!timingSafeEqual(digest(supplied), digest(`Bearer ${secret}`)))
      throw new Error('FORBIDDEN');
    return json(await recoverOne(workerClient()));
  } catch (error) {
    return errorResponse(error);
  }
}
