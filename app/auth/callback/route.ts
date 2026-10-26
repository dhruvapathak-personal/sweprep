import { NextResponse } from 'next/server';
import { userClient } from '@/lib/server/db/user-client';
import { serverEnv } from '@/lib/server/env';

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  let destination = '/?auth=failed';
  if (params.get('error') === 'access_denied') destination = '/?auth=denied';
  else if (!params.has('error')) {
    const code = params.get('code');
    if (code && code.length < 3000 && params.getAll('code').length === 1) {
      try {
        const db = await userClient();
        const { error } = await db.auth.exchangeCodeForSession(code);
        if (!error) destination = '/';
      } catch {}
    }
  }
  return NextResponse.redirect(new URL(destination, serverEnv().APP_URL), {
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  });
}
