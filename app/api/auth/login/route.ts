import { z } from 'zod';
import { userClient } from '@/lib/server/db/user-client';
import { serverEnv } from '@/lib/server/env';
import { errorResponse, json, readJson, sameOrigin } from '@/lib/server/http';

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const parsed = z
      .object({ email: z.email().max(254) })
      .strict()
      .safeParse(await readJson(request));
    if (!parsed.success) throw new Error('VALIDATION_ERROR');
    const db = await userClient();
    const { error } = await db.auth.signInWithOtp({
      email: parsed.data.email,
      options: {
        emailRedirectTo: new URL(
          '/auth/callback',
          serverEnv().APP_URL,
        ).toString(),
      },
    });
    if (error) throw new Error('UNAVAILABLE');
    return json({ sent: true });
  } catch (error) {
    return errorResponse(error);
  }
}
