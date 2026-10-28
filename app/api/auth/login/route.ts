import { z } from 'zod';
import { userClient } from '@/lib/server/db/user-client';
import { serverEnv } from '@/lib/server/env';
import { errorResponse, json, readJson, sameOrigin } from '@/lib/server/http';

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const parsed = z
      .object({})
      .strict()
      .safeParse(await readJson(request));
    if (!parsed.success) throw new Error('VALIDATION_ERROR');
    const env = serverEnv();
    const settings = await fetch(
      new URL('/auth/v1/settings', env.NEXT_PUBLIC_SUPABASE_URL),
      {
        headers: { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!settings.ok || (await settings.json()).external?.google !== true)
      throw new Error('UNAVAILABLE');
    const db = await userClient();
    const { data, error } = await db.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: new URL('/auth/callback', env.APP_URL).toString(),
        skipBrowserRedirect: true,
      },
    });
    if (error || !data.url) throw new Error('UNAVAILABLE');
    const target = new URL(data.url);
    if (
      target.origin !== new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin ||
      target.pathname !== '/auth/v1/authorize' ||
      target.searchParams.get('provider') !== 'google'
    )
      throw new Error('UNAVAILABLE');
    return json({ url: target.toString() });
  } catch (error) {
    return errorResponse(error);
  }
}
