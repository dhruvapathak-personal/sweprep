import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from '@/lib/contracts/database.types';
import { serverEnv } from '@/lib/server/env';

export async function userClient() {
  const env = serverEnv();
  const store = await cookies();
  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (values) => {
          values.forEach(({ name, value, options }) =>
            store.set(name, value, options),
          );
        },
      },
    },
  );
}

export async function authenticatedClient() {
  const db = await userClient();
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) throw new Error('UNAUTHENTICATED');
  return { db, user: data.user };
}
