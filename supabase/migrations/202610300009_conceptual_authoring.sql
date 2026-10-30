create role authoring_engine nologin noinherit;
create role authoring_operator nologin noinherit;
create role authoring_worker nologin noinherit;
grant authoring_engine,qualification_engine to postgres;
grant usage on schema private,extensions to authoring_engine;
grant usage on schema private to authoring_operator,authoring_worker;
grant create on schema private to authoring_engine,qualification_engine;

create table private.authoring_inputs (
  id uuid primary key,
  candidate_id uuid not null unique default gen_random_uuid(),
  parent_id uuid,
  version integer not null,
  lineage uuid not null,
  run_number integer not null check(run_number between 1 and 2),
  batch_id uuid not null references private.qualification_batches,
  plan jsonb not null check(octet_length(plan::text)<=300000),
  digest text not null check(digest=private.content_digest(plan)),
  scope text not null,
  actor name not null default session_user,
  created_at timestamptz not null default now(),
  unique(lineage,run_number),
  unique(scope,run_number)
);
create table private.authoring_jobs (
  id uuid primary key references private.authoring_inputs,
  state text not null default 'queued' check(state in ('queued','running','authored','quarantined','rejected')),
  lease uuid,
  lease_until timestamptz,
  reason text,
  updated_at timestamptz not null default now()
);
alter table private.provider_requests
  add column authoring_run uuid references private.authoring_inputs,
  drop constraint provider_request_owner,
  add constraint provider_request_owner check(
    (attempt_id is not null and generation is not null and qualification_job is null and evaluation_run is null and authoring_run is null and task is null)
    or (attempt_id is null and generation is null and qualification_job is not null and evaluation_run is null and authoring_run is null and task is not null and worker_lease is not null)
    or (attempt_id is null and generation is null and qualification_job is null and evaluation_run is not null and authoring_run is null and task is not null and worker_lease is not null)
    or (attempt_id is null and generation is null and qualification_job is null and evaluation_run is null and authoring_run is not null and task='author' and worker_lease is not null)
  ),
  add unique(authoring_run,ordinal);
create table private.authoring_artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references private.authoring_inputs,
  request_id uuid not null unique references private.provider_requests,
  bundle jsonb check(octet_length(bundle::text)<=100000),
  error text,
  created_at timestamptz not null default now()
);
create unique index authoring_success on private.authoring_artifacts(run_id) where error is null;
do $$
declare t text;
begin
  foreach t in array array['authoring_inputs','authoring_jobs','authoring_artifacts'] loop
    execute format('alter table private.%I enable row level security',t);
    execute format('revoke all on private.%I from public,anon,authenticated,service_role',t);
    execute format('grant select,insert on private.%I to authoring_engine',t);
    execute format('grant select on private.%I to qualification_engine',t);
    execute format('create policy authoring_engine_only on private.%I to authoring_engine using(true) with check(true)',t);
    execute format('create policy qualification_authoring_read on private.%I for select to qualification_engine using(true)',t);
    if t<>'authoring_jobs' then
      execute format('create trigger immutable_authoring before update or delete on private.%I for each row execute function private.immutable_history()',t);
    end if;
  end loop;
end;
$$;
grant update on private.authoring_jobs to authoring_engine;
grant select on public.curriculum_skills to authoring_engine;
create policy authoring_skills_read on public.curriculum_skills for select to authoring_engine using(true);
grant select on private.qualification_batches,private.qualification_inputs,private.qualification_jobs,
  private.content_candidates,private.qualification_runs to authoring_engine;
create policy authoring_batches_read on private.qualification_batches for select to authoring_engine using(true);
create policy authoring_qualification_read on private.qualification_inputs for select to authoring_engine using(true);
create policy authoring_jobs_read on private.qualification_jobs for select to authoring_engine using(true);
create policy authoring_candidates_read on private.content_candidates for select to authoring_engine using(true);
create policy authoring_receipts_read on private.qualification_runs for select to authoring_engine using(true);
grant execute on function private.content_digest(jsonb),private.canonical_content(jsonb),
  private.validate_content_bundle(jsonb),private.calibrated_rubric_v2(jsonb),private.passing_qualification(uuid,uuid) to authoring_engine;
grant select,insert,update on private.provider_requests to authoring_engine;
create policy authoring_cost_totals on private.provider_requests for select to authoring_engine using(true);
create policy authoring_cost_insert on private.provider_requests for insert to authoring_engine with check(authoring_run is not null);
create policy authoring_cost_update on private.provider_requests for update to authoring_engine using(authoring_run is not null) with check(authoring_run is not null);

create function private.authoring_open(p_plan jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare spec jsonb:=p_plan->'spec'; config jsonb; previous private.authoring_inputs;
  existing private.authoring_inputs; run uuid:=(spec->>'id')::uuid; candidate uuid:=gen_random_uuid();
  root uuid; parent uuid; version integer:=1; ordinal integer:=1; v_scope text; d jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(813401);
  select configuration into config from private.qualification_batches where id=(spec->>'batchId')::uuid;
  if not found or config->>'policyVersion' is distinct from 'content-policy-v2'
    or config->>'toolchainVersion' is distinct from 'conceptual-no-execution-v1'
    or (config->>'expiresAt')::timestamptz<=now()
    or spec->'authorization'->>'promptVersion' is distinct from 'conceptual-authoring-prompts-v1'
    or spec->'authorization'->>'schemaVersion' is distinct from 'conceptual-authoring-schema-v1'
    or not coalesce(spec->'authorization'->>'runAuthorizationDigest' ~ '^[a-f0-9]{64}$',false)
    or spec->'authorization'->>'codeDigest' is distinct from p_plan->'code'->>'digest'
    or p_plan->'code'->>'digest' is distinct from private.content_digest(p_plan->'code'->'files')
    or not coalesce(spec->>'kind' in ('question','term'),false)
    or not coalesce(spec->>'stableId' ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$',false)
    or not coalesce(length(spec->>'coverage') between 1 and 2000,false)
    or not p_plan ?& array['spec','code','requests'] or p_plan-array['spec','code','requests']<>'{}'
    or octet_length(p_plan::text)>300000 then raise exception 'AUTHORING_DISABLED'; end if;
  if (spec::text) ~* '(-----BEGIN[^-]*PRIVATE KEY|sk-[a-z0-9]{20,}|AKIA[A-Z0-9]{16}|password[[:space:]]*[:=])'
    then raise exception 'AUTHORING_INPUT_INVALID'; end if;
  foreach d in array array[p_plan->'requests'->'original',p_plan->'requests'->'repair'] loop
    if jsonb_typeof(d) is distinct from 'object' or d->>'model' is distinct from config->>'modelVersion'
      or d->>'store' is distinct from 'false' or d->>'max_output_tokens' is distinct from '3000'
      or d ? 'tools' or octet_length(d::text)>64000 then raise exception 'AUTHORING_INPUT_INVALID'; end if;
  end loop;
  for d in select value from jsonb_array_elements(spec->'dependencies') loop
    if d->>'kind'<>'term' or not exists(select 1 from private.content_candidates c join private.qualification_runs q on q.candidate_id=c.id
      where c.id=(d->>'id')::uuid and c.bundle=d and private.passing_qualification(c.id,q.id))
      then raise exception 'DEPENDENCY_UNQUALIFIED'; end if;
  end loop;
  v_scope:=private.content_digest(jsonb_build_object('kind',spec->>'kind','domain',spec->>'domain','skillId',spec->>'skillId',
    'coverage',lower(regexp_replace(btrim(spec->>'coverage'),'[[:space:]]+',' ','g')),
    'evidence',(select jsonb_agg(e-array['sourceId','provenance','permissionBasis'] order by e->>'digest') from jsonb_array_elements(spec->'evidence') e),
    'dependencies',(select jsonb_agg(x.value->'payload' order by private.content_digest(x.value->'payload')) from jsonb_array_elements(spec->'dependencies') x(value))));
  select * into existing from private.authoring_inputs where id=run;
  if found then
    if existing.digest<>private.content_digest(p_plan) then raise exception 'IMMUTABLE_REVISION_REQUIRED'; end if;
    return existing.id;
  end if;
  root:=candidate;
  if spec->>'revisionOf' is not null then
    select * into previous from private.authoring_inputs where id=(spec->>'revisionOf')::uuid;
    if not found or previous.run_number<>1 or previous.batch_id=(spec->>'batchId')::uuid
      or previous.plan->'spec'->>'kind' is distinct from spec->>'kind'
      or previous.plan->'spec'->>'stableId' is distinct from spec->>'stableId'
      or not (exists(select 1 from private.authoring_jobs where id=previous.id and state='quarantined')
        or exists(select 1 from private.qualification_inputs i join private.qualification_jobs j on j.id=i.id
          where i.candidate_id=previous.candidate_id and j.state='quarantined'))
      then raise exception 'LINEAGE_EXHAUSTED'; end if;
    root:=previous.lineage; ordinal:=2; v_scope:=previous.scope;
    select id,content_candidates.version+1 into parent,version from private.content_candidates where id=previous.candidate_id;
    if not found then parent:=null; version:=1; end if;
  elsif exists(select 1 from private.authoring_inputs where authoring_inputs.scope=v_scope
    or (plan->'spec'->>'kind'=spec->>'kind' and plan->'spec'->>'stableId'=spec->>'stableId'))
    then raise exception 'IMMUTABLE_REVISION_REQUIRED';
  end if;
  insert into private.authoring_inputs(id,candidate_id,parent_id,version,lineage,run_number,batch_id,plan,digest,scope)
    values(run,candidate,parent,version,root,ordinal,(spec->>'batchId')::uuid,p_plan,private.content_digest(p_plan),v_scope);
  insert into private.authoring_jobs(id) values(run);
  return run;
end;
$$;

create function private.authoring_context(p_run uuid) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',i.id,'candidateId',i.candidate_id,'parentId',i.parent_id,'version',i.version,
    'lineage',i.lineage,'runNumber',i.run_number,'plan',i.plan,'configuration',b.configuration,'configurationDigest',b.digest,
    'state',j.state,'lease',j.lease,'reason',j.reason,
    'requestsUsed',(select count(*) from private.provider_requests where authoring_run=i.id),
    'repair',exists(select 1 from private.authoring_artifacts where run_id=i.id and error='INVALID_OUTPUT'),
    'bundle',(select bundle from private.authoring_artifacts where run_id=i.id and error is null))
  from private.authoring_inputs i join private.authoring_jobs j using(id)
    join private.qualification_batches b on b.id=i.batch_id where i.id=p_run;
$$;
create function private.authoring_claim(p_run uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform 1 from private.authoring_jobs where id=p_run and (state='queued' or state='running' and lease_until<now()) for update skip locked;
  if not found then return null; end if;
  update private.authoring_jobs set state='running',lease=gen_random_uuid(),lease_until=now()+interval '90 seconds',reason=null where id=p_run;
  return private.authoring_context(p_run);
end;
$$;
create function private.authoring_reserve(p_run uuid,p_lease uuid,p_repair boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare i private.authoring_inputs; config jsonb; used integer; request uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(461920);
  perform 1 from private.authoring_jobs where id=p_run and state='running' and lease=p_lease and lease_until>now() for update;
  if not found then raise exception 'STALE_LEASE'; end if;
  select * into i from private.authoring_inputs where id=p_run;
  select configuration into config from private.qualification_batches where id=i.batch_id;
  if config->>'policyVersion' is distinct from 'content-policy-v2' or (config->>'expiresAt')::timestamptz<=now() then raise exception 'AUTHORING_DISABLED'; end if;
  select count(*) into used from private.provider_requests where authoring_run=p_run;
  if used>=3 or p_repair is distinct from exists(select 1 from private.authoring_artifacts where run_id=p_run and error='INVALID_OUTPUT')
    or p_repair and exists(select 1 from private.provider_requests where authoring_run=p_run and repair)
    then raise exception 'REQUEST_LIMIT'; end if;
  insert into private.provider_requests(authoring_run,task,worker_lease,ordinal,reserved_cents,repair,qualification_prompt)
    values(p_run,'author',p_lease,used+1,10,p_repair,i.plan->'requests'->case when p_repair then 'repair' else 'original' end)
    returning id into request;
  update private.authoring_jobs set lease_until=now()+interval '90 seconds' where id=p_run;
  return request;
end;
$$;
create function private.authoring_yield(p_run uuid,p_lease uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform 1 from private.authoring_jobs where id=p_run and state='running' and lease=p_lease and lease_until>now() for update;
  if not found then raise exception 'STALE_LEASE'; end if;
  if p_reason is null or p_reason not in ('AUTHORING_DISABLED','BUDGET_EXCEEDED','REQUEST_LIMIT') then raise exception 'AUTHORING_INPUT_INVALID'; end if;
  update private.authoring_jobs set state=case when p_reason='REQUEST_LIMIT' then
    case when (select run_number from private.authoring_inputs where id=p_run)=1 then 'quarantined' else 'rejected' end else 'queued' end,
    lease=null,lease_until=null,reason=p_reason where id=p_run;
  return private.authoring_context(p_run);
end;
$$;
create function private.authoring_complete(p_run uuid,p_lease uuid,p_request uuid,p_bundle jsonb,p_error text,p_cents integer,p_usage jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i private.authoring_inputs; r private.provider_requests; charged integer;
begin
  perform 1 from private.authoring_jobs where id=p_run and state='running' and lease=p_lease and lease_until>now() for update;
  if not found then raise exception 'STALE_LEASE'; end if;
  select * into r from private.provider_requests where id=p_request and authoring_run=p_run and worker_lease=p_lease;
  if not found then raise exception 'REQUEST_REQUIRED'; end if;
  if exists(select 1 from private.authoring_artifacts where request_id=p_request) then return private.authoring_context(p_run); end if;
  select * into i from private.authoring_inputs where id=p_run;
  if p_error is not null and p_error not in ('INVALID_OUTPUT','CHECK_FAILED','PROVIDER_TIMEOUT','PROVIDER_REJECTED')
    or octet_length(p_usage::text)>2000 then raise exception 'AUTHORING_INPUT_INVALID'; end if;
  if p_error is null then
    perform private.validate_content_bundle(p_bundle);
    if not private.calibrated_rubric_v2(p_bundle) or p_bundle->>'id' is distinct from i.candidate_id::text
      or p_bundle->>'parentId' is distinct from i.parent_id::text or p_bundle->>'version' is distinct from i.version::text
      or p_bundle->>'stableId' is distinct from i.plan->'spec'->>'stableId'
      or p_bundle->>'kind' is distinct from i.plan->'spec'->>'kind'
      or p_bundle->>'origin' is distinct from 'generation'
      or p_bundle->'sources' is distinct from i.plan->'spec'->'sources'
      or p_bundle->'payload'->>'domain' is distinct from i.plan->'spec'->>'domain'
      or exists(select 1 from jsonb_array_elements(p_bundle->'payload'->'blocks') b where b->>'type'<>'text')
      or p_bundle->>'kind'='question' and p_bundle->'payload'->>'skillId' is distinct from i.plan->'spec'->>'skillId'
      or p_bundle->'dependencies' is distinct from (select coalesce(jsonb_agg(jsonb_build_object('id',d->>'id','digest',d->>'digest')),'[]') from jsonb_array_elements(i.plan->'spec'->'dependencies') d)
      then raise exception 'AUTHORING_INPUT_INVALID'; end if;
  end if;
  if p_error is distinct from 'PROVIDER_TIMEOUT' and p_error is distinct from 'PROVIDER_REJECTED'
    and p_cents is not null and jsonb_typeof(p_usage->'inputTokens')='number' and jsonb_typeof(p_usage->'outputTokens')='number'
    and p_usage->>'inputTokens' ~ '^[0-9]{1,7}$' and p_usage->>'outputTokens' ~ '^[0-9]{1,4}$'
    and (p_usage->>'inputTokens')::integer<=1000000 and (p_usage->>'outputTokens')::integer<=3000 then
    charged:=ceil(((p_usage->>'inputTokens')::numeric*0.75+(p_usage->>'outputTokens')::numeric*4.5)/10000);
    if charged=p_cents and charged<=10 then update private.provider_requests set actual_cents=charged,usage=p_usage where id=p_request and actual_cents is null; end if;
  end if;
  insert into private.authoring_artifacts(run_id,request_id,bundle,error) values(p_run,p_request,case when p_error is null then p_bundle end,p_error);
  update private.authoring_jobs set state=case
    when p_error is null then 'authored'
    when p_error in ('CHECK_FAILED','PROVIDER_REJECTED') or r.repair or r.ordinal>=3 then case when i.run_number=1 then 'quarantined' else 'rejected' end
    else 'running' end,reason=p_error,lease_until=now()+interval '90 seconds',updated_at=now() where id=p_run;
  return private.authoring_context(p_run);
end;
$$;
create function private.authoring_export(p_run uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('work',private.authoring_context(p_run),
    'requests',coalesce((select jsonb_agg(to_jsonb(r)-'worker_lease') from private.provider_requests r where authoring_run=p_run),'[]'),
    'artifacts',coalesce((select jsonb_agg(to_jsonb(a)) from private.authoring_artifacts a where run_id=p_run),'[]'));
$$;

create function private.shared_content_reservation() returns trigger
language plpgsql security definer set search_path='' as $$
declare root uuid; v_run_number integer; batch uuid; kind text; config jsonb; used integer; total integer; cost integer; day_cost integer; month_cost integer;
begin
  if new.qualification_job is null and new.authoring_run is null then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(461920);
  if new.authoring_run is not null then
    select a.lineage,a.run_number,a.batch_id,a.plan->'spec'->>'kind' into root,v_run_number,batch,kind from private.authoring_inputs a where a.id=new.authoring_run;
  else
    select i.lineage,i.run_number,i.batch_id,c.kind into root,v_run_number,batch,kind
      from private.qualification_inputs i join private.content_candidates c on c.id=i.candidate_id where i.id=new.qualification_job;
  end if;
  select configuration into config from private.qualification_batches where id=batch;
  select count(*) filter(where coalesce(a.run_number,q.run_number)=v_run_number),count(*) into used,total
    from private.provider_requests r left join private.authoring_inputs a on a.id=r.authoring_run
    left join private.qualification_inputs q on q.id=r.qualification_job where coalesce(a.lineage,q.lineage)=root;
  if used>=(case when kind='question' then 12 else 3 end) or total>=(case when kind='question' then 24 else 6 end) then raise exception 'REQUEST_LIMIT'; end if;
  select coalesce(sum(coalesce(r.actual_cents,r.reserved_cents)),0) into cost
    from private.provider_requests r left join private.authoring_inputs a on a.id=r.authoring_run
    left join private.qualification_inputs q on q.id=r.qualification_job where coalesce(a.batch_id,q.batch_id)=batch;
  select coalesce(sum(coalesce(actual_cents,reserved_cents)) filter(where created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),0),
    coalesce(sum(coalesce(actual_cents,reserved_cents)),0) into day_cost,month_cost
    from private.provider_requests where created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC';
  if cost+new.reserved_cents>(config->>'batchCap')::integer or day_cost+new.reserved_cents>(config->>'dailyCap')::integer
    or month_cost+new.reserved_cents>(config->>'monthlyCap')::integer then raise exception 'BUDGET_EXCEEDED'; end if;
  return new;
end;
$$;
alter function private.shared_content_reservation() owner to qualification_engine;
revoke all on function private.shared_content_reservation() from public,anon,authenticated,service_role;
create trigger shared_content_reservation before insert on private.provider_requests
  for each row execute function private.shared_content_reservation();

do $$
declare signature text;
begin
  foreach signature in array array['authoring_open(jsonb)','authoring_context(uuid)','authoring_claim(uuid)','authoring_reserve(uuid,uuid,boolean)',
    'authoring_yield(uuid,uuid,text)','authoring_complete(uuid,uuid,uuid,jsonb,text,integer,jsonb)','authoring_export(uuid)'] loop
    execute 'alter function private.'||signature||' owner to authoring_engine';
    execute 'revoke all on function private.'||signature||' from public,anon,authenticated,service_role';
  end loop;
end;
$$;
grant execute on function private.authoring_open(jsonb),private.authoring_export(uuid) to authoring_operator;
grant execute on function private.authoring_claim(uuid),private.authoring_reserve(uuid,uuid,boolean),
  private.authoring_yield(uuid,uuid,text),private.authoring_complete(uuid,uuid,uuid,jsonb,text,integer,jsonb) to authoring_worker;

create function private.qualification_request_counts(p_job uuid)
returns table(requests_used bigint,lineage_requests_used bigint)
language sql stable set search_path='' as $$
  select count(*) filter(where coalesce(a.run_number,q.run_number)=i.run_number),count(*)
  from private.qualification_inputs i join private.provider_requests r on true
  left join private.authoring_inputs a on a.id=r.authoring_run
  left join private.qualification_inputs q on q.id=r.qualification_job
  where i.id=p_job and coalesce(a.lineage,q.lineage)=i.lineage;
$$;
alter function private.qualification_request_counts(uuid) owner to qualification_engine;
revoke all on function private.qualification_request_counts(uuid) from public,anon,authenticated,service_role;

create or replace function private.qualification_enqueue(p_candidate uuid,p_batch uuid,p_evidence jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare c private.content_candidates; previous private.qualification_inputs; existing private.qualification_inputs;
  id uuid := gen_random_uuid(); root uuid; ordinal integer := 1; fingerprint text; configuration jsonb; authored private.authoring_inputs;
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
  select ai.* into authored from private.authoring_inputs ai where ai.candidate_id=c.id;
  if found then
    if authored.batch_id<>p_batch or authored.plan->'spec'->'evidence'<>p_evidence
      or not exists(select 1 from private.authoring_artifacts a join private.authoring_jobs j on j.id=a.run_id
        where a.run_id=authored.id and a.error is null and a.bundle=c.bundle and j.state='authored')
      then raise exception 'AUTHORING_HANDOFF_REQUIRED'; end if;
    root:=authored.lineage; ordinal:=authored.run_number;
  else
    if exists(select 1 from private.authoring_artifacts a where a.error is null
      and a.bundle-array['id','stableId','version','parentId','digest','origin']=c.bundle-array['id','stableId','version','parentId','digest','origin'])
      then raise exception 'AUTHORING_HANDOFF_REQUIRED'; end if;
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
  end if;
  insert into private.qualification_inputs(id,candidate_id,batch_id,lineage,run_number,evidence,fingerprint)
    values(id,c.id,p_batch,root,ordinal,p_evidence,fingerprint);
  insert into private.qualification_jobs(id) values(id);
  return id;
end;
$$;
revoke create on schema private from authoring_engine,qualification_engine;
revoke authoring_engine,qualification_engine from postgres;
