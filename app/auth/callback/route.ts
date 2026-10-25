import { NextResponse } from 'next/server';
import { userClient } from '@/lib/server/db/user-client';
import { serverEnv } from '@/lib/server/env';

export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get('code');
  const db = await userClient();
  if (code && code.length < 3000) {
    const { error } = await db.auth.exchangeCodeForSession(code);
    if (!error)
      return NextResponse.redirect(new URL('/', serverEnv().APP_URL), {
        headers: { 'Cache-Control': 'private, no-store' },
      });
  }
  return NextResponse.redirect(new URL('/?auth=expired', serverEnv().APP_URL), {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
