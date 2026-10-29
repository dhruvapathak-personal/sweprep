create role qualification_engine nologin noinherit;
create role qualification_operator nologin noinherit;
create role qualification_worker nologin noinherit;
grant qualification_engine to postgres;
grant usage on schema private to qualification_engine, qualification_operator, qualification_worker;
grant usage on schema public, extensions to qualification_engine;
grant create on schema private to qualification_engine;

create table private.qualification_batches (
  id uuid primary key default gen_random_uuid(),
  configuration jsonb not null,
  digest text not null check (digest = private.content_digest(configuration)),
  actor name not null default session_user,
  created_at timestamptz not null default now()
);
create table private.qualification_inputs (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null unique references private.content_candidates,
  batch_id uuid not null references private.qualification_batches,
  lineage uuid not null,
  run_number integer not null check (run_number between 1 and 2),
  evidence jsonb not null,
  fingerprint text not null,
  actor name not null default session_user,
  enqueued_at timestamptz not null default now(),
  unique(lineage,run_number)
);
create table private.qualification_jobs (
  id uuid primary key references private.qualification_inputs,
  state text not null default 'queued' check (state in ('queued','running','qualified','quarantined','rejected')),
  lease uuid,
  lease_until timestamptz,
  reason text,
  qualification_id uuid references private.qualification_runs,
  updated_at timestamptz not null default now()
);
create table private.qualification_checks (
  job_id uuid primary key references private.qualification_jobs,
  result jsonb not null,
  digest text not null check (digest = private.content_digest(result))
);
alter table private.provider_requests
  alter column attempt_id drop not null,
  alter column generation drop not null,
  add column qualification_job uuid references private.qualification_jobs,
  add column task text,
  add column qualification_prompt jsonb,
  add column worker_lease uuid,
  add column repair boolean not null default false,
  add constraint provider_request_owner check (
    (attempt_id is not null and generation is not null and qualification_job is null and task is null)
    or (attempt_id is null and generation is null and qualification_job is not null and task is not null and worker_lease is not null)
  ),
  add unique(qualification_job,task,ordinal);
create table private.qualification_artifacts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references private.qualification_jobs,
  task text not null,
  request_id uuid unique references private.provider_requests,
  input_digest text not null,
  output jsonb,
  error text,
  actor name not null default session_user,
  created_at timestamptz not null default now(),
  check (octet_length(output::text) <= 64000)
);
create unique index qualification_task_result on private.qualification_artifacts(job_id,task) where error is null;

do $$
declare t text;
begin
  foreach t in array array['qualification_batches','qualification_inputs','qualification_jobs','qualification_checks','qualification_artifacts'] loop
    execute format('alter table private.%I enable row level security',t);
    execute format('revoke all on private.%I from public, anon, authenticated, service_role',t);
    execute format('create policy qualification_engine_only on private.%I to qualification_engine using(true) with check(true)',t);
    execute format('grant select,insert on private.%I to qualification_engine',t);
    if t <> 'qualification_jobs' then
      execute format('create trigger immutable_qualification before update or delete on private.%I for each row execute function private.immutable_history()',t);
    end if;
  end loop;
end;
$$;
create function private.qualification_yield(p_job uuid,p_lease uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ordinal integer;
begin
  perform 1 from private.qualification_jobs where id=p_job and state='running' and lease=p_lease and lease_until>now() for update;
  if not found then raise exception 'STALE_LEASE'; end if;
  if p_reason not in ('BUDGET_EXCEEDED','QUALIFICATION_DISABLED','REQUEST_LIMIT','INPUT_TOO_LARGE') or p_reason is null then raise exception 'VALIDATION_ERROR'; end if;
  select run_number into ordinal from private.qualification_inputs where id=p_job;
  update private.qualification_jobs set state=case when p_reason in ('REQUEST_LIMIT','INPUT_TOO_LARGE') then case when ordinal=1 then 'quarantined' else 'rejected' end else 'queued' end,
    reason=p_reason,lease=null,lease_until=null,updated_at=now() where id=p_job;
  return private.qualification_context(p_job);
end;
$$;
grant update on private.qualification_jobs to qualification_engine;
grant select on private.content_candidates,private.qualification_runs to qualification_engine;
grant insert on private.qualification_runs to qualification_engine;
create policy qualification_read_candidates on private.content_candidates to qualification_engine using(true);
create policy qualification_receipts on private.qualification_runs to qualification_engine using(true) with check(true);
grant execute on function private.canonical_content(jsonb), private.content_digest(jsonb), private.validate_content_bundle(jsonb), private.passing_qualification(uuid,uuid) to qualification_engine;
grant select on public.curriculum_skills to qualification_engine;
create policy qualification_skills on public.curriculum_skills to qualification_engine using(true);

create function private.qualification_open_batch(p_configuration jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare id uuid; key text;
begin
  if jsonb_typeof(p_configuration) is distinct from 'object'
    or not p_configuration ?& array['policyVersion','modelVersion','promptVersion','schemaVersion','fixtureVersion','graderVersion','gradingPromptVersion','gradingSchemaVersion','toolchainVersion','modelEvaluationDigest','privacyApprovalDigest','deploymentApprovalDigest','providerConfigurationDigest','enabled','publicationEnabled','requestCents','dailyCap','monthlyCap','batchCap','expiresAt']
    or p_configuration - array['policyVersion','modelVersion','promptVersion','schemaVersion','fixtureVersion','graderVersion','gradingPromptVersion','gradingSchemaVersion','toolchainVersion','modelEvaluationDigest','privacyApprovalDigest','deploymentApprovalDigest','providerConfigurationDigest','enabled','publicationEnabled','requestCents','dailyCap','monthlyCap','batchCap','expiresAt'] <> '{}'
    or p_configuration->>'policyVersion' is distinct from 'content-policy-v1'
    or p_configuration->>'modelVersion' is distinct from 'gpt-5.4-mini-2026-03-17'
    or p_configuration->>'promptVersion' is distinct from 'qualification-prompts-v1'
    or p_configuration->>'schemaVersion' is distinct from 'qualification-schema-v1'
    or p_configuration->>'fixtureVersion' is distinct from 'machine-fixtures-v1'
    or p_configuration->>'graderVersion' is distinct from 'grader-v1'
    or p_configuration->>'gradingPromptVersion' is distinct from 'grade-prompt-v1'
    or p_configuration->>'gradingSchemaVersion' is distinct from 'grade-schema-v1'
    or p_configuration->>'enabled' is distinct from 'true'
    or p_configuration->>'publicationEnabled' is distinct from 'false'
    or p_configuration->>'requestCents' is distinct from '10'
    or not coalesce((p_configuration->>'dailyCap')::integer between 1 and 100,false)
    or not coalesce((p_configuration->>'monthlyCap')::integer between 1 and 2000,false)
    or not coalesce((p_configuration->>'batchCap')::integer between 1 and 2000,false)
    or not coalesce(length(p_configuration->>'toolchainVersion') between 1 and 200,false)
    or not coalesce((p_configuration->>'expiresAt')::timestamptz > now(),false)
    or not coalesce(p_configuration->>'modelEvaluationDigest' ~ '^[a-f0-9]{64}$',false)
    or not coalesce(p_configuration->>'privacyApprovalDigest' ~ '^[a-f0-9]{64}$',false)
    or not coalesce(p_configuration->>'deploymentApprovalDigest' ~ '^[a-f0-9]{64}$',false)
    or not coalesce(p_configuration->>'providerConfigurationDigest' ~ '^[a-f0-9]{64}$',false)
    then raise exception 'QUALIFICATION_DISABLED'; end if;
  foreach key in array array['enabled','publicationEnabled'] loop
    if jsonb_typeof(p_configuration->key) is distinct from 'boolean' then raise exception 'QUALIFICATION_DISABLED'; end if;
  end loop;
  foreach key in array array['requestCents','dailyCap','monthlyCap','batchCap'] loop
    if jsonb_typeof(p_configuration->key) is distinct from 'number' then raise exception 'QUALIFICATION_DISABLED'; end if;
  end loop;
  insert into private.qualification_batches(configuration,digest)
    values(p_configuration,private.content_digest(p_configuration)) returning qualification_batches.id into id;
  return id;
end;
$$;

create function private.qualification_enqueue(p_candidate uuid,p_batch uuid,p_evidence jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare c private.content_candidates; previous private.qualification_inputs; existing private.qualification_inputs;
  id uuid := gen_random_uuid(); root uuid; ordinal integer := 1; fingerprint text; configuration jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(813401);
  select * into c from private.content_candidates where content_candidates.id = p_candidate;
  if not found then raise exception 'CANDIDATE_REQUIRED'; end if;
  select b.configuration into configuration from private.qualification_batches b where b.id = p_batch;
  if not found or (configuration->>'expiresAt')::timestamptz <= now() then raise exception 'QUALIFICATION_DISABLED'; end if;
  if jsonb_typeof(p_evidence) is distinct from 'array' or jsonb_array_length(p_evidence) > 30
    or octet_length(p_evidence::text) > 300000 then raise exception 'VALIDATION_ERROR'; end if;
  fingerprint := private.content_digest(jsonb_build_object('candidate',c.digest,'configuration',configuration,'evidence',p_evidence));
  select * into existing from private.qualification_inputs where candidate_id = p_candidate;
  if found then
    if existing.fingerprint = fingerprint then return existing.id; end if;
    raise exception 'IMMUTABLE_REVISION_REQUIRED';
  end if;
  root := c.id;
  select i.* into previous from private.qualification_inputs i where i.candidate_id = c.parent_id;
  if found then
    if previous.run_number <> 1 or not exists(select 1 from private.qualification_jobs j where j.id = previous.id and j.state = 'quarantined')
      then raise exception 'LINEAGE_EXHAUSTED'; end if;
    if previous.batch_id = p_batch then raise exception 'IMMUTABLE_REVISION_REQUIRED'; end if;
    if not exists(select 1 from private.content_candidates old where old.id = c.parent_id and old.kind=c.kind and old.stable_id=c.stable_id)
      then raise exception 'VERSION_CONFLICT'; end if;
    root := previous.lineage;
    ordinal := 2;
  elsif exists(select 1 from private.qualification_inputs i join private.content_candidates old on old.id=i.candidate_id
    where old.kind=c.kind and old.stable_id=c.stable_id) then raise exception 'LINEAGE_EXHAUSTED';
  end if;
  insert into private.qualification_inputs(id,candidate_id,batch_id,lineage,run_number,evidence,fingerprint)
    values(id,c.id,p_batch,root,ordinal,p_evidence,fingerprint);
  insert into private.qualification_jobs(id) values(id);
  return id;
end;
$$;

create function private.qualification_precheck(p_job uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare c private.content_candidates; evidence jsonb; s jsonb; e jsonb; d jsonb; reasons text[] := '{}'; duplicate uuid; similarity numeric;
begin
  select candidate.* into c from private.content_candidates candidate join private.qualification_inputs i on i.candidate_id=candidate.id where i.id=p_job;
  select i.evidence into evidence from private.qualification_inputs i where i.id=p_job;
  begin perform private.validate_content_bundle(c.bundle);
  exception when others then reasons := array_append(reasons,'SCHEMA_INVALID'); end;
  if (c.bundle::text || evidence::text) ~* '(-----BEGIN[^-]*PRIVATE KEY|sk-[a-z0-9]{20,}|AKIA[A-Z0-9]{16}|password[[:space:]]*[:=])'
    then reasons := array_append(reasons,'PRIVATE_MATERIAL'); end if;
  for s in select value from jsonb_array_elements(c.bundle->'sources') where value->>'role'='correctness_evidence' loop
    select value into e from jsonb_array_elements(evidence) where value->>'sourceId'=s->>'id';
    if e is null then reasons := array_append(reasons,'EVIDENCE_MISSING'); continue; end if;
    if e->>'url' is distinct from s->>'url' or e->>'edition' is distinct from s->>'edition' or e->>'locator' is distinct from s->>'locator'
      or not e ?& array['sourceId','url','edition','locator','authority','permissionBasis','provenance','text','digest']
      or e - array['sourceId','url','edition','locator','authority','permissionBasis','provenance','text','digest'] <> '{}'
      or jsonb_typeof(e->'text') is distinct from 'string'
      or not coalesce(e->>'authority' in ('standard','official_documentation','original_paper'),false)
      or not coalesce(length(e->>'permissionBasis') between 1 and 2000 and length(e->>'provenance') between 1 and 2000,false)
      or not coalesce(length(e->>'text') between 1 and 10000,false)
      or not coalesce(e->>'digest'=encode(extensions.digest(convert_to(e->>'text','UTF8'),'sha256'),'hex'),false)
      then reasons := array_append(reasons,'EVIDENCE_UNVERIFIED'); end if;
    if s->>'useMode'='permitted_reuse' and (e->>'digest' is distinct from s->>'payloadDigest'
      or not coalesce(length(s->>'rightsBasis')>0 and length(s->>'attribution')>0,false))
      then reasons := array_append(reasons,'REUSE_RIGHTS_REQUIRED'); end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(evidence) x where not exists(select 1 from jsonb_array_elements(c.bundle->'sources') source_record where source_record->>'id'=x->>'sourceId' and source_record->>'role'='correctness_evidence'))
    or (select count(*) from jsonb_array_elements(evidence)) <> (select count(distinct x->>'sourceId') from jsonb_array_elements(evidence) x)
    then reasons := array_append(reasons,'SOURCE_ROLE_INVALID'); end if;
  for d in select value from jsonb_array_elements(c.bundle->'dependencies') loop
    if not exists(select 1 from private.content_candidates dc join private.qualification_runs r on r.candidate_id=dc.id
      where dc.id=(d->>'id')::uuid and dc.digest=d->>'digest' and private.passing_qualification(dc.id,r.id))
      then reasons := array_append(reasons,'DEPENDENCY_UNQUALIFIED'); end if;
  end loop;
  with tokens as (
    select distinct token from regexp_split_to_table(lower((c.bundle->'payload')::text),'[^[:alnum:]_]+') token where token<>''
  ), comparisons as (
    select other.id, (select count(*)::numeric from tokens a join
      (select distinct token from regexp_split_to_table(lower((other.bundle->'payload')::text),'[^[:alnum:]_]+') token where token<>'') b using(token)) /
      greatest(1,(select count(*) from (select token from tokens union select token from regexp_split_to_table(lower((other.bundle->'payload')::text),'[^[:alnum:]_]+') token where token<>'') all_tokens)) as score
    from private.content_candidates other where other.kind=c.kind and other.stable_id<>c.stable_id
  ) select id,score into duplicate,similarity from comparisons where score>=0.85 order by score desc,id limit 1;
  if found then reasons:=array_append(reasons,'DUPLICATE_CONTENT'); end if;
  return jsonb_build_object('reasons',to_jsonb(reasons),'candidateDigest',c.digest,'evidenceDigest',private.content_digest(evidence),
    'similarity',jsonb_build_object('version','jaccard-v1','threshold',0.85,'match',duplicate,'score',similarity),
    'proofLimits','Execution and machine consistency do not establish universal correctness, absence of undefined behavior, all schedules, or calibrated readiness.');
end;
$$;

create function private.qualification_stage(p_job uuid) returns text
language plpgsql stable set search_path = '' as $$
declare kind text; stage text;
begin
  select c.kind into kind from private.qualification_inputs i join private.content_candidates c on c.id=i.candidate_id where i.id=p_job;
  foreach stage in array case when kind='question' then array['source','execution','fixtures','critic','evaluate_wrong','evaluate_partial','evaluate_borderline_pass','evaluate_strong','evaluate_ambiguous']
    else array['source','execution','critic'] end loop
    if not exists(select 1 from private.qualification_artifacts a where a.job_id=p_job and a.task=stage and a.error is null) then return stage; end if;
  end loop;
  return 'finish';
end;
$$;

create function private.qualification_context(p_job uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id',j.id,'lease',j.lease,'state',j.state,'reason',j.reason,'stage',private.qualification_stage(j.id),
    'candidate',c.bundle,'evidence',i.evidence,'configuration',b.configuration,'configurationDigest',b.digest,
    'check',ch.result,'runNumber',i.run_number,
    'dependencies',coalesce((select jsonb_agg(dc.bundle) from jsonb_array_elements(c.bundle->'dependencies') d join private.content_candidates dc on dc.id=(d->>'id')::uuid),'[]'),
    'artifacts',coalesce((select jsonb_object_agg(a.task,a.output) from private.qualification_artifacts a where a.job_id=j.id and a.error is null),'{}'),
    'invalidTasks',coalesce((select jsonb_agg(distinct a.task) from private.qualification_artifacts a where a.job_id=j.id and a.error='INVALID_OUTPUT'),'[]'),
    'requestsUsed',(select count(*) from private.provider_requests r where r.qualification_job=j.id))
  from private.qualification_jobs j join private.qualification_inputs i on i.id=j.id
    join private.content_candidates c on c.id=i.candidate_id join private.qualification_batches b on b.id=i.batch_id
    left join private.qualification_checks ch on ch.job_id=j.id where j.id=p_job;
$$;
create function private.qualification_claim(p_job uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j private.qualification_jobs; result jsonb; ordinal integer;
begin
  select q.* into j from private.qualification_jobs q
    where (p_job is null or q.id=p_job) and (q.state='queued' or q.state='running' and q.lease_until<now())
    order by q.updated_at,q.id for update skip locked limit 1;
  if not found then return null; end if;
  if not exists(select 1 from private.qualification_checks where job_id=j.id) then
    result:=private.qualification_precheck(j.id);
    insert into private.qualification_checks values(j.id,result,private.content_digest(result));
  else select ch.result into result from private.qualification_checks ch where job_id=j.id;
  end if;
  select run_number into ordinal from private.qualification_inputs where id=j.id;
  if jsonb_array_length(result->'reasons')>0 then
    update private.qualification_jobs set state=case when ordinal=1 then 'quarantined' else 'rejected' end,
      reason=result->'reasons'->>0,updated_at=now() where id=j.id;
  else
    update private.qualification_jobs set state='running',lease=gen_random_uuid(),lease_until=now()+interval '90 seconds',updated_at=now() where id=j.id;
  end if;
  return private.qualification_context(j.id);
end;
$$;

create function private.qualification_reserve_cost(p_job uuid,p_lease uuid,p_task text,p_repair boolean,p_prompt jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare j private.qualification_jobs; i private.qualification_inputs; configuration jsonb; kind text; used integer; total integer; task_count integer;
  day_cost integer; month_cost integer; batch_cost integer; id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(461920);
  select * into j from private.qualification_jobs where qualification_jobs.id=p_job for update;
  if not found or j.state<>'running' or j.lease is distinct from p_lease or j.lease_until<=now() then raise exception 'STALE_LEASE'; end if;
  if p_task is distinct from private.qualification_stage(p_job) or p_task in ('execution','finish') or p_repair is null then raise exception 'STAGE_CONFLICT'; end if;
  if jsonb_typeof(p_prompt) is distinct from 'object' or octet_length(p_prompt::text)>64000
    or not p_prompt ?& array['input','instructions','schema','modelVersion','promptVersion','schemaVersion']
    then raise exception 'VALIDATION_ERROR'; end if;
  select * into i from private.qualification_inputs where qualification_inputs.id=p_job;
  select b.configuration into configuration from private.qualification_batches b where b.id=i.batch_id;
  select c.kind into kind from private.content_candidates c where c.id=i.candidate_id;
  if (configuration->>'expiresAt')::timestamptz<=now() then raise exception 'QUALIFICATION_DISABLED'; end if;
  if p_prompt->>'modelVersion' is distinct from configuration->>'modelVersion'
    or p_prompt->>'promptVersion' is distinct from configuration->>'promptVersion'
    or p_prompt->>'schemaVersion' is distinct from configuration->>'schemaVersion' then raise exception 'QUALIFICATION_DISABLED'; end if;
  select count(*),count(*) filter(where task=p_task) into used,task_count from private.provider_requests where qualification_job=p_job;
  select count(*) into total from private.provider_requests r join private.qualification_inputs qi on qi.id=r.qualification_job where qi.lineage=i.lineage;
  if used>=(case when kind='question' then 12 else 3 end) or total>=(case when kind='question' then 24 else 6 end) or task_count>=3
    or p_repair is distinct from exists(select 1 from private.qualification_artifacts where job_id=p_job and task=p_task and error='INVALID_OUTPUT')
    or p_repair and exists(select 1 from private.provider_requests where qualification_job=p_job and task=p_task and repair)
    then raise exception 'REQUEST_LIMIT'; end if;
  select coalesce(sum(coalesce(actual_cents,reserved_cents)) filter(where created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),0),
    coalesce(sum(coalesce(actual_cents,reserved_cents)),0) into day_cost,month_cost from private.provider_requests
    where created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC';
  select coalesce(sum(coalesce(r.actual_cents,r.reserved_cents)),0) into batch_cost from private.provider_requests r join private.qualification_inputs qi on qi.id=r.qualification_job where qi.batch_id=i.batch_id;
  if day_cost+10>(configuration->>'dailyCap')::integer or month_cost+10>(configuration->>'monthlyCap')::integer
    or batch_cost+10>(configuration->>'batchCap')::integer then raise exception 'BUDGET_EXCEEDED'; end if;
  insert into private.provider_requests(qualification_job,task,worker_lease,ordinal,reserved_cents,repair,qualification_prompt)
    values(p_job,p_task,p_lease,task_count+1,10,p_repair,p_prompt) returning provider_requests.id into id;
  update private.qualification_jobs set lease_until=now()+interval '90 seconds',updated_at=now() where qualification_jobs.id=p_job;
  return id;
end;
$$;

create or replace function private.require_qualified_provider_content() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.attempt_id is not null then
    if not exists(select 1 from public.attempts a where a.id=new.attempt_id and public.content_is_qualified(a.question_version_id))
      then raise exception 'QUALIFICATION_REQUIRED'; end if;
  end if;
  return new;
end;
$$;
create or replace function public.settle_provider_request(p_request uuid,p_cents integer,p_usage jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if octet_length(p_usage::text)>2000 then raise exception 'VALIDATION_ERROR'; end if;
  update private.provider_requests set actual_cents=p_cents,usage=p_usage where id=p_request and actual_cents is null and qualification_job is null;
end;
$$;

create function private.qualification_complete(p_job uuid,p_lease uuid,p_task text,p_request uuid,p_output jsonb,p_error text,p_cents integer,p_usage jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j private.qualification_jobs; request private.provider_requests; context jsonb; ordinal integer;
begin
  select * into j from private.qualification_jobs where id=p_job for update;
  if not found or j.state<>'running' or j.lease is distinct from p_lease or j.lease_until<=now() then raise exception 'STALE_LEASE'; end if;
  if exists(select 1 from private.qualification_artifacts where request_id=p_request and p_request is not null) then return private.qualification_context(p_job); end if;
  if p_task is distinct from private.qualification_stage(p_job) or p_task='finish'
    or octet_length(p_output::text)>64000 or octet_length(p_usage::text)>2000
    or p_error is not null and p_error not in ('CHECK_FAILED','INVALID_OUTPUT','PROVIDER_TIMEOUT','PROVIDER_REJECTED','EXECUTOR_UNAVAILABLE','EXECUTION_FAILED','INPUT_TOO_LARGE')
    then raise exception 'VALIDATION_ERROR'; end if;
  if p_task='execution' then
    if p_request is not null or p_cents is not null then raise exception 'VALIDATION_ERROR'; end if;
  else
    select * into request from private.provider_requests where id=p_request and qualification_job=p_job and task=p_task and worker_lease=p_lease;
    if not found then raise exception 'REQUEST_REQUIRED'; end if;
    if p_cents is not null then
      update private.provider_requests set actual_cents=p_cents,usage=p_usage where id=p_request and actual_cents is null;
    end if;
  end if;
  context:=private.qualification_context(p_job);
  insert into private.qualification_artifacts(job_id,task,request_id,input_digest,output,error)
    values(p_job,p_task,p_request,private.content_digest(coalesce(request.qualification_prompt,context)),p_output,p_error);
  if p_error in ('CHECK_FAILED','PROVIDER_REJECTED','EXECUTOR_UNAVAILABLE','EXECUTION_FAILED','INPUT_TOO_LARGE')
    or p_error='INVALID_OUTPUT' and request.repair
    or p_error is not null and (select count(*) from private.provider_requests where qualification_job=p_job and task=p_task)>=3 then
    select run_number into ordinal from private.qualification_inputs where id=p_job;
    update private.qualification_jobs set state=case when ordinal=1 then 'quarantined' else 'rejected' end,reason=p_error,lease=null,lease_until=null,updated_at=now() where id=p_job;
  else
    update private.qualification_jobs set lease_until=now()+interval '90 seconds',updated_at=now() where id=p_job;
  end if;
  return private.qualification_context(p_job);
end;
$$;

create function private.qualification_finish(p_job uuid,p_lease uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j private.qualification_jobs; i private.qualification_inputs; c private.content_candidates; configuration jsonb; artifacts jsonb;
  source jsonb; critic jsonb; fixtures jsonb; execution jsonb; check_claim jsonb; claim jsonb; fixture jsonb; grade jsonb; link jsonb; finding jsonb;
  reasons text[]:='{}'; used integer; lineage_used integer; receipt jsonb; qualification uuid; source_task uuid; critic_task uuid; fixture_task uuid;
begin
  select * into j from private.qualification_jobs where id=p_job for update;
  if found and j.state='qualified' and j.lease is not distinct from p_lease then return private.qualification_context(p_job); end if;
  if not found or j.state<>'running' or j.lease is distinct from p_lease or j.lease_until<=now() then raise exception 'STALE_LEASE'; end if;
  if private.qualification_stage(p_job)<>'finish' then raise exception 'STAGE_CONFLICT'; end if;
  perform pg_catalog.pg_advisory_xact_lock(813400);
  select * into i from private.qualification_inputs where id=p_job;
  select * into c from private.content_candidates where id=i.candidate_id;
  select b.configuration into configuration from private.qualification_batches b where b.id=i.batch_id;
  if (configuration->>'expiresAt')::timestamptz<=now() then
    return private.qualification_yield(p_job,p_lease,'QUALIFICATION_DISABLED');
  end if;
  select coalesce(jsonb_object_agg(task,output),'{}') into artifacts from private.qualification_artifacts where job_id=p_job and error is null;
  for finding in select value from jsonb_array_elements(private.qualification_precheck(p_job)->'reasons') loop
    reasons:=array_append(reasons,finding#>>'{}');
  end loop;
  source:=artifacts->'source'; critic:=artifacts->'critic'; execution:=artifacts->'execution'; fixtures:=artifacts->'fixtures'->'cases';
  if source->'issues' is distinct from '[]'::jsonb or source->>'privacy' is distinct from 'public'
    or source->>'originality' is distinct from 'original' then reasons:=array_append(reasons,'SOURCE_CHECK_FAILED'); end if;
  for claim in select value from jsonb_array_elements(c.bundle->'claims') loop
    select value into check_claim from jsonb_array_elements(source->'claims') x where x->>'claim'=claim->>'claim';
    if check_claim is null or check_claim->>'verdict' is distinct from 'supported'
      or not exists(select 1 from jsonb_array_elements_text(claim->'sourceIds') sid where sid=check_claim->>'sourceId')
      or not exists(select 1 from jsonb_array_elements(i.evidence) e where e->>'sourceId'=check_claim->>'sourceId'
        and length(check_claim->>'quote')>0 and position(check_claim->>'quote' in e->>'text')>0)
      then reasons:=array_append(reasons,'CLAIM_UNSUPPORTED'); end if;
  end loop;
  if critic->'objections' is distinct from '[]'::jsonb or critic->>'privacy' is distinct from 'public'
    or critic->>'originality' is distinct from 'original' or not coalesce(length(critic->>'independentAnswer')>0,false)
    or jsonb_typeof(critic->'proofLimits') is distinct from 'array' or jsonb_array_length(critic->'proofLimits')<1
    then reasons:=array_append(reasons,'CRITIC_OBJECTION'); end if;
  if execution->>'status'='not_applicable' then
    if source->>'executionRequired' is distinct from 'false' or exists(select 1 from jsonb_array_elements(c.bundle->'payload'->'blocks') b where b->>'type'='code')
      or not coalesce(length(execution->>'reason')>0,false) then reasons:=array_append(reasons,'EXECUTION_REQUIRED'); end if;
  elsif execution->>'status'='executed' then
    if execution->>'isolation' is distinct from 'network-disabled-v1' or execution->>'toolchainVersion' is distinct from configuration->>'toolchainVersion'
      or execution->>'cpuSeconds' is distinct from '5' or execution->>'wallSeconds' is distinct from '10'
      or execution->>'memoryBytes' is distinct from '268435456' or execution->>'outputBytes' is distinct from '65536'
      or execution->>'readOnly' is distinct from 'true' or execution->>'credentialFree' is distinct from 'true'
      or jsonb_typeof(execution->'results') is distinct from 'array' or jsonb_array_length(execution->'results')<1
      then reasons:=array_append(reasons,'ISOLATION_UNVERIFIED'); end if;
    for finding in select value from jsonb_array_elements(execution->'results') loop
      if finding->>'exitCode' is distinct from '0' or finding->>'stdout' is distinct from
        (select plan->>'expectedStdout' from jsonb_array_elements(source->'executionPlan') plan where plan->>'blockIndex'=finding->>'blockIndex')
        then reasons:=array_append(reasons,'EXECUTION_FAILED'); end if;
    end loop;
    if (select count(*) from jsonb_array_elements(source->'executionPlan')) <> (select count(distinct x->>'blockIndex') from jsonb_array_elements(execution->'results') x)
      then reasons:=array_append(reasons,'EXECUTION_INCOMPLETE'); end if;
  else reasons:=array_append(reasons,'EXECUTION_REQUIRED');
  end if;
  if c.kind='question' then
    if jsonb_array_length(fixtures) is distinct from 5 or
      (select jsonb_agg(kind order by kind) from (select distinct x->>'kind' kind from jsonb_array_elements(fixtures) x) kinds)
      is distinct from '["ambiguous","borderline_pass","partial","strong","wrong"]'::jsonb
      then reasons:=array_append(reasons,'FIXTURES_INVALID'); end if;
    for fixture in select value from jsonb_array_elements(fixtures) loop
      grade:=artifacts->('evaluate_'||(fixture->>'kind'));
      if not coalesce(length(fixture->>'reason')>0 and length(fixture->>'answer')>0,false)
        or not exists(select 1 from jsonb_array_elements(critic->'fixtures') f where f->>'kind'=fixture->>'kind' and f->>'verdict'='supported')
        then reasons:=array_append(reasons,'FIXTURE_UNSUPPORTED'); end if;
      if fixture->>'kind'='ambiguous' then
        if fixture->>'expected' is distinct from 'uncertain' or grade->>'outcome' is distinct from 'uncertain'
          or fixture->>'minScore' is not null or fixture->>'maxScore' is not null or fixture->>'expectedPass' is not null
          then reasons:=array_append(reasons,'GRADER_MISMATCH'); end if;
      else
        if fixture->>'expected' is distinct from 'scored' or grade->>'outcome' is distinct from 'scored'
          or not coalesce((grade->>'score')::integer between (fixture->>'minScore')::integer and (fixture->>'maxScore')::integer,false)
          or ((grade->>'score')::integer >= (c.bundle->'payload'->'rubric'->>'passScore')::integer and (grade->>'criticalClaimsMet')::boolean)
            is distinct from (fixture->>'expectedPass')::boolean
          or (fixture->>'kind' in ('wrong','partial')) is distinct from (fixture->>'expectedPass'='false')
          then reasons:=array_append(reasons,'GRADER_MISMATCH'); end if;
      end if;
    end loop;
    for link in select value from jsonb_array_elements(c.bundle->'payload'->'terms') loop
      select value into finding from jsonb_array_elements(critic->'links') x where x->>'termId'=link->>'termId';
      if finding is null or finding->>'exposure' is distinct from link->>'exposure'
        or finding->>'verdict' is distinct from (case when link->>'exposure'='pre_attempt_safe' then 'safe' else 'post_grade_only' end)
        then reasons:=array_append(reasons,'SPOILER_LINK'); end if;
    end loop;
  end if;
  if cardinality(reasons)>0 then
    update private.qualification_jobs set state=case when i.run_number=1 then 'quarantined' else 'rejected' end,reason=reasons[1],lease=null,lease_until=null,updated_at=now() where id=p_job;
    return private.qualification_context(p_job);
  end if;
  select count(*) into used from private.provider_requests where qualification_job=p_job;
  select count(*) into lineage_used from private.provider_requests r join private.qualification_inputs qi on qi.id=r.qualification_job where qi.lineage=i.lineage;
  select id into source_task from private.qualification_artifacts where job_id=p_job and task='source' and error is null;
  select id into critic_task from private.qualification_artifacts where job_id=p_job and task='critic' and error is null;
  select id into fixture_task from private.qualification_artifacts where job_id=p_job and task='fixtures' and error is null;
  receipt:=jsonb_build_object('bundleDigest',c.digest,'policyVersion','content-policy-v1','modelVersion',configuration->>'modelVersion',
    'graderVersion',configuration->>'graderVersion','gradingPromptVersion',configuration->>'gradingPromptVersion','gradingSchemaVersion',configuration->>'gradingSchemaVersion',
    'promptVersion',configuration->>'promptVersion','toolchainVersion',configuration->>'toolchainVersion','fixtureVersion',configuration->>'fixtureVersion',
    'checks','{"schema":"pass","rights":"pass","claims":"pass","duplicates":"pass","critic":"pass","fixtures":"pass","grader":"pass","links":"pass","privacy":"pass"}'::jsonb,
    'criticObjections','[]'::jsonb,'authorTask',source_task,'criticTask',critic_task,'fixtureAuthorTask',fixture_task,
    'similarity','{"version":"jaccard-v1","threshold":0.85,"result":"clear"}'::jsonb,
    'dependencies',c.bundle->'dependencies','sourcesDigest',private.content_digest(c.bundle->'sources'),
    'execution',case when execution->>'status'='executed' then jsonb_build_object('status','pass','isolation','network-disabled-v1')
      else jsonb_build_object('status','not_applicable','reason',execution->>'reason') end,
    'requestsUsed',used,'lineageRequestsUsed',lineage_used,
    'fixtureKinds',case when c.kind='question' then '["wrong","partial","borderline_pass","strong","ambiguous"]'::jsonb else '[]'::jsonb end,
    'fixtureAuthor','machine','graderReversals',0,'outOfRange',0,
    'applicability',case when c.kind='term' then 'Term-only: question fixtures and learner grading are not applicable.' else 'Five machine-authored consistency fixtures; not human gold or model-release evaluation.' end,
    'inputFingerprint',i.fingerprint,'configurationDigest',private.content_digest(configuration),'evidenceDigest',private.content_digest(i.evidence),
    'artifactDigest',private.content_digest(artifacts),'jobId',p_job);
  qualification:=gen_random_uuid();
  insert into private.qualification_runs(id,candidate_id,candidate_digest,policy_version,evidence,evidence_digest,decision)
    values(qualification,c.id,c.digest,'content-policy-v1',receipt,private.content_digest(receipt),'qualified');
  update private.qualification_jobs set state='qualified',qualification_id=qualification,updated_at=now() where id=p_job;
  return private.qualification_context(p_job);
end;
$$;

do $$
declare signature text;
begin
  foreach signature in array array[
    'qualification_open_batch(jsonb)','qualification_enqueue(uuid,uuid,jsonb)',
    'qualification_precheck(uuid)','qualification_stage(uuid)','qualification_context(uuid)','qualification_reserve_cost(uuid,uuid,text,boolean,jsonb)',
    'qualification_claim(uuid)','qualification_yield(uuid,uuid,text)','qualification_complete(uuid,uuid,text,uuid,jsonb,text,integer,jsonb)','qualification_finish(uuid,uuid)'
  ] loop
    execute 'alter function private.'||signature||' owner to qualification_engine';
    execute 'revoke all on function private.'||signature||' from public,anon,authenticated,service_role';
  end loop;
end;
$$;
grant execute on function private.qualification_open_batch(jsonb),private.qualification_enqueue(uuid,uuid,jsonb) to qualification_operator;
grant execute on function private.qualification_claim(uuid),private.qualification_complete(uuid,uuid,text,uuid,jsonb,text,integer,jsonb),
  private.qualification_finish(uuid,uuid),private.qualification_yield(uuid,uuid,text) to qualification_worker;
revoke all on function private.qualification_reserve_cost(uuid,uuid,text,boolean,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.qualification_reserve_cost(uuid,uuid,text,boolean,jsonb) to qualification_worker;
grant select,insert,update on private.provider_requests to qualification_engine;
create policy qualification_cost_totals on private.provider_requests for select to qualification_engine using(true);
create policy qualification_cost_reservations on private.provider_requests for insert to qualification_engine with check(qualification_job is not null);
create policy qualification_cost_settlement on private.provider_requests for update to qualification_engine using(qualification_job is not null) with check(qualification_job is not null);
revoke create on schema private from qualification_engine;
revoke qualification_engine from postgres;
