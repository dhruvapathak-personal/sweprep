create role content_engine nologin noinherit;
create role content_importer nologin noinherit;
create role content_publisher nologin noinherit;
grant content_engine to postgres;
grant create on schema public, private to content_engine;
grant usage on schema private to content_engine, content_importer, content_publisher;
grant usage on schema public, extensions to content_engine;
create function private.content_user() returns uuid
language sql stable security definer set search_path = '' as $$
  select auth.uid();
$$;
revoke all on function private.content_user() from public, anon, authenticated, service_role;
grant execute on function private.content_user() to content_engine;

alter table public.question_versions
  add column domain text,
  add column category text,
  add column assumptions text,
  add column secondary_skills text[],
  add column prerequisites text[],
  add column difficulty integer check (difficulty between 1 and 5);

create function private.canonical_content(p_value jsonb) returns text
language plpgsql immutable set search_path = '' as $$
begin
  case jsonb_typeof(p_value)
    when 'object' then return '{' || coalesce((select string_agg(to_jsonb(key)::text || ':' || private.canonical_content(value), ',' order by key collate "C") from jsonb_each(p_value)), '') || '}';
    when 'array' then return '[' || coalesce((select string_agg(private.canonical_content(value), ',' order by ordinal) from jsonb_array_elements(p_value) with ordinality as a(value,ordinal)), '') || ']';
    else return p_value::text;
  end case;
end;
$$;
create function private.content_digest(p_value jsonb) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(convert_to(private.canonical_content(p_value), 'UTF8'), 'sha256'), 'hex');
$$;

create table private.content_candidates (
  id uuid primary key,
  kind text not null check (kind in ('question','term')),
  stable_id text not null check (stable_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'),
  version integer not null check (version > 0),
  parent_id uuid references private.content_candidates,
  origin text not null check (origin in ('generation','seed','correction')),
  bundle jsonb not null,
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  imported_at timestamptz not null default now(),
  unique (kind,stable_id,version),
  unique (id,digest),
  check (private.content_digest(bundle - 'digest') = digest)
);
create table private.content_sources (
  candidate_id uuid not null references private.content_candidates,
  id text not null,
  source_role text not null check (source_role in ('discovery_context','correctness_evidence')),
  use_mode text not null check (use_mode in ('reference_only','permitted_reuse')),
  record jsonb not null,
  primary key (candidate_id,id),
  check (record->>'url' ~ '^https://'),
  check (length(record->>'locator') > 0 and length(record->>'edition') > 0 and length(record->>'intendedUse') > 0),
  check ((use_mode = 'reference_only' and record->>'payloadDigest' is null) or
    (use_mode = 'permitted_reuse' and length(record->>'rightsBasis') > 0 and length(record->>'attribution') > 0 and record->>'payloadDigest' ~ '^[a-f0-9]{64}$'))
);
create table private.content_claim_sources (
  candidate_id uuid not null,
  claim text not null check (length(claim) between 1 and 1000),
  source_id text not null,
  primary key (candidate_id,claim,source_id),
  foreign key (candidate_id,source_id) references private.content_sources(candidate_id,id)
);
create table private.qualification_runs (
  id uuid primary key,
  candidate_id uuid not null,
  candidate_digest text not null,
  policy_version text not null check (policy_version = 'content-policy-v1'),
  evidence jsonb not null,
  evidence_digest text not null check (evidence_digest = private.content_digest(evidence)),
  decision text not null check (decision in ('qualified','quarantined','rejected')),
  created_at timestamptz not null default now(),
  foreign key (candidate_id,candidate_digest) references private.content_candidates(id,digest),
  unique (id,candidate_id)
);
create table private.content_publication_events (
  id bigint generated always as identity primary key,
  candidate_id uuid not null unique,
  qualification_id uuid not null,
  expected_head uuid references private.content_candidates,
  event text not null check (event in ('publish','supersede')),
  reason text not null default 'Policy-bound automated qualification',
  actor name not null default session_user,
  published_at timestamptz not null default now(),
  foreign key (qualification_id,candidate_id) references private.qualification_runs(id,candidate_id)
);
create table private.current_content (
  kind text not null,
  stable_id text not null,
  candidate_id uuid not null unique references private.content_candidates,
  event_id bigint not null unique references private.content_publication_events,
  primary key (kind,stable_id)
);
create table private.content_catalog_revision (
  singleton boolean primary key default true check (singleton),
  revision bigint not null default 0
);
insert into private.content_catalog_revision(singleton) values(true);

create table public.vocabulary_terms (
  id text primary key,
  domain text not null
);
create table public.vocabulary_term_versions (
  id uuid primary key references private.content_candidates,
  term_id text not null references public.vocabulary_terms,
  version integer not null check (version > 0),
  title text not null,
  qualification_id uuid not null references private.qualification_runs,
  unique (term_id,version)
);
create table private.vocabulary_definitions (
  term_version_id uuid primary key references public.vocabulary_term_versions,
  definition text not null,
  intuition text not null,
  example text not null
);
create table public.question_terms (
  question_version_id uuid not null references public.question_versions,
  term_version_id uuid not null references public.vocabulary_term_versions,
  required boolean not null,
  exposure text not null check (exposure in ('pre_attempt_safe','post_grade_only')),
  primary key (question_version_id,term_version_id)
);
create table public.vocabulary_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  term_version_id uuid not null references public.vocabulary_term_versions,
  item_id uuid,
  kind text not null check (kind in ('exposure','lookup')),
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  foreign key (item_id,user_id) references public.session_items(id,user_id),
  unique (user_id,idempotency_key),
  check ((kind = 'lookup' and item_id is not null) or (kind = 'exposure' and item_id is null))
);

do $$
declare t text;
begin
  foreach t in array array['content_candidates','content_sources','content_claim_sources','qualification_runs','content_publication_events','vocabulary_definitions'] loop
    execute format('create trigger immutable_content before update or delete on private.%I for each row execute function private.immutable_history()', t);
  end loop;
  foreach t in array array['vocabulary_terms','vocabulary_term_versions','question_terms','vocabulary_events'] loop
    execute format('create trigger immutable_content before update or delete on public.%I for each row execute function private.immutable_history()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
  foreach t in array array['content_candidates','content_sources','content_claim_sources','qualification_runs','content_publication_events','current_content','content_catalog_revision','vocabulary_definitions'] loop
    execute format('alter table private.%I enable row level security', t);
    execute format('revoke all on private.%I from public, anon, authenticated, service_role', t);
    execute format('create policy engine_content on private.%I to content_engine using (true) with check (true)', t);
  end loop;
end;
$$;
grant select,insert on private.content_candidates, private.content_sources, private.content_claim_sources,
  private.content_publication_events, private.vocabulary_definitions to content_engine;
grant select on private.qualification_runs to content_engine;
grant select,insert,update on private.current_content, private.content_catalog_revision to content_engine;
grant usage,select on sequence private.content_publication_events_id_seq to content_engine;
grant select,insert on public.question_versions, private.rubrics, public.vocabulary_terms,
  public.vocabulary_term_versions, public.question_terms to content_engine;
grant select on public.curriculum_skills to content_engine;
create policy engine_questions on public.question_versions to content_engine using(true) with check(true);
create policy engine_rubrics on private.rubrics to content_engine using(true) with check(true);
create policy engine_skills on public.curriculum_skills to content_engine using(true);
create policy engine_terms on public.vocabulary_terms to content_engine using(true) with check(true);
create policy engine_term_versions on public.vocabulary_term_versions to content_engine using(true) with check(true);
create policy engine_links on public.question_terms to content_engine using(true) with check(true);
grant execute on function private.canonical_content(jsonb), private.content_digest(jsonb) to content_engine;

create function private.validate_content_bundle(b jsonb) returns void
language plpgsql set search_path = '' as $$
declare p jsonb := b->'payload'; s jsonb; c jsonb; x jsonb; allowed text[]; k text;
begin
  if jsonb_typeof(b) is distinct from 'object'
    or not b ?& array['id','kind','stableId','version','parentId','origin','sources','claims','dependencies','payload','digest']
    or (b - array['id','kind','stableId','version','parentId','origin','sources','claims','dependencies','payload','digest']) <> '{}'
    or b->>'kind' not in ('question','term') or b->>'origin' not in ('generation','seed','correction')
    or (b->>'version') !~ '^[1-9][0-9]*$'
    or b->>'stableId' !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'
    or private.content_digest(b - 'digest') is distinct from b->>'digest'
    or jsonb_typeof(b->'sources') is distinct from 'array' or jsonb_array_length(b->'sources') not between 1 and 30
    or jsonb_typeof(b->'claims') is distinct from 'array' or jsonb_array_length(b->'claims') not between 1 and 30
    or jsonb_typeof(b->'dependencies') is distinct from 'array' or jsonb_array_length(b->'dependencies') > 30
    or jsonb_typeof(p) is distinct from 'object' or octet_length(b::text) > 100000
    then raise exception 'VALIDATION_ERROR'; end if;
  foreach k in array array['id','kind','stableId','origin','digest'] loop
    if jsonb_typeof(b->k) is distinct from 'string' then raise exception 'VALIDATION_ERROR'; end if;
  end loop;
  if jsonb_typeof(b->'version') is distinct from 'number'
    or jsonb_typeof(b->'parentId') not in ('null','string') then raise exception 'VALIDATION_ERROR'; end if;
  perform (b->>'id')::uuid, (b->>'parentId')::uuid;
  foreach k in array array['title','domain'] loop
    if jsonb_typeof(p->k) is distinct from 'string' then raise exception 'VALIDATION_ERROR'; end if;
  end loop;
  if p->>'domain' is null or p->>'domain' not in ('cpp','python','algorithms','systems','performance','networking','distributed','engineering')
    or length(p->>'title') not between 1 and 200 then raise exception 'VALIDATION_ERROR'; end if;
  for s in select value from jsonb_array_elements(b->'sources') loop
    foreach k in array array['id','role','url','locator','edition','accessedAt','intendedUse','useMode'] loop
      if jsonb_typeof(s->k) is distinct from 'string' then raise exception 'VALIDATION_ERROR'; end if;
    end loop;
    foreach k in array array['rightsBasis','attribution','payloadDigest'] loop
      if jsonb_typeof(s->k) not in ('null','string') then raise exception 'VALIDATION_ERROR'; end if;
    end loop;
    if not s ?& array['id','role','url','locator','edition','accessedAt','intendedUse','useMode','rightsBasis','attribution','payloadDigest']
      or (s - array['id','role','url','locator','edition','accessedAt','intendedUse','useMode','rightsBasis','attribution','payloadDigest']) <> '{}'
      or s->>'role' not in ('discovery_context','correctness_evidence')
      or s->>'useMode' not in ('reference_only','permitted_reuse')
      or not coalesce(s->>'url' ~ '^https://[^/]+',false)
      or not coalesce(length(s->>'id') between 1 and 100 and length(s->>'locator') between 1 and 1000
        and length(s->>'edition') between 1 and 200 and length(s->>'intendedUse') between 1 and 1000,false)
      then raise exception 'VALIDATION_ERROR'; end if;
    perform (s->>'accessedAt')::timestamptz;
    if (s->>'useMode' = 'reference_only' and s->>'payloadDigest' is not null)
      or (s->>'useMode' = 'permitted_reuse' and not coalesce(length(s->>'rightsBasis') > 0 and length(s->>'attribution') > 0 and s->>'payloadDigest' ~ '^[a-f0-9]{64}$',false))
      then raise exception 'REUSE_RIGHTS_REQUIRED'; end if;
  end loop;
  for c in select value from jsonb_array_elements(b->'claims') loop
    if jsonb_typeof(c->'claim') is distinct from 'string' then raise exception 'VALIDATION_ERROR'; end if;
    if not c ?& array['claim','sourceIds'] or c - array['claim','sourceIds'] <> '{}'
      or not coalesce(length(c->>'claim') between 1 and 1000,false)
      or jsonb_typeof(c->'sourceIds') is distinct from 'array' or jsonb_array_length(c->'sourceIds') not between 1 and 20
      then raise exception 'VALIDATION_ERROR'; end if;
    for x in select value from jsonb_array_elements(c->'sourceIds') loop
      if jsonb_typeof(x) is distinct from 'string' then raise exception 'VALIDATION_ERROR'; end if;
      if not exists(select 1 from jsonb_array_elements(b->'sources') v where v->>'id' = x#>>'{}' and v->>'role' = 'correctness_evidence')
        then raise exception 'CORRECTNESS_EVIDENCE_REQUIRED'; end if;
    end loop;
  end loop;
  if b->>'kind' = 'question' then
    foreach k in array array['category','skillId','skill','assumptions','promptVersion'] loop
      if jsonb_typeof(p->k) is distinct from 'string' then raise exception 'VALIDATION_ERROR'; end if;
    end loop;
    if jsonb_typeof(p->'difficulty') is distinct from 'number' then raise exception 'VALIDATION_ERROR'; end if;
    allowed := array['title','domain','category','skillId','skill','secondarySkills','assumptions','prerequisites','difficulty','blocks','promptVersion','rubric','terms'];
    if not p ?& allowed or p - allowed <> '{}'
      or p->>'category' not in ('Explain','Predict','Debug','Compare','Design','Critique')
      or not coalesce(length(p->>'skill') between 1 and 100 and length(p->>'assumptions') between 1 and 2000,false)
      or not exists(select 1 from public.curriculum_skills where id = p->>'skillId')
      or (p->>'difficulty') !~ '^[1-5]$'
      or jsonb_typeof(p->'secondarySkills') is distinct from 'array' or jsonb_array_length(p->'secondarySkills') > 10
      or jsonb_typeof(p->'prerequisites') is distinct from 'array' or jsonb_array_length(p->'prerequisites') > 20
      or jsonb_typeof(p->'blocks') is distinct from 'array' or jsonb_array_length(p->'blocks') not between 1 and 20
      or octet_length((p->'blocks')::text) >= 20000
      or not coalesce(length(p->>'promptVersion') between 1 and 100,false)
      or jsonb_typeof(p->'terms') is distinct from 'array' or jsonb_array_length(p->'terms') > 20
      then raise exception 'VALIDATION_ERROR'; end if;
    for x in select value from jsonb_array_elements(p->'blocks') loop
      if jsonb_typeof(x->'type') is distinct from 'string' or jsonb_typeof(x->'text') is distinct from 'string'
        then raise exception 'VALIDATION_ERROR'; end if;
      if not coalesce(length(x->>'text') <= 10000,false) or x->>'type' not in ('text','code')
        or (x->>'type' = 'text' and (not x ?& array['type','text'] or x - array['type','text'] <> '{}'))
        or (x->>'type' = 'code' and (not x ?& array['type','language','text'] or x - array['type','language','text'] <> '{}' or jsonb_typeof(x->'language') is distinct from 'string' or x->>'language' not in ('cpp','python','text')))
        then raise exception 'VALIDATION_ERROR'; end if;
    end loop;
    for x in select value from jsonb_array_elements((p->'secondarySkills') || (p->'prerequisites')) loop
      if jsonb_typeof(x) is distinct from 'string' or not exists(select 1 from public.curriculum_skills where id = x#>>'{}')
        then raise exception 'DEPENDENCY_REQUIRED'; end if;
    end loop;
    x := p->'rubric';
    if jsonb_typeof(x) is distinct from 'object' or jsonb_typeof(x->'version') is distinct from 'string'
      or jsonb_typeof(x->'referenceAnswer') is distinct from 'string' or jsonb_typeof(x->'passScore') is distinct from 'number'
      then raise exception 'VALIDATION_ERROR'; end if;
    if not x ?& array['version','passScore','requiredClaims','referenceAnswer'] or x - array['version','passScore','requiredClaims','referenceAnswer'] <> '{}'
      or not coalesce(length(x->>'version') between 1 and 100 and length(x->>'referenceAnswer') between 1 and 10000,false)
      or (x->>'passScore') !~ '^[1-5]$' or jsonb_typeof(x->'requiredClaims') is distinct from 'array'
      or jsonb_array_length(x->'requiredClaims') not between 1 and 20 then raise exception 'VALIDATION_ERROR'; end if;
    for x in select value from jsonb_array_elements(p->'rubric'->'requiredClaims') loop
      if not exists(select 1 from jsonb_array_elements(b->'claims') v where v->>'claim' = x#>>'{}') then raise exception 'CORRECTNESS_EVIDENCE_REQUIRED'; end if;
    end loop;
    for x in select value from jsonb_array_elements(p->'terms') loop
      if jsonb_typeof(x->'termId') is distinct from 'string' or jsonb_typeof(x->'exposure') is distinct from 'string'
        then raise exception 'VALIDATION_ERROR'; end if;
      if not x ?& array['termId','required','exposure'] or x - array['termId','required','exposure'] <> '{}'
        or jsonb_typeof(x->'required') is distinct from 'boolean' or x->>'exposure' not in ('pre_attempt_safe','post_grade_only')
        or not exists(select 1 from jsonb_array_elements(b->'dependencies') d where d->>'id' = x->>'termId')
        then raise exception 'DEPENDENCY_REQUIRED'; end if;
    end loop;
  else
    foreach k in array array['definition','intuition','example'] loop
      if jsonb_typeof(p->k) is distinct from 'string' then raise exception 'VALIDATION_ERROR'; end if;
    end loop;
    allowed := array['title','domain','definition','intuition','example'];
    if not p ?& allowed or p - allowed <> '{}'
      or not coalesce(length(p->>'definition') between 1 and 5000 and length(p->>'intuition') between 1 and 5000 and length(p->>'example') between 1 and 5000,false)
      then raise exception 'VALIDATION_ERROR'; end if;
  end if;
end;
$$;
grant execute on function private.validate_content_bundle(jsonb) to content_engine;

create function private.import_content_manifest(p_manifest jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare b jsonb; s jsonb; c jsonb; d jsonb; existing private.content_candidates; count_new integer := 0;
begin
  if jsonb_typeof(p_manifest) is distinct from 'object'
    or not p_manifest ?& array['schemaVersion','policyVersion','bundles','checksum']
    or p_manifest - array['schemaVersion','policyVersion','bundles','checksum'] <> '{}'
    or p_manifest->>'schemaVersion' is distinct from '1' or p_manifest->>'policyVersion' is distinct from 'content-policy-v1'
    or jsonb_typeof(p_manifest->'bundles') is distinct from 'array' or jsonb_array_length(p_manifest->'bundles') not between 1 and 10
    or octet_length(p_manifest::text) > 1000000
    or private.content_digest(p_manifest - 'checksum') is distinct from p_manifest->>'checksum'
    then raise exception 'VALIDATION_ERROR'; end if;
  perform pg_catalog.pg_advisory_xact_lock(813400);
  for b in select value from jsonb_array_elements(p_manifest->'bundles') loop
    perform private.validate_content_bundle(b);
    select * into existing from private.content_candidates where id = (b->>'id')::uuid
      or (kind = b->>'kind' and stable_id = b->>'stableId' and version = (b->>'version')::integer);
    if found then
      if existing.id <> (b->>'id')::uuid or existing.digest <> b->>'digest' then raise exception 'VERSION_CONFLICT'; end if;
      continue;
    end if;
    if b->>'parentId' is not null and not exists(select 1 from private.content_candidates
      where id = (b->>'parentId')::uuid and kind = b->>'kind' and stable_id = b->>'stableId' and version < (b->>'version')::integer)
      then raise exception 'DEPENDENCY_REQUIRED'; end if;
    for d in select value from jsonb_array_elements(b->'dependencies') loop
      if not d ?& array['id','digest'] or d - array['id','digest'] <> '{}'
        or not exists(select 1 from private.content_candidates where id = (d->>'id')::uuid and digest = d->>'digest')
        then raise exception 'DEPENDENCY_REQUIRED'; end if;
    end loop;
    insert into private.content_candidates(id,kind,stable_id,version,parent_id,origin,bundle,digest)
      values((b->>'id')::uuid,b->>'kind',b->>'stableId',(b->>'version')::integer,(b->>'parentId')::uuid,b->>'origin',b,b->>'digest');
    for s in select value from jsonb_array_elements(b->'sources') loop
      insert into private.content_sources values((b->>'id')::uuid,s->>'id',s->>'role',s->>'useMode',s);
    end loop;
    for c in select value from jsonb_array_elements(b->'claims') loop
      insert into private.content_claim_sources select (b->>'id')::uuid,c->>'claim',value from jsonb_array_elements_text(c->'sourceIds');
    end loop;
    count_new := count_new + 1;
  end loop;
  return jsonb_build_object('imported',count_new,'checksum',p_manifest->>'checksum','qualification','not performed');
end;
$$;
alter function private.import_content_manifest(jsonb) owner to content_engine;
revoke all on function private.import_content_manifest(jsonb) from public, anon, authenticated, service_role;
grant execute on function private.import_content_manifest(jsonb) to content_importer;

create function private.passing_qualification(p_candidate uuid, p_run uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from private.qualification_runs r join private.content_candidates c on c.id = r.candidate_id
    where r.id = p_run and c.id = p_candidate and r.candidate_digest = c.digest and r.decision = 'qualified'
      and r.policy_version = 'content-policy-v1' and r.evidence_digest = private.content_digest(r.evidence)
      and r.evidence->>'bundleDigest' = c.digest
      and r.evidence->>'policyVersion' = r.policy_version
      and r.evidence->>'modelVersion' <> '' and r.evidence->>'promptVersion' <> ''
      and r.evidence->>'toolchainVersion' <> '' and r.evidence->>'fixtureVersion' <> ''
      and r.evidence->'checks' = '{"schema":"pass","rights":"pass","claims":"pass","duplicates":"pass","critic":"pass","fixtures":"pass","grader":"pass","links":"pass","privacy":"pass"}'::jsonb
      and r.evidence->'criticObjections' = '[]'::jsonb
      and r.evidence->>'authorTask' <> r.evidence->>'criticTask'
      and length(r.evidence->>'authorTask') > 0 and length(r.evidence->>'criticTask') > 0
      and r.evidence->'similarity' = '{"version":"jaccard-v1","threshold":0.85,"result":"clear"}'::jsonb
      and r.evidence->'dependencies' = c.bundle->'dependencies'
      and r.evidence->'sourcesDigest' = to_jsonb(private.content_digest(c.bundle->'sources'))
      and (r.evidence->'execution'->>'status' = 'pass' and r.evidence->'execution'->>'isolation' = 'network-disabled-v1'
        or r.evidence->'execution'->>'status' = 'not_applicable' and length(r.evidence->'execution'->>'reason') > 0)
      and (r.evidence->>'requestsUsed') ~ '^[1-9][0-9]*$'
      and (r.evidence->>'requestsUsed')::integer <= case when c.kind = 'question' then 12 else 3 end
      and (r.evidence->>'lineageRequestsUsed') ~ '^[1-9][0-9]*$'
      and (r.evidence->>'lineageRequestsUsed')::integer <= case when c.kind = 'question' then 24 else 6 end
      and (c.kind = 'term' or r.evidence->'fixtureKinds' = '["wrong","partial","borderline_pass","strong","ambiguous"]'::jsonb
        and r.evidence->>'fixtureAuthor' = 'machine' and r.evidence->>'graderReversals' = '0' and r.evidence->>'outOfRange' = '0')
  );
$$;
grant execute on function private.passing_qualification(uuid,uuid) to content_engine;

create function private.publish_content_batch(p_releases jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare release jsonb; c private.content_candidates; p jsonb;
  head uuid; event_id bigint; d jsonb; link jsonb; revision bigint; changed boolean := false;
begin
  if jsonb_typeof(p_releases) is distinct from 'array' or jsonb_array_length(p_releases) not between 1 and 10 then raise exception 'VALIDATION_ERROR'; end if;
  select cr.revision into revision from private.content_catalog_revision cr for update;
  for release in select value from jsonb_array_elements(p_releases) loop
    if not release ?& array['candidateId','digest','qualificationId','expectedHead']
      or release - array['candidateId','digest','qualificationId','expectedHead'] <> '{}' then raise exception 'VALIDATION_ERROR'; end if;
    select * into c from private.content_candidates where id = (release->>'candidateId')::uuid;
    if not found or c.digest is distinct from release->>'digest' then raise exception 'VERSION_CONFLICT'; end if;
    perform private.validate_content_bundle(c.bundle);
    if not private.passing_qualification(c.id,(release->>'qualificationId')::uuid) then raise exception 'QUALIFICATION_REQUIRED'; end if;
    if exists(select 1 from private.content_publication_events e where e.candidate_id = c.id) then
      if not exists(select 1 from private.content_publication_events e where e.candidate_id = c.id
        and e.qualification_id = (release->>'qualificationId')::uuid and e.expected_head is not distinct from (release->>'expectedHead')::uuid)
        then raise exception 'VERSION_CONFLICT'; end if;
      continue;
    end if;
    select candidate_id into head from private.current_content where kind = c.kind and stable_id = c.stable_id;
    if head is distinct from (release->>'expectedHead')::uuid or head is distinct from c.parent_id then raise exception 'CONTENT_CHANGED'; end if;
    for d in select value from jsonb_array_elements(c.bundle->'dependencies') loop
      if not exists(select 1 from private.content_candidates dc join private.current_content h on h.candidate_id = dc.id
        join private.content_publication_events e on e.id = h.event_id
        where dc.id = (d->>'id')::uuid and dc.digest = d->>'digest' and private.passing_qualification(dc.id,e.qualification_id))
        then raise exception 'DEPENDENCY_REQUIRED'; end if;
    end loop;
    p := c.bundle->'payload';
    if c.kind = 'term' then
      if exists(select 1 from public.vocabulary_terms where id = c.stable_id and domain <> p->>'domain') then raise exception 'VERSION_CONFLICT'; end if;
      insert into public.vocabulary_terms(id,domain) values(c.stable_id,p->>'domain') on conflict do nothing;
      insert into public.vocabulary_term_versions(id,term_id,version,title,qualification_id)
        values(c.id,c.stable_id,c.version,p->>'title',(release->>'qualificationId')::uuid);
      insert into private.vocabulary_definitions values(c.id,p->>'definition',p->>'intuition',p->>'example');
    else
      insert into public.question_versions(id,question_id,version,title,skill,skill_id,content_blocks,content_review,prompt_version,
        domain,category,assumptions,secondary_skills,prerequisites,difficulty)
        values(c.id,c.stable_id,c.version,p->>'title',p->>'skill',p->>'skillId',p->'blocks','approved',p->>'promptVersion',
          p->>'domain',p->>'category',p->>'assumptions',array(select jsonb_array_elements_text(p->'secondarySkills')),
          array(select jsonb_array_elements_text(p->'prerequisites')),(p->>'difficulty')::integer);
      insert into private.rubrics(question_version_id,version,pass_score,required_claims,reference_answer)
        values(c.id,p->'rubric'->>'version',(p->'rubric'->>'passScore')::integer,
          array(select jsonb_array_elements_text(p->'rubric'->'requiredClaims')),p->'rubric'->>'referenceAnswer');
      for link in select value from jsonb_array_elements(p->'terms') loop
        insert into public.question_terms values(c.id,(link->>'termId')::uuid,(link->>'required')::boolean,link->>'exposure');
      end loop;
    end if;
    insert into private.content_publication_events(candidate_id,qualification_id,expected_head,event)
      values(c.id,(release->>'qualificationId')::uuid,head,case when head is null then 'publish' else 'supersede' end) returning id into event_id;
    insert into private.current_content values(c.kind,c.stable_id,c.id,event_id)
      on conflict(kind,stable_id) do update set candidate_id = excluded.candidate_id,event_id = excluded.event_id;
    changed := true;
  end loop;
  if changed then update private.content_catalog_revision set revision = content_catalog_revision.revision + 1 returning content_catalog_revision.revision into revision; end if;
  return revision;
end;
$$;
alter function private.publish_content_batch(jsonb) owner to content_engine;
revoke all on function private.publish_content_batch(jsonb) from public, anon, authenticated, service_role;
grant execute on function private.publish_content_batch(jsonb) to content_publisher;

create function public.content_is_qualified(p_id uuid, p_current boolean default false) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from private.content_publication_events e
    where e.candidate_id = p_id and private.passing_qualification(p_id,e.qualification_id)
      and (not p_current or exists(select 1 from private.current_content h where h.candidate_id = p_id)));
$$;
alter function public.content_is_qualified(uuid,boolean) owner to content_engine;
revoke all on function public.content_is_qualified(uuid,boolean) from public, anon;
grant execute on function public.content_is_qualified(uuid,boolean) to authenticated, service_role;

drop policy signed_in_questions on public.question_versions;
create policy eligible_questions on public.question_versions for select to authenticated using (
  public.content_is_qualified(id,true) or exists(select 1 from public.session_items i where i.question_version_id = question_versions.id and i.user_id = (select auth.uid()))
);
create policy current_terms on public.vocabulary_terms for select to authenticated using (
  exists(select 1 from public.vocabulary_term_versions v where v.term_id = vocabulary_terms.id and public.content_is_qualified(v.id,true))
);
create policy current_term_versions on public.vocabulary_term_versions for select to authenticated using (public.content_is_qualified(id,true));
create policy safe_owned_links on public.question_terms for select to authenticated using (
  exposure = 'pre_attempt_safe' and exists(select 1 from public.session_items i where i.question_version_id = question_terms.question_version_id and i.user_id = (select auth.uid()))
);
create policy own_vocabulary_events on public.vocabulary_events for select to authenticated using(user_id = (select auth.uid()));
grant select on public.vocabulary_terms, public.vocabulary_term_versions, public.question_terms, public.vocabulary_events to authenticated;

create function public.content_catalog(p_kind text, p_domain text default null, p_category text default null, p_cursor text default null, p_limit integer default 20) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare revision bigint; cursor_value jsonb; after_id text := ''; rows jsonb; next_cursor text; last_id text;
begin
  if private.content_user() is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_kind is null or p_kind not in ('question','term') or p_limit is null or p_limit not between 1 and 50
    or p_domain is not null and p_domain not in ('cpp','python','algorithms','systems','performance','networking','distributed','engineering')
    or p_category is not null and p_category not in ('Explain','Predict','Debug','Compare','Design','Critique')
    then raise exception 'VALIDATION_ERROR'; end if;
  select cr.revision into revision from private.content_catalog_revision cr for share;
  if p_cursor is not null then
    begin
      if length(p_cursor) > 2000 then raise exception 'VALIDATION_ERROR'; end if;
      cursor_value := convert_from(decode(p_cursor,'base64'),'UTF8')::jsonb;
      if not cursor_value ?& array['revision','kind','domain','category','after']
        or cursor_value - array['revision','kind','domain','category','after'] <> '{}'
        or cursor_value->>'kind' is distinct from p_kind or cursor_value->>'domain' is distinct from p_domain or cursor_value->>'category' is distinct from p_category
        or cursor_value->>'after' is null then raise exception 'VALIDATION_ERROR'; end if;
    exception when others then raise exception 'VALIDATION_ERROR'; end;
    if cursor_value->>'revision' is distinct from revision::text then raise exception 'CATALOG_CHANGED'; end if;
    after_id := cursor_value->>'after';
  end if;
  select coalesce(jsonb_agg(row order by stable_id collate "C"),'[]') into rows from (
    select c.stable_id,jsonb_build_object('id',c.id,'stableId',c.stable_id,'version',c.version,'title',c.bundle->'payload'->>'title',
      'domain',c.bundle->'payload'->>'domain','category',c.bundle->'payload'->>'category','qualificationPolicy','content-policy-v1','uncalibrated',true) as row
    from private.current_content h join private.content_candidates c on c.id = h.candidate_id
    join private.content_publication_events e on e.id = h.event_id
    where c.kind = p_kind and c.stable_id collate "C" > after_id collate "C"
      and (p_domain is null or c.bundle->'payload'->>'domain' = p_domain)
      and (p_category is null or c.bundle->'payload'->>'category' = p_category)
      and private.passing_qualification(c.id,e.qualification_id)
    order by c.stable_id collate "C" limit p_limit + 1
  ) page;
  if jsonb_array_length(rows) > p_limit then
    rows := rows - p_limit;
    last_id := rows->(p_limit-1)->>'stableId';
    next_cursor := replace(encode(convert_to(jsonb_build_object('revision',revision::text,'kind',p_kind,'domain',p_domain,'category',p_category,'after',last_id)::text,'UTF8'),'base64'), E'\n','');
  end if;
  return jsonb_build_object('entries',rows,'catalogRevision',revision::text,'nextCursor',next_cursor);
end;
$$;
alter function public.content_catalog(text,text,text,text,integer) owner to content_engine;
revoke all on function public.content_catalog(text,text,text,text,integer) from public, anon, service_role;
grant execute on function public.content_catalog(text,text,text,text,integer) to authenticated;

create function public.item_vocabulary(p_item uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare question uuid;
begin
  select question_version_id into question from public.session_items where id = p_item and user_id = auth.uid();
  if not found then raise exception 'FORBIDDEN'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',v.id,'title',v.title) order by v.title)
    from public.question_terms l join public.vocabulary_term_versions v on v.id = l.term_version_id
    where l.question_version_id = question and l.exposure = 'pre_attempt_safe' and public.content_is_qualified(v.id)), '[]');
end;
$$;
create function public.lookup_vocabulary(p_item uuid, p_term uuid, p_key uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare item public.session_items; event public.vocabulary_events;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_key is null or p_term is null then raise exception 'VALIDATION_ERROR'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text || p_key::text,2));
  select * into item from public.session_items where id = p_item and user_id = auth.uid() for update;
  if not found then raise exception 'FORBIDDEN'; end if;
  select * into event from public.vocabulary_events where user_id = auth.uid() and idempotency_key = p_key;
  if found then
    if event.kind <> 'lookup' or event.item_id is distinct from p_item or event.term_version_id <> p_term then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  else
    if item.state <> 'answering' then raise exception 'ALREADY_SUBMITTED'; end if;
    if not exists(select 1 from public.question_terms where question_version_id = item.question_version_id and term_version_id = p_term and exposure = 'pre_attempt_safe')
      or not public.content_is_qualified(p_term) or not public.content_is_qualified(item.question_version_id) then raise exception 'FORBIDDEN'; end if;
    update public.session_items set assisted = true, version = version + case when assisted then 0 else 1 end where id = p_item;
    insert into public.vocabulary_events(user_id,term_version_id,item_id,kind,idempotency_key) values(auth.uid(),p_term,p_item,'lookup',p_key);
  end if;
  return (select jsonb_build_object('id',v.id,'title',v.title,'definition',d.definition,'intuition',d.intuition,'example',d.example)
    from public.vocabulary_term_versions v join private.vocabulary_definitions d on d.term_version_id = v.id where v.id = p_term);
end;
$$;
revoke all on function public.item_vocabulary(uuid), public.lookup_vocabulary(uuid,uuid,uuid) from public, anon, service_role;
grant execute on function public.item_vocabulary(uuid), public.lookup_vocabulary(uuid,uuid,uuid) to authenticated;
create function public.record_vocabulary_exposure(p_term uuid, p_key uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare event public.vocabulary_events; result uuid;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_key is null or p_term is null then raise exception 'VALIDATION_ERROR'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text || p_key::text,2));
  select * into event from public.vocabulary_events where user_id = auth.uid() and idempotency_key = p_key;
  if found then
    if event.kind <> 'exposure' or event.term_version_id <> p_term then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return event.id;
  end if;
  if not public.content_is_qualified(p_term,true) or not exists(select 1 from public.vocabulary_term_versions where id = p_term) then raise exception 'FORBIDDEN'; end if;
  insert into public.vocabulary_events(user_id,term_version_id,kind,idempotency_key)
    values(auth.uid(),p_term,'exposure',p_key) returning id into result;
  return result;
end;
$$;
revoke all on function public.record_vocabulary_exposure(uuid,uuid) from public, anon, service_role;
grant execute on function public.record_vocabulary_exposure(uuid,uuid) to authenticated;
revoke create on schema public, private from content_engine;
revoke content_engine from postgres;
