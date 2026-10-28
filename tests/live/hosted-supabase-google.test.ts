import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@/lib/contracts/database.types';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Live service tests require ${name}.`);
  return value;
}

const projectUrl = new URL(required('NEXT_PUBLIC_SUPABASE_URL'));
const publishableKey = required('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
const serviceRoleKey = required('SUPABASE_SERVICE_ROLE_KEY');
const appUrl = new URL(required('APP_URL'));

beforeAll(() => {
  if (process.env.RUN_LIVE_SERVICE_TESTS !== 'true')
    throw new Error(
      'Set RUN_LIVE_SERVICE_TESTS=true to run live service tests.',
    );
  if (
    projectUrl.protocol !== 'https:' ||
    !projectUrl.hostname.endsWith('.supabase.co') ||
    projectUrl.pathname !== '/' ||
    projectUrl.search ||
    projectUrl.hash ||
    appUrl.pathname !== '/' ||
    appUrl.search ||
    appUrl.hash
  )
    throw new Error(
      'Live tests require a hosted Supabase project and app origin.',
    );
});

describe('hosted Supabase and Google OAuth configuration', () => {
  it('can read the hosted question schema without changing project data', async () => {
    const admin = createClient<Database>(
      projectUrl.toString(),
      serviceRoleKey,
      {
        auth: { persistSession: false, autoRefreshToken: false },
      },
    );
    const { data, error } = await admin
      .from('question_versions')
      .select('id')
      .limit(1);
    expect(error).toBeNull();
    expect(data).toBeDefined();
    expect(data?.length).toBeGreaterThan(0);
  });

  it('has Google enabled and redirects OAuth initiation to Google', async () => {
    const settings = await fetch(new URL('/auth/v1/settings', projectUrl), {
      headers: { apikey: publishableKey },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    expect(settings.status).toBe(200);
    const configuration = (await settings.json()) as {
      external?: { google?: boolean };
    };
    expect(configuration.external?.google).toBe(true);

    const jar = new Map<string, string>();
    const ssr = createServerClient<Database>(
      projectUrl.toString(),
      publishableKey,
      {
        cookies: {
          getAll: () => [...jar].map(([name, value]) => ({ name, value })),
          setAll: (values) =>
            values.forEach(({ name, value }) => jar.set(name, value)),
        },
      },
    );
    const redirectTo = new URL('/auth/callback', appUrl).toString();
    const result = await ssr.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: true },
    });
    expect(result.error).toBeNull();
    expect(result.data.url).toBeTruthy();

    const authorize = new URL(result.data.url ?? '');
    expect(authorize.origin).toBe(projectUrl.origin);
    expect(authorize.pathname).toBe('/auth/v1/authorize');
    expect(authorize.searchParams.get('provider')).toBe('google');
    expect(authorize.searchParams.get('redirect_to')).toBe(redirectTo);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('s256');
    expect(jar.size).toBeGreaterThan(0);

    const response = await fetch(authorize, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    expect([302, 303, 307, 308]).toContain(response.status);
    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    expect(new URL(location ?? '').hostname).toBe('accounts.google.com');
  });
});
