create role evaluation_engine nologin noinherit;
create role evaluation_operator nologin noinherit;
create role evaluation_worker nologin noinherit;
grant evaluation_engine to postgres;
grant usage on schema private to evaluation_engine,evaluation_operator,evaluation_worker;
grant usage on schema extensions to evaluation_engine;
grant create on schema private to evaluation_engine;
grant execute on function private.canonical_content(jsonb),private.content_digest(jsonb) to evaluation_engine;

create table private.evaluation_inputs (
  id uuid primary key default gen_random_uuid(),
  identity text not null unique check(identity ~ '^[a-f0-9]{64}$'),
  scope text not null unique check(scope ~ '^[a-f0-9]{64}$'),
  plan jsonb not null check(octet_length(plan::text)<=3000000),
  digest text not null check(digest=private.content_digest(plan)),
  actor name not null default session_user,
  created_at timestamptz not null default now()
);
create table private.evaluation_jobs (
  id uuid primary key references private.evaluation_inputs,
  state text not null default 'queued' check(state in ('queued','running','completed')),
  lease uuid,
  lease_until timestamptz,
  reason text,
  updated_at timestamptz not null default now()
);
alter table private.provider_requests
  add column evaluation_run uuid references private.evaluation_inputs,
  drop constraint provider_request_owner,
  add constraint provider_request_owner check(
    (attempt_id is not null and generation is not null and qualification_job is null and evaluation_run is null and task is null)
    or (attempt_id is null and generation is null and qualification_job is not null and evaluation_run is null and task is not null and worker_lease is not null)
    or (attempt_id is null and generation is null and qualification_job is null and evaluation_run is not null and task is not null and worker_lease is not null)
  ),
  add unique(evaluation_run,task,ordinal);
create table private.evaluation_observations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references private.evaluation_inputs,
  case_id text not null,
  request_id uuid unique references private.provider_requests,
  output jsonb check(octet_length(output::text)<=64000),
  error text,
  terminal boolean not null,
  actor name not null default session_user,
  created_at timestamptz not null default now()
);
create unique index evaluation_case_terminal on private.evaluation_observations(run_id,case_id) where terminal;
create table private.evaluation_reports (
  run_id uuid primary key references private.evaluation_inputs,
  report jsonb not null,
  digest text not null check(digest=private.content_digest(report)),
  actor name not null default session_user,
  created_at timestamptz not null default now()
);
do $$
declare t text;
begin
  foreach t in array array['evaluation_inputs','evaluation_jobs','evaluation_observations','evaluation_reports'] loop
    execute format('alter table private.%I enable row level security',t);
    execute format('revoke all on private.%I from public,anon,authenticated,service_role',t);
    execute format('grant select,insert on private.%I to evaluation_engine',t);
    execute format('create policy evaluation_engine_only on private.%I to evaluation_engine using(true) with check(true)',t);
    if t<>'evaluation_jobs' then
      execute format('create trigger immutable_evaluation before update or delete on private.%I for each row execute function private.immutable_history()',t);
    end if;
  end loop;
end;
$$;
create function private.evaluation_claim(p_run uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.evaluation_jobs;
begin
  select * into j from private.evaluation_jobs
    where id=p_run and (state='queued' or state='running' and lease_until<now()) for update skip locked;
  if not found then return null; end if;
  update private.evaluation_jobs set state='running',lease=gen_random_uuid(),lease_until=now()+interval '90 seconds',reason=null,updated_at=now() where id=p_run;
  perform private.evaluation_advance(p_run);
  return private.evaluation_context(p_run);
end;
$$;
grant update on private.evaluation_jobs to evaluation_engine;
grant select,insert,update on private.provider_requests to evaluation_engine;
create policy evaluation_cost_totals on private.provider_requests for select to evaluation_engine using(true);
create policy evaluation_cost_reservation on private.provider_requests for insert to evaluation_engine with check(evaluation_run is not null);
create policy evaluation_cost_settlement on private.provider_requests for update to evaluation_engine using(evaluation_run is not null) with check(evaluation_run is not null);

create function private.evaluation_case(p_run uuid) returns jsonb
language sql stable set search_path='' as $$
  select c.value from private.evaluation_inputs i,
    lateral jsonb_array_elements(i.plan->'cases') with ordinality c(value,n)
  where i.id=p_run and not exists(select 1 from private.evaluation_observations o where o.run_id=i.id and o.case_id=c.value->>'id' and o.terminal)
  order by c.n limit 1;
$$;
create function private.evaluation_context(p_run uuid) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',j.id,'state',j.state,'lease',j.lease,'reason',j.reason,
    'plan',i.plan,'case',private.evaluation_case(j.id),
    'requestsUsed',(select count(*) from private.provider_requests r where r.evaluation_run=j.id),
    'costCents',(select coalesce(sum(coalesce(r.actual_cents,r.reserved_cents)),0) from private.provider_requests r where r.evaluation_run=j.id),
    'invalid',(select count(*) from private.evaluation_observations o where o.run_id=j.id and o.case_id=private.evaluation_case(j.id)->>'id' and o.error='INVALID_OUTPUT'))
  from private.evaluation_jobs j join private.evaluation_inputs i using(id) where j.id=p_run;
$$;

create function private.evaluation_open(p_plan jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare configuration jsonb:=p_plan->'configuration'; key text; id uuid; previous private.evaluation_inputs; plan_identity text; study_scope text;
begin
  if jsonb_typeof(p_plan) is distinct from 'object' or octet_length(p_plan::text)>3000000
    or jsonb_typeof(p_plan->'cases') is distinct from 'array'
    or jsonb_array_length(p_plan->'cases') not between 9 and 60
    or not p_plan ?& array['identity','packageDigest','datasetDigest','configurationDigest','configuration','code','cases','package']
    or p_plan-array['identity','packageDigest','datasetDigest','configurationDigest','configuration','code','cases','package']<>'{}'
    or p_plan->>'packageDigest' is distinct from private.content_digest((p_plan->'package')-'digest')
    or p_plan->>'packageDigest' is distinct from p_plan->'package'->>'digest'
    or p_plan->>'datasetDigest' is distinct from private.content_digest(p_plan->'package'->'dataset')
    or jsonb_typeof(p_plan->'package'->'dataset'->'cases') is distinct from 'array'
    or jsonb_array_length(p_plan->'cases') is distinct from jsonb_array_length(p_plan->'package'->'dataset'->'cases')
    or exists(select 1 from jsonb_array_elements(p_plan->'cases') with ordinality c(value,n)
      where c.value-array['requests','policyIssues'] is distinct from p_plan->'package'->'dataset'->'cases'->(c.n::integer-1))
    then raise exception 'EVALUATION_INPUT_INVALID'; end if;
  if configuration->>'protocolVersion' is distinct from 'release-evaluation-v1'
    or configuration->>'policyVersion' is distinct from 'content-policy-v1'
    or configuration->>'modelVersion' is distinct from 'gpt-5.4-mini-2026-03-17'
    or configuration->>'promptVersion' is distinct from 'qualification-prompts-v1'
    or configuration->>'schemaVersion' is distinct from 'qualification-schema-v1'
    or configuration->>'fixtureVersion' is distinct from 'machine-fixtures-v1'
    or configuration->>'graderVersion' is distinct from 'grader-v1'
    or configuration->>'gradingPromptVersion' is distinct from 'grade-prompt-v1'
    or configuration->>'gradingSchemaVersion' is distinct from 'grade-schema-v1'
    or configuration->>'toolchainVersion' is distinct from 'conceptual-no-execution-v1'
    or configuration->>'inputUsdPerMillion' is distinct from '0.75'
    or configuration->>'outputUsdPerMillion' is distinct from '4.5'
    or configuration->>'requestCents' is distinct from '10'
    or not coalesce(configuration->>'mode' in ('live','mock'),false)
    or not coalesce((configuration->>'dailyCap')::integer between 1 and 100,false)
    or not coalesce((configuration->>'monthlyCap')::integer between 1 and 2000,false)
    or not coalesce((configuration->>'batchCap')::integer between 1 and 2000,false)
    or not coalesce((configuration->>'maxRequests')::integer between 1 and 180,false)
    or not coalesce((configuration->>'expiresAt')::timestamptz>now(),false)
    or p_plan->>'configurationDigest' is distinct from private.content_digest(configuration)
    or p_plan->'code'->>'digest' is distinct from private.content_digest(p_plan->'code'->'files')
    or configuration->>'codeDigest' is distinct from p_plan->'code'->>'digest'
    then raise exception 'EVALUATION_DISABLED'; end if;
  foreach key in array array['providerPolicyDigest','privacyApprovalDigest','deploymentApprovalDigest','runAuthorizationDigest','codeDigest'] loop
    if not coalesce(configuration->>key ~ '^[a-f0-9]{64}$',false) then raise exception 'EVALUATION_DISABLED'; end if;
  end loop;
  foreach key in array array['packageDigest','datasetDigest','identity'] loop
    if not coalesce(p_plan->>key ~ '^[a-f0-9]{64}$',false) then raise exception 'EVALUATION_INPUT_INVALID'; end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(p_plan->'cases') c where
      not coalesce(c->>'id' ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$',false)
      or not coalesce(c->>'stage' in ('policy','source','fixtures','critic','grade'),false))
    or (select count(distinct c->>'id') from jsonb_array_elements(p_plan->'cases') c)<>jsonb_array_length(p_plan->'cases')
    then raise exception 'EVALUATION_INPUT_INVALID'; end if;
  plan_identity:=private.content_digest(jsonb_build_object('packageDigest',p_plan->>'packageDigest','datasetDigest',p_plan->>'datasetDigest',
    'codeDigest',configuration->>'codeDigest','protocolVersion',configuration->>'protocolVersion','modelVersion',configuration->>'modelVersion'));
  if plan_identity is distinct from p_plan->>'identity' then raise exception 'EVALUATION_INPUT_INVALID'; end if;
  perform pg_catalog.pg_advisory_xact_lock(813402);
  if exists(select 1 from private.evaluation_inputs where plan->'package'->>'id'=p_plan->'package'->>'id' and plan->>'packageDigest'<>p_plan->>'packageDigest')
    or exists(select 1 from private.evaluation_inputs where plan->'package'->'dataset'->>'id'=p_plan->'package'->'dataset'->>'id'
      and plan->'package'->'dataset'->'version'=p_plan->'package'->'dataset'->'version' and plan->>'datasetDigest'<>p_plan->>'datasetDigest')
    then raise exception 'EVALUATION_REVISION_REQUIRED'; end if;
  study_scope:=private.content_digest(jsonb_build_object(
    'cases',(select jsonb_agg(c-'id' order by private.content_digest(c-'id')) from jsonb_array_elements(p_plan->'package'->'dataset'->'cases') c),
    'codeDigest',configuration->>'codeDigest','modelVersion',configuration->>'modelVersion','protocolVersion',configuration->>'protocolVersion'));
  select * into previous from private.evaluation_inputs where scope=study_scope;
  if found then
    if previous.digest<>private.content_digest(p_plan) then raise exception 'EVALUATION_REVISION_REQUIRED'; end if;
    return previous.id;
  end if;
  insert into private.evaluation_inputs(identity,scope,plan,digest) values(plan_identity,study_scope,p_plan,private.content_digest(p_plan)) returning evaluation_inputs.id into id;
  insert into private.evaluation_jobs(id) values(id);
  return id;
end;
$$;

create function private.evaluation_advance(p_run uuid) returns void
language plpgsql set search_path='' as $$
declare c jsonb;
begin
  loop
    c:=private.evaluation_case(p_run);
    exit when c is null;
    if c->>'stage'='policy' then
      insert into private.evaluation_observations(run_id,case_id,output,terminal)
        values(p_run,c->>'id',jsonb_build_object('policyIssues',c->'policyIssues'),true);
    elsif (select count(*) from private.provider_requests where evaluation_run=p_run and task=c->>'id')>=3
      or exists(select 1 from private.provider_requests where evaluation_run=p_run and task=c->>'id' and repair) then
      insert into private.evaluation_observations(run_id,case_id,error,terminal) values(p_run,c->>'id','REQUEST_LIMIT',true);
    else exit;
    end if;
  end loop;
end;
$$;

create function private.evaluation_reserve(p_run uuid,p_lease uuid,p_repair boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare j private.evaluation_jobs; configuration jsonb; c jsonb; id uuid; task_count integer; used integer; day_cost integer; month_cost integer; run_cost integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(461920);
  select * into j from private.evaluation_jobs where evaluation_jobs.id=p_run for update;
  if not found or j.state<>'running' or j.lease is distinct from p_lease or j.lease_until<=now() then raise exception 'STALE_LEASE'; end if;
  select plan->'configuration' into configuration from private.evaluation_inputs where evaluation_inputs.id=p_run;
  if (configuration->>'expiresAt')::timestamptz<=now() then raise exception 'EVALUATION_DISABLED'; end if;
  c:=private.evaluation_case(p_run);
  if c is null or c->>'stage'='policy' or p_repair is null then raise exception 'STAGE_CONFLICT'; end if;
  select count(*),count(*) filter(where task=c->>'id') into used,task_count from private.provider_requests where evaluation_run=p_run;
  if used>=(configuration->>'maxRequests')::integer or task_count>=3
    or p_repair is distinct from exists(select 1 from private.evaluation_observations where run_id=p_run and case_id=c->>'id' and error='INVALID_OUTPUT')
    or p_repair and exists(select 1 from private.provider_requests where evaluation_run=p_run and task=c->>'id' and repair)
    then raise exception 'REQUEST_LIMIT'; end if;
  select coalesce(sum(coalesce(actual_cents,reserved_cents)) filter(where created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),0),
    coalesce(sum(coalesce(actual_cents,reserved_cents)),0) into day_cost,month_cost from private.provider_requests
    where created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC';
  select coalesce(sum(coalesce(actual_cents,reserved_cents)),0) into run_cost from private.provider_requests where evaluation_run=p_run;
  if day_cost+10>(configuration->>'dailyCap')::integer or month_cost+10>(configuration->>'monthlyCap')::integer or run_cost+10>(configuration->>'batchCap')::integer
    then raise exception 'BUDGET_EXCEEDED'; end if;
  insert into private.provider_requests(evaluation_run,task,worker_lease,ordinal,reserved_cents,repair,qualification_prompt)
    values(p_run,c->>'id',p_lease,task_count+1,10,p_repair,c->'requests'->case when p_repair then 'repair' else 'original' end) returning provider_requests.id into id;
  update private.evaluation_jobs set lease_until=now()+interval '90 seconds',updated_at=now() where evaluation_jobs.id=p_run;
  return id;
end;
$$;

create function private.evaluation_complete(p_run uuid,p_lease uuid,p_request uuid,p_output jsonb,p_error text,p_cents integer,p_usage jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.evaluation_jobs; r private.provider_requests; terminal boolean; c jsonb; charged integer;
begin
  select * into j from private.evaluation_jobs where id=p_run for update;
  if not found or j.state<>'running' or j.lease is distinct from p_lease or j.lease_until<=now() then raise exception 'STALE_LEASE'; end if;
  select * into r from private.provider_requests where id=p_request and evaluation_run=p_run and worker_lease=p_lease;
  if not found then raise exception 'REQUEST_REQUIRED'; end if;
  if exists(select 1 from private.evaluation_observations where request_id=p_request) then return private.evaluation_context(p_run); end if;
  c:=private.evaluation_case(p_run);
  if c->>'id' is distinct from r.task or octet_length(p_output::text)>64000 or octet_length(p_usage::text)>2000
    or p_error is not null and p_error not in ('CHECK_FAILED','INVALID_OUTPUT','PROVIDER_TIMEOUT','PROVIDER_REJECTED')
    or p_cents is not null and p_cents not between 0 and 10 then raise exception 'EVALUATION_INPUT_INVALID'; end if;
  update private.provider_requests set usage=p_usage where id=p_request and actual_cents is null;
  if p_cents is not null and jsonb_typeof(p_usage->'inputTokens')='number' and jsonb_typeof(p_usage->'outputTokens')='number'
    and p_usage->>'inputTokens' ~ '^[0-9]{1,7}$' and p_usage->>'outputTokens' ~ '^[0-9]{1,4}$' then
    if (p_usage->>'inputTokens')::integer<=1000000 and (p_usage->>'outputTokens')::integer<=3000 then
      charged:=ceil(((p_usage->>'inputTokens')::numeric*0.75+(p_usage->>'outputTokens')::numeric*4.5)/10000);
      if charged=p_cents and charged<=10 then
        update private.provider_requests set actual_cents=charged where id=p_request and actual_cents is null;
      end if;
    end if;
  end if;
  terminal:=p_error is null or p_error in ('CHECK_FAILED','PROVIDER_REJECTED') or
    r.repair or (select count(*) from private.provider_requests where evaluation_run=p_run and task=r.task)>=3;
  insert into private.evaluation_observations(run_id,case_id,request_id,output,error,terminal)
    values(p_run,r.task,p_request,p_output,p_error,terminal);
  perform private.evaluation_advance(p_run);
  update private.evaluation_jobs set lease_until=now()+interval '90 seconds',updated_at=now() where id=p_run;
  return private.evaluation_context(p_run);
end;
$$;

create function private.evaluation_acceptance(c jsonb,o jsonb) returns boolean
language plpgsql set search_path='' as $$
declare b jsonb:=c->'candidate'; x jsonb; f jsonb;
begin
  if jsonb_typeof(o) is distinct from 'object' then return null; end if;
  if c->>'stage'='source' then
    if not o ?& array['independentAnswer','claims','privacy','originality','issues','executionRequired','executionPlan']
      or o-array['independentAnswer','claims','privacy','originality','issues','executionRequired','executionPlan']<>'{}'
      or jsonb_typeof(o->'claims') is distinct from 'array' or jsonb_typeof(o->'issues') is distinct from 'array'
      or jsonb_typeof(o->'independentAnswer') is distinct from 'string'
      or not coalesce(length(o->>'independentAnswer') between 1 and 10000,false) or not coalesce(o->>'privacy' in ('public','private_or_uncertain'),false)
      or not coalesce(o->>'originality' in ('original','reuse_or_uncertain'),false)
      or jsonb_typeof(o->'executionRequired') is distinct from 'boolean' or jsonb_typeof(o->'executionPlan') is distinct from 'array'
      then return null; end if;
    if jsonb_array_length(o->'claims') not between 1 and 30 or jsonb_array_length(o->'issues')>30 or jsonb_array_length(o->'executionPlan')>20
      or exists(select 1 from jsonb_array_elements(o->'issues') issue where jsonb_typeof(issue)<>'string' or length(issue#>>'{}') not between 1 and 2000)
      then return null; end if;
    for x in select value from jsonb_array_elements(o->'claims') loop
      if not x ?& array['claim','sourceId','quote','verdict','reason'] or not coalesce(x->>'verdict' in ('supported','unsupported'),false)
        or x-array['claim','sourceId','quote','verdict','reason']<>'{}'
        or jsonb_typeof(x->'claim') is distinct from 'string' or not coalesce(length(x->>'claim') between 1 and 1000,false)
        or jsonb_typeof(x->'sourceId') is distinct from 'string' or not coalesce(length(x->>'sourceId') between 1 and 100,false)
        or jsonb_typeof(x->'quote') is distinct from 'string' or not coalesce(length(x->>'quote') between 1 and 5000,false)
        or jsonb_typeof(x->'reason') is distinct from 'string' or not coalesce(length(x->>'reason') between 1 and 2000,false) then return null; end if;
    end loop;
    for x in select value from jsonb_array_elements(o->'executionPlan') loop
      if jsonb_typeof(x) is distinct from 'object' or not x ?& array['blockIndex','expectedStdout','reason']
        or x-array['blockIndex','expectedStdout','reason']<>'{}' or jsonb_typeof(x->'blockIndex') is distinct from 'number'
        or not coalesce(x->>'blockIndex' ~ '^([0-9]|1[0-9])$',false)
        or jsonb_typeof(x->'expectedStdout') is distinct from 'string' or length(x->>'expectedStdout')>10000
        or jsonb_typeof(x->'reason') is distinct from 'string' or not coalesce(length(x->>'reason') between 1 and 2000,false)
        then return null; end if;
    end loop;
    return o->>'privacy'='public' and o->>'originality'='original' and o->'issues'='[]'
      and jsonb_array_length(o->'claims')=jsonb_array_length(b->'claims')
      and not exists(select 1 from jsonb_array_elements(b->'claims') claim where not exists(
        select 1 from jsonb_array_elements(o->'claims') finding where finding->>'claim'=claim->>'claim' and finding->>'verdict'='supported'
          and exists(select 1 from jsonb_array_elements_text(claim->'sourceIds') sid where sid=finding->>'sourceId')
          and exists(select 1 from jsonb_array_elements(c->'evidence') e where e->>'sourceId'=finding->>'sourceId' and position(finding->>'quote' in e->>'text')>0)));
  elsif c->>'stage'='critic' then
    if not o ?& array['independentAnswer','privacy','originality','objections','proofLimits','fixtures','links']
      or o-array['independentAnswer','privacy','originality','objections','proofLimits','fixtures','links']<>'{}'
      or jsonb_typeof(o->'objections') is distinct from 'array' or jsonb_typeof(o->'proofLimits') is distinct from 'array'
      or jsonb_typeof(o->'fixtures') is distinct from 'array' or jsonb_typeof(o->'links') is distinct from 'array'
      or not coalesce(length(o->>'independentAnswer')>0,false) or not coalesce(o->>'privacy' in ('public','private_or_uncertain'),false)
      or not coalesce(o->>'originality' in ('original','reuse_or_uncertain'),false) then return null; end if;
    if jsonb_array_length(o->'proofLimits') not between 1 and 10 or jsonb_array_length(o->'fixtures')>5
      or jsonb_array_length(o->'links')>20 or jsonb_array_length(o->'objections')>30 then return null; end if;
    if jsonb_typeof(o->'independentAnswer') is distinct from 'string' or length(o->>'independentAnswer')>10000
      or exists(select 1 from jsonb_array_elements((o->'objections')||(o->'proofLimits')) v
        where jsonb_typeof(v)<>'string' or length(v#>>'{}') not between 1 and 2000) then return null; end if;
    for x in select value from jsonb_array_elements(o->'fixtures') loop
      if jsonb_typeof(x) is distinct from 'object' or not x ?& array['kind','verdict','reason']
        or x-array['kind','verdict','reason']<>'{}' or not coalesce(x->>'kind' in ('wrong','partial','borderline_pass','strong','ambiguous'),false)
        or not coalesce(x->>'verdict' in ('supported','unsupported'),false)
        or jsonb_typeof(x->'reason') is distinct from 'string' or not coalesce(length(x->>'reason') between 1 and 2000,false)
        then return null; end if;
    end loop;
    for x in select value from jsonb_array_elements(o->'links') loop
      if jsonb_typeof(x) is distinct from 'object' or not x ?& array['termId','exposure','verdict','reason']
        or x-array['termId','exposure','verdict','reason']<>'{}' or not coalesce(x->>'termId' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$',false)
        or not coalesce(x->>'exposure' in ('pre_attempt_safe','post_grade_only'),false)
        or not coalesce(x->>'verdict' in ('safe','post_grade_only','spoiler_or_uncertain'),false)
        or jsonb_typeof(x->'reason') is distinct from 'string' or not coalesce(length(x->>'reason') between 1 and 2000,false)
        then return null; end if;
    end loop;
    return o->>'privacy'='public' and o->>'originality'='original' and o->'objections'='[]' and jsonb_array_length(o->'proofLimits')>0
      and (b->>'kind'<>'question' or (
        not exists(select 1 from unnest(array['wrong','partial','borderline_pass','strong','ambiguous']) kind where not exists(
          select 1 from jsonb_array_elements(o->'fixtures') finding where finding->>'kind'=kind and finding->>'verdict'='supported'))
        and not exists(select 1 from jsonb_array_elements(b->'payload'->'terms') link where not exists(
          select 1 from jsonb_array_elements(o->'links') finding where finding->>'termId'=link->>'termId' and finding->>'exposure'=link->>'exposure'
            and finding->>'verdict'=case when link->>'exposure'='pre_attempt_safe' then 'safe' else 'post_grade_only' end))));
  elsif c->>'stage'='fixtures' then
    if o-array['cases']<>'{}' or jsonb_typeof(o->'cases') is distinct from 'array' then return null; end if;
    if jsonb_array_length(o->'cases')<>5 or
      (select jsonb_agg(kind order by kind) from (select distinct value->>'kind' kind from jsonb_array_elements(o->'cases')) kinds)
      is distinct from '["ambiguous","borderline_pass","partial","strong","wrong"]'::jsonb then return false; end if;
    for f in select value from jsonb_array_elements(o->'cases') loop
      if jsonb_typeof(f) is distinct from 'object' or not f ?& array['kind','answer','expected','minScore','maxScore','expectedPass','reason','basis']
        or f-array['kind','answer','expected','minScore','maxScore','expectedPass','reason','basis']<>'{}'
        or jsonb_typeof(f->'basis') is distinct from 'array' or jsonb_typeof(f->'answer') is distinct from 'string'
        or not coalesce(length(f->>'answer') between 1 and 12000,false)
        or jsonb_typeof(f->'reason') is distinct from 'string' or not coalesce(length(f->>'reason') between 1 and 2000,false)
        then return null; end if;
      if jsonb_array_length(f->'basis')>20 then return null; end if;
      for x in select value from jsonb_array_elements(f->'basis') loop
        if jsonb_typeof(x) is distinct from 'object' or not x ?& array['claim','sourceId','quote']
          or x-array['claim','sourceId','quote']<>'{}'
          or jsonb_typeof(x->'claim') is distinct from 'string' or not coalesce(length(x->>'claim') between 1 and 1000,false)
          or jsonb_typeof(x->'sourceId') is distinct from 'string' or not coalesce(length(x->>'sourceId') between 1 and 100,false)
          or jsonb_typeof(x->'quote') is distinct from 'string' or not coalesce(length(x->>'quote') between 1 and 5000,false)
          then return null; end if;
      end loop;
      if jsonb_array_length(f->'basis')<1 or exists(select 1 from jsonb_array_elements(f->'basis') basis where
        not exists(select 1 from jsonb_array_elements(b->'claims') claim where claim->>'claim'=basis->>'claim'
          and exists(select 1 from jsonb_array_elements_text(claim->'sourceIds') sid where sid=basis->>'sourceId'))
        or not exists(select 1 from jsonb_array_elements(c->'evidence') e where e->>'sourceId'=basis->>'sourceId'
          and length(basis->>'quote')>0 and position(basis->>'quote' in e->>'text')>0)) then return false; end if;
      if f->>'kind'='ambiguous' then
        if f->>'expected' is distinct from 'uncertain' or f->'minScore' is distinct from 'null'::jsonb
          or f->'maxScore' is distinct from 'null'::jsonb or f->'expectedPass' is distinct from 'null'::jsonb then return false; end if;
      else
        if not coalesce(f->>'minScore' ~ '^[0-5]$',false) or not coalesce(f->>'maxScore' ~ '^[0-5]$',false)
          or jsonb_typeof(f->'expectedPass') is distinct from 'boolean' then return null; end if;
        if f->>'expected' is distinct from 'scored' or (f->>'minScore')::integer>(f->>'maxScore')::integer
          or (f->>'expectedPass')::boolean is distinct from (f->>'kind' not in ('wrong','partial')) then return false; end if;
      end if;
    end loop;
    return true;
  end if;
  return null;
end;
$$;
create function private.evaluation_mismatches(c jsonb,o jsonb,err text) returns jsonb
language plpgsql set search_path='' as $$
declare expected jsonb:=c->'expected'; reasons text[]:='{}'; passed boolean; accepted boolean;
begin
  if c->>'stage'='policy' then
    if o->'policyIssues' is distinct from expected->'policy' then reasons:=array_append(reasons,'POLICY_EXPECTATION_MISMATCH'); end if;
  elsif err is not null and err<>'CHECK_FAILED' then reasons:=array_append(reasons,err);
  elsif c->>'stage'='grade' then
    if jsonb_typeof(o) is distinct from 'object' or not coalesce(o->>'outcome' in ('scored','uncertain'),false)
      then return '["INVALID_OUTPUT"]'::jsonb; end if;
    if o->>'outcome'='uncertain' then
      if o-array['outcome','reason']<>'{}' or jsonb_typeof(o->'reason') is distinct from 'string'
        or not coalesce(length(o->>'reason') between 1 and 2000,false) then return '["INVALID_OUTPUT"]'::jsonb; end if;
    else
      if not o ?& array['outcome','score','criticalClaimsMet','correctClaims','missingClaims','incorrectClaims','idealAnswer','explanation']
        or o-array['outcome','score','criticalClaimsMet','correctClaims','missingClaims','incorrectClaims','idealAnswer','explanation']<>'{}'
        or jsonb_typeof(o->'score') is distinct from 'number' or not coalesce(o->>'score' ~ '^[0-5]$',false)
        or jsonb_typeof(o->'criticalClaimsMet') is distinct from 'boolean'
        or jsonb_typeof(o->'correctClaims') is distinct from 'array' or jsonb_typeof(o->'missingClaims') is distinct from 'array'
        or jsonb_typeof(o->'incorrectClaims') is distinct from 'array'
        or jsonb_typeof(o->'idealAnswer') is distinct from 'string' or not coalesce(length(o->>'idealAnswer') between 1 and 5000,false)
        or jsonb_typeof(o->'explanation') is distinct from 'string' or not coalesce(length(o->>'explanation') between 1 and 2000,false)
        then return '["INVALID_OUTPUT"]'::jsonb; end if;
      if jsonb_array_length(o->'correctClaims')>10 or jsonb_array_length(o->'missingClaims')>10 or jsonb_array_length(o->'incorrectClaims')>10
        or exists(select 1 from jsonb_array_elements((o->'correctClaims')||(o->'missingClaims')||(o->'incorrectClaims')) v
          where jsonb_typeof(v)<>'string' or length(v#>>'{}') not between 1 and 500) then return '["INVALID_OUTPUT"]'::jsonb; end if;
    end if;
    if o->>'outcome' is distinct from expected->'grade'->>'outcome' then reasons:=array_append(reasons,'OUTCOME_REVERSAL');
    elsif o->>'outcome'='scored' then
      passed:=(o->>'score')::integer>=(c->'candidate'->'payload'->'rubric'->>'passScore')::integer and (o->>'criticalClaimsMet')::boolean;
      if not coalesce((o->>'score')::integer between (expected->'grade'->>'minScore')::integer and (expected->'grade'->>'maxScore')::integer,false)
        then reasons:=array_append(reasons,'SCORE_RANGE'); end if;
      if passed is distinct from (expected->'grade'->>'pass')::boolean then reasons:=array_append(reasons,'PASS_FAIL_REVERSAL'); end if;
    end if;
  else
    accepted:=private.evaluation_acceptance(c,o);
    if accepted is null then reasons:=array_append(reasons,'INVALID_OUTPUT');
    elsif accepted is distinct from (err is null) then reasons:=array_append(reasons,'VALIDATOR_DISAGREEMENT');
    elsif accepted is distinct from (expected->>'accepted')::boolean then reasons:=array_append(reasons,'ACCEPTANCE_REVERSAL');
    end if;
  end if;
  return to_jsonb(reasons);
end;
$$;

create function private.evaluation_finish(p_run uuid,p_lease uuid,p_reason text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.evaluation_jobs; i private.evaluation_inputs; results jsonb; report jsonb; c jsonb;
begin
  select * into j from private.evaluation_jobs where id=p_run for update;
  if found and j.state='completed' and j.lease is not distinct from p_lease then return private.evaluation_context(p_run); end if;
  if not found or j.state<>'running' or j.lease is distinct from p_lease or j.lease_until<=now() then raise exception 'STALE_LEASE'; end if;
  if p_reason is not null and p_reason<>'REQUEST_LIMIT' then raise exception 'EVALUATION_INPUT_INVALID'; end if;
  if p_reason='REQUEST_LIMIT' then
    if (select count(*) from private.provider_requests where evaluation_run=p_run)<
      (select (plan->'configuration'->>'maxRequests')::integer from private.evaluation_inputs where id=p_run)
      then raise exception 'STAGE_CONFLICT'; end if;
    loop
      c:=private.evaluation_case(p_run);
      exit when c is null;
      insert into private.evaluation_observations(run_id,case_id,error,terminal) values(p_run,c->>'id','REQUEST_LIMIT',true);
    end loop;
  end if;
  if private.evaluation_case(p_run) is not null then raise exception 'STAGE_CONFLICT'; end if;
  select * into i from private.evaluation_inputs where id=p_run;
  select jsonb_agg(jsonb_build_object('id',c.value->>'id','category',case when c.value->>'stage'='policy' then 'deterministic_policy'
      when i.plan->'configuration'->>'mode'='mock' then 'mock_transport' else 'model_observation' end,
    'output',o.output,'error',o.error,'mismatches',private.evaluation_mismatches(c.value,o.output,o.error)) order by c.n)
    into results from jsonb_array_elements(i.plan->'cases') with ordinality c(value,n)
    join private.evaluation_observations o on o.run_id=p_run and o.case_id=c.value->>'id' and o.terminal;
  report:=jsonb_build_object('identity',i.identity,'packageDigest',i.plan->>'packageDigest','datasetDigest',i.plan->>'datasetDigest',
    'configurationDigest',i.plan->>'configurationDigest','configuration',i.plan->'configuration','code',i.plan->'code',
    'status',case when i.plan->'configuration'->>'mode'='mock' then 'not_evaluated'
      when exists(select 1 from jsonb_array_elements(results) r where r->'mismatches'<>'[]') then 'observed_mismatches' else 'observations_complete' end,
    'approvalAuthority','none','cases',results,'requestsUsed',(select count(*) from private.provider_requests where evaluation_run=p_run),
    'costCents',(select coalesce(sum(coalesce(actual_cents,reserved_cents)),0) from private.provider_requests where evaluation_run=p_run),
    'requests',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'caseId',r.task,'ordinal',r.ordinal,'repair',r.repair,'request',r.qualification_prompt,
      'reservedCents',r.reserved_cents,'actualCents',r.actual_cents,'usage',r.usage,'createdAt',r.created_at) order by r.created_at,r.id) from private.provider_requests r where r.evaluation_run=p_run),'[]'),
    'observations',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'caseId',o.case_id,'requestId',o.request_id,'output',o.output,'error',o.error,'terminal',o.terminal,'createdAt',o.created_at)
      order by o.created_at,o.id) from private.evaluation_observations o where o.run_id=p_run),'[]'));
  insert into private.evaluation_reports values(p_run,report,private.content_digest(report),session_user,now());
  update private.evaluation_jobs set state='completed',reason=p_reason,updated_at=now() where id=p_run;
  return private.evaluation_context(p_run);
end;
$$;
create function private.evaluation_yield(p_run uuid,p_lease uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform 1 from private.evaluation_jobs where id=p_run and state='running' and lease=p_lease and lease_until>now() for update;
  if not found then raise exception 'STALE_LEASE'; end if;
  if p_reason is null or p_reason not in ('BUDGET_EXCEEDED','EVALUATION_DISABLED') then raise exception 'EVALUATION_INPUT_INVALID'; end if;
  update private.evaluation_jobs set state='queued',lease=null,lease_until=null,reason=p_reason,updated_at=now() where id=p_run;
  return private.evaluation_context(p_run);
end;
$$;
create function private.evaluation_export(p_run uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('plan',i.plan,'report',r.report,'reportDigest',r.digest)
    from private.evaluation_inputs i left join private.evaluation_reports r on r.run_id=i.id where i.id=p_run;
$$;
create or replace function public.settle_provider_request(p_request uuid,p_cents integer,p_usage jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
  if octet_length(p_usage::text)>2000 then raise exception 'VALIDATION_ERROR'; end if;
  update private.provider_requests set actual_cents=p_cents,usage=p_usage
    where id=p_request and actual_cents is null and attempt_id is not null and qualification_job is null and evaluation_run is null;
end;
$$;
do $$
declare signature text;
begin
  foreach signature in array array['evaluation_case(uuid)','evaluation_context(uuid)','evaluation_open(jsonb)','evaluation_advance(uuid)','evaluation_claim(uuid)',
    'evaluation_reserve(uuid,uuid,boolean)','evaluation_complete(uuid,uuid,uuid,jsonb,text,integer,jsonb)','evaluation_acceptance(jsonb,jsonb)','evaluation_mismatches(jsonb,jsonb,text)',
    'evaluation_finish(uuid,uuid,text)','evaluation_yield(uuid,uuid,text)','evaluation_export(uuid)'] loop
    execute 'alter function private.'||signature||' owner to evaluation_engine';
    execute 'revoke all on function private.'||signature||' from public,anon,authenticated,service_role';
  end loop;
end;
$$;
grant execute on function private.evaluation_open(jsonb),private.evaluation_export(uuid) to evaluation_operator;
grant execute on function private.evaluation_claim(uuid),private.evaluation_reserve(uuid,uuid,boolean),
  private.evaluation_complete(uuid,uuid,uuid,jsonb,text,integer,jsonb),private.evaluation_finish(uuid,uuid,text),
  private.evaluation_yield(uuid,uuid,text) to evaluation_worker;
revoke create on schema private from evaluation_engine;
revoke evaluation_engine from postgres;
