import 'server-only';
import { randomUUID } from 'node:crypto';
import { serverEnv } from '@/lib/server/env';

const statuses: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  VALIDATION_ERROR: 400,
  SYNC_CONFLICT: 409,
  TIMER_OWNED: 409,
  ALREADY_SUBMITTED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  GRADING_PENDING: 409,
  RETRY_LIMIT: 429,
  SETUP_REQUIRED: 503,
  CONTENT_CHANGED: 409,
  CONTENT_REVOKED: 409,
  CATALOG_CHANGED: 409,
  VERSION_CONFLICT: 409,
  FEATURE_DISABLED: 503,
};

export function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  });
}

export function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const code =
    Object.keys(statuses).find((key) => message === key) ?? 'UNAVAILABLE';
  const correlationId = randomUUID();
  console.error(
    JSON.stringify({ event: 'request_error', code, correlationId }),
  );
  return json({ error: code, correlationId }, statuses[code] ?? 503);
}

export function sameOrigin(request: Request) {
  if (request.headers.get('origin') !== new URL(serverEnv().APP_URL).origin)
    throw new Error('FORBIDDEN');
}

export async function readJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('VALIDATION_ERROR');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 64000) {
      await reader.cancel();
      throw new Error('VALIDATION_ERROR');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('VALIDATION_ERROR');
  }
}

export function dbError(error: { message: string } | null) {
  if (!error) return;
  const code = Object.keys(statuses).find((key) => error.message === key);
  throw new Error(code ?? 'UNAVAILABLE');
}
