import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/auth/login/route';
import { GET } from '@/app/auth/callback/route';
import { serverEnv } from '@/lib/server/env';

const auth = vi.hoisted(() => ({
  signInWithOAuth: vi.fn(),
  exchangeCodeForSession: vi.fn(),
}));
vi.mock('@/lib/server/db/user-client', () => ({
  userClient: async () => ({ auth }),
}));

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'synthetic-key');
  vi.stubEnv('APP_URL', 'http://localhost:3000');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ external: { google: true } })),
  );
  auth.signInWithOAuth.mockResolvedValue({
    data: {
      url: 'http://127.0.0.1:54321/auth/v1/authorize?provider=google',
    },
    error: null,
  });
  auth.exchangeCodeForSession.mockResolvedValue({ error: null });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function login(body = {}, origin = 'http://localhost:3000') {
  return POST(
    new Request('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { origin },
      body: JSON.stringify(body),
    }),
  );
}

describe('Google-only PKCE entrypoint', () => {
  it('uses the configured callback and Supabase OAuth without extra Google scopes', async () => {
    const result = await login();
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toContain('no-store');
    expect(auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: {
        redirectTo: 'http://localhost:3000/auth/callback',
        skipBrowserRedirect: true,
      },
    });
  });
  it('rejects email, client-supplied redirects and cross-origin login', async () => {
    expect((await login({ email: 'person@example.test' })).status).toBe(400);
    expect((await login({ next: 'https://other.example.test' })).status).toBe(
      400,
    );
    expect((await login({}, 'https://other.example.test')).status).toBe(403);
    expect(auth.signInWithOAuth).not.toHaveBeenCalled();
  });
  it('keeps provider configuration and unexpected authorize destinations out of navigation', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ external: { google: false } }),
    );
    expect((await login()).status).toBe(503);
    expect(auth.signInWithOAuth).not.toHaveBeenCalled();
    auth.signInWithOAuth.mockResolvedValueOnce({
      data: {
        url: 'https://other.example.test/auth/v1/authorize?provider=google',
      },
      error: null,
    });
    expect((await login()).status).toBe(503);
  });
});

describe('OAuth callback', () => {
  it('exchanges one bounded code and ignores untrusted host and next parameters', async () => {
    const response = await GET(
      new Request(
        'http://untrusted.test/auth/callback?code=valid&next=https://other.test',
      ),
    );
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith('valid');
    expect(response.headers.get('location')).toBe('http://localhost:3000/');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('handles denial and invalid codes without reflecting provider descriptions', async () => {
    for (const query of [
      '',
      'code=',
      `code=${'x'.repeat(3000)}`,
      'code=a&code=b',
    ]) {
      const response = await GET(
        new Request(`http://localhost:3000/auth/callback?${query}`),
      );
      expect(response.headers.get('location')).toBe(
        'http://localhost:3000/?auth=failed',
      );
    }
    const denied = await GET(
      new Request(
        'http://localhost:3000/auth/callback?code=ignored&error=access_denied&error_description=untrusted',
      ),
    );
    expect(denied.headers.get('location')).toBe(
      'http://localhost:3000/?auth=denied',
    );
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
    auth.exchangeCodeForSession.mockResolvedValueOnce({
      error: { message: 'expired verifier' },
    });
    expect(
      (
        await GET(
          new Request('http://localhost:3000/auth/callback?code=expired'),
        )
      ).headers.get('location'),
    ).toBe('http://localhost:3000/?auth=failed');
    auth.exchangeCodeForSession.mockRejectedValueOnce(new Error('connection'));
    expect(
      (
        await GET(
          new Request('http://localhost:3000/auth/callback?code=unavailable'),
        )
      ).headers.get('location'),
    ).toBe('http://localhost:3000/?auth=failed');
  });
  it('rejects ambiguous or insecure configured application return URLs', () => {
    for (const value of [
      'https://user:password@example.test',
      'https://example.test/path',
      'http://example.test',
      'https://example.test/?next=x',
    ]) {
      vi.stubEnv('APP_URL', value);
      expect(() => serverEnv()).toThrow('SETUP_REQUIRED');
    }
  });
});
