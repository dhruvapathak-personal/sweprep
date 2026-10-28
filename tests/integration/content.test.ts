import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentDigest } from '@/lib/content/manifest';
import {
  manifestFor,
  questionBundle,
  syntheticEvidence,
  termBundle,
} from '@/tests/fixtures/content';
import {
  importBundles,
  installBundles,
  installEvidence,
  literal,
  publish,
  release,
  sql,
} from './helpers';

describe('content-only import and publication capabilities', () => {
  it('runs the real candidate-import CLI twice under the importer capability', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sweprep-import-'));
    const path = join(directory, 'manifest.json');
    const serviceFile = join(directory, 'pg_service.conf');
    const bundle = termBundle('cli-candidate-import');
    writeFileSync(path, JSON.stringify(manifestFor([bundle])), { mode: 0o600 });
    writeFileSync(
      serviceFile,
      `[content-test]\nhost=127.0.0.1\nport=54322\ndbname=postgres\nuser=postgres\noptions=-c role=content_importer\n`,
      { mode: 0o600 },
    );
    const run = () =>
      JSON.parse(
        execFileSync(
          process.execPath,
          ['scripts/content-import.ts', 'import', path],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              PGSERVICE: 'content-test',
              PGSERVICEFILE: serviceFile,
              PGOPTIONS: '-c role=content_importer',
            },
          },
        ),
      );
    expect(run().imported).toBe(1);
    expect(run().imported).toBe(0);
    expect(
      sql(
        `select count(*) from private.content_publication_events where candidate_id='${bundle.id}'`,
      ),
    ).toBe('0');
  });
  it('imports candidates repeatably without release and conflicts on digest reuse', () => {
    const bundle = questionBundle('import-replay');
    expect(importBundles([bundle]).imported).toBe(1);
    expect(importBundles([bundle]).imported).toBe(0);
    expect(
      sql(
        `select count(*) from public.question_versions where id='${bundle.id}'`,
      ),
    ).toBe('0');
    const changed = questionBundle(
      bundle.stableId,
      { title: 'Changed immutable text' },
      { id: bundle.id },
    );
    expect(() => importBundles([changed])).toThrow(/VERSION_CONFLICT/);
    expect(() => publish([release(bundle, randomUUID())])).toThrow(
      /QUALIFICATION_REQUIRED/,
    );
    expect(
      sql(
        `select count(*) from private.qualification_runs where candidate_id='${bundle.id}'`,
      ),
    ).toBe('0');
  });
  it('rejects arbitrary approval flags and invalid sources at the direct SQL boundary', () => {
    const bundle = questionBundle('invalid-sql');
    const raw = { ...bundle, approved: true };
    raw.digest = contentDigest(
      Object.fromEntries(
        Object.entries(raw).filter(([key]) => key !== 'digest'),
      ),
    );
    const body = {
      schemaVersion: 1,
      policyVersion: 'content-policy-v1',
      bundles: [raw],
    };
    expect(() =>
      sql(
        `set role content_importer; select private.import_content_manifest(${literal({ ...body, checksum: contentDigest(body) })});`,
      ),
    ).toThrow(/VALIDATION_ERROR/);
    bundle.sources[0].role = 'discovery_context';
    bundle.digest = contentDigest(
      Object.fromEntries(
        Object.entries(bundle).filter(([key]) => key !== 'digest'),
      ),
    );
    expect(() => importBundles([bundle])).toThrow(
      /CORRECTNESS_EVIDENCE_REQUIRED/,
    );
  });
  it('keeps importer, publisher, service-role and learner capabilities disjoint', () => {
    for (const role of [
      'content_importer',
      'content_publisher',
      'service_role',
      'authenticated',
      'anon',
    ]) {
      expect(() =>
        sql(`set role ${role}; select * from private.qualification_runs;`),
      ).toThrow();
      if (role.startsWith('content_'))
        expect(() =>
          sql(`set role ${role}; select answer_text from public.attempts;`),
        ).toThrow();
      expect(() =>
        sql(
          `set role ${role}; insert into private.qualification_runs(id) values(gen_random_uuid());`,
        ),
      ).toThrow();
    }
    for (const role of [
      'content_importer',
      'service_role',
      'authenticated',
      'anon',
    ])
      expect(() =>
        sql(`set role ${role}; select private.publish_content_batch('[]');`),
      ).toThrow();
    expect(() =>
      sql('set role content_publisher; select public.claim_grading();'),
    ).toThrow();
    expect(() =>
      sql('set role content_publisher; select * from private.rubrics;'),
    ).toThrow();
    expect(
      sql(
        "select count(*) from pg_roles where rolname in ('content_engine','content_importer','content_publisher') and (rolsuper or rolcreaterole or rolcreatedb or rolcanlogin or rolbypassrls)",
      ),
    ).toBe('0');
    expect(
      sql(
        "select count(*) from pg_auth_members m join pg_roles r on r.oid=m.roleid join pg_roles u on u.oid=m.member where r.rolname in ('content_engine','content_importer','content_publisher') and u.rolname <> 'postgres'",
      ),
    ).toBe('0');
    expect(
      sql(
        "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname like '%revok%'",
      ),
    ).toBe('0');
  });
  it('fails closed on every missing or conflicting trusted policy result', () => {
    const bundle = questionBundle('qualification-negative');
    importBundles([bundle]);
    const base = syntheticEvidence(bundle);
    const failures = [
      { ...base, bundleDigest: 'a'.repeat(64) },
      { ...base, policyVersion: 'unknown' },
      { ...base, checks: { ...base.checks, rights: 'fail' } },
      { ...base, checks: { ...base.checks, grader: 'fail' } },
      { ...base, criticObjections: ['Unresolved factual objection'] },
      { ...base, criticTask: base.authorTask },
      { ...base, similarity: { ...base.similarity, result: 'quarantine' } },
      { ...base, similarity: { ...base.similarity, threshold: 0.9 } },
      { ...base, execution: { status: 'pass', isolation: 'unsafe' } },
      { ...base, fixtureAuthor: 'human' },
      { ...base, fixtureKinds: ['strong'] },
      { ...base, graderReversals: 1 },
      { ...base, lineageRequestsUsed: 25 },
      { ...base, sourcesDigest: 'a'.repeat(64) },
      { ...base, dependencies: [{ id: randomUUID(), digest: 'a'.repeat(64) }] },
    ];
    for (const evidence of failures) {
      const id = installEvidence(bundle, evidence as typeof base);
      expect(() => publish([release(bundle, id)])).toThrow(
        /QUALIFICATION_REQUIRED/,
      );
    }
    expect(
      sql(
        `select count(*) from private.content_publication_events where candidate_id='${bundle.id}'`,
      ),
    ).toBe('0');
    expect(
      sql(
        `select count(*) from public.question_versions where id='${bundle.id}'`,
      ),
    ).toBe('0');
  });
  it('rolls back a whole import on missing dependencies', () => {
    const good = termBundle('rollback-import');
    const bad = questionBundle(
      'rollback-missing',
      {},
      { dependencies: [{ id: randomUUID(), digest: 'b'.repeat(64) }] },
    );
    expect(() => importBundles([good, bad])).toThrow(/DEPENDENCY_REQUIRED/);
    expect(
      sql(
        `select count(*) from private.content_candidates where id='${good.id}'`,
      ),
    ).toBe('0');
    expect(() =>
      sql(
        `select private.import_content_manifest(${literal({ ...manifestFor([good]), checksum: '0'.repeat(64) })});`,
      ),
    ).toThrow(/VALIDATION_ERROR/);
  });
  it('publishes dependencies atomically, detects injected failure and replays with no new event', () => {
    const term = termBundle('atomic-term');
    const question = questionBundle(
      'atomic-question',
      {
        terms: [
          { termId: term.id, required: true, exposure: 'pre_attempt_safe' },
        ],
      },
      { dependencies: [{ id: term.id, digest: term.digest }] },
    );
    importBundles([term, question]);
    const releases = [term, question].map((bundle) =>
      release(bundle, installEvidence(bundle)),
    );
    expect(() => publish(releases.slice(1))).toThrow(/DEPENDENCY_REQUIRED/);
    sql(`create function private.synthetic_fail_publication() returns trigger language plpgsql as $$ begin if new.candidate_id='${question.id}' then raise exception 'SYNTHETIC_FAILURE'; end if; return new; end $$;
      create trigger synthetic_failure before insert on private.content_publication_events for each row execute function private.synthetic_fail_publication();`);
    try {
      expect(() => publish(releases)).toThrow(/SYNTHETIC_FAILURE/);
    } finally {
      sql(
        'drop trigger synthetic_failure on private.content_publication_events; drop function private.synthetic_fail_publication();',
      );
    }
    expect(
      sql(
        `select count(*) from public.vocabulary_term_versions where id='${term.id}'`,
      ),
    ).toBe('0');
    expect(
      sql(
        `select count(*) from private.rubrics where question_version_id='${question.id}'`,
      ),
    ).toBe('0');
    const revision = publish(releases);
    expect(publish(releases)).toBe(revision);
    expect(
      sql(
        `select count(*) from private.content_publication_events where candidate_id in ('${term.id}','${question.id}')`,
      ),
    ).toBe('2');
    expect(() =>
      sql(
        `update private.content_candidates set origin='seed' where id='${question.id}'`,
      ),
    ).toThrow(/IMMUTABLE_HISTORY/);
    expect(() =>
      sql(
        `update private.qualification_runs set decision='quarantined' where candidate_id='${question.id}'`,
      ),
    ).toThrow(/IMMUTABLE_HISTORY/);
  });
  it('allows exactly one concurrent replacement of the same head', async () => {
    const initial = questionBundle('cas-head');
    installBundles([initial]);
    const second = questionBundle(
      initial.stableId,
      {},
      { version: 2, parentId: initial.id },
    );
    const third = questionBundle(
      initial.stableId,
      {},
      { version: 3, parentId: initial.id },
    );
    importBundles([second, third]);
    const releases = [second, third].map((bundle) =>
      release(bundle, installEvidence(bundle)),
    );
    const run = promisify(execFile);
    const results = await Promise.allSettled(
      releases.map((value) =>
        run('psql', [
          '-X',
          '-w',
          '-q',
          '-v',
          'ON_ERROR_STOP=1',
          '-Atc',
          `set role content_publisher; select private.publish_content_batch(${literal([value])});`,
        ]),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      sql(
        `select count(*) from private.content_publication_events where candidate_id in ('${second.id}','${third.id}')`,
      ),
    ).toBe('1');
  });
});
