import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import type { Database } from '@/lib/contracts/database.types';
import type { ContentBundle } from '@/lib/content/manifest';
import { contentDigest } from '@/lib/content/manifest';
import { manifestFor, syntheticEvidence } from '@/tests/fixtures/content';

export const localUrl = process.env.TEST_SUPABASE_URL ?? '';
export const localKey = process.env.TEST_SUPABASE_KEY ?? '';
export const client = (credential = localKey) =>
  createClient<Database>(localUrl, credential, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
export function sql(statement: string) {
  if (
    process.env.CI !== 'true' ||
    process.env.PGHOSTADDR !== '127.0.0.1' ||
    new URL(localUrl).origin !== 'http://127.0.0.1:54321'
  )
    throw new Error('Isolated test administration required.');
  return execFileSync(
    'psql',
    ['-X', '-w', '-q', '-v', 'ON_ERROR_STOP=1', '-At'],
    {
      input: statement,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ).trim();
}
export const literal = (value: unknown) =>
  `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
export function importBundles(bundles: ContentBundle[]) {
  return JSON.parse(
    sql(
      `set role content_importer; select private.import_content_manifest(${literal(manifestFor(bundles))});`,
    ),
  );
}
export function installEvidence(
  bundle: ContentBundle,
  evidence = syntheticEvidence(bundle),
) {
  const id = randomUUID();
  sql(`insert into private.qualification_runs(id,candidate_id,candidate_digest,policy_version,evidence,evidence_digest,decision)
    values('${id}','${bundle.id}','${bundle.digest}','content-policy-v1',${literal(evidence)},'${contentDigest(evidence)}','qualified');`);
  return id;
}
export function release(bundle: ContentBundle, qualificationId: string) {
  return {
    candidateId: bundle.id,
    digest: bundle.digest,
    qualificationId,
    expectedHead: bundle.parentId,
  };
}
export function publish(releases: ReturnType<typeof release>[]) {
  return sql(
    `set role content_publisher; select private.publish_content_batch(${literal(releases)});`,
  );
}
export function installBundles(bundles: ContentBundle[]) {
  importBundles(bundles);
  const releases = bundles.map((bundle) =>
    release(bundle, installEvidence(bundle)),
  );
  publish(releases);
  return releases;
}
export async function testUser() {
  const admin = client(process.env.TEST_SERVICE_KEY);
  const email = `synthetic-${randomUUID()}@example.test`;
  const created = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (created.error) throw created.error;
  const link = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (link.error) throw link.error;
  const db = client();
  const signed = await db.auth.verifyOtp({
    type: 'magiclink',
    token_hash: link.data.properties.hashed_token,
  });
  if (signed.error || !signed.data.user)
    throw new Error('Synthetic sign-in failed.');
  return { db, id: signed.data.user.id, email };
}
export async function cookieHeader(db: SupabaseClient<Database>) {
  const session = (await db.auth.getSession()).data.session;
  if (!session) throw new Error('Missing test session');
  const jar = new Map<string, string>();
  const ssr = createServerClient<Database>(localUrl, localKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (values) =>
        values.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const result = await ssr.auth.setSession(session);
  if (result.error) throw result.error;
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}
