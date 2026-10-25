import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database } from '@/lib/contracts/database.types';
import { serverEnv } from '@/lib/server/env';

export function workerClient() {
  const env = serverEnv();
  const secret = z
    .string()
    .min(20)
    .safeParse(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!secret.success) throw new Error('SETUP_REQUIRED');
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, secret.data, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
