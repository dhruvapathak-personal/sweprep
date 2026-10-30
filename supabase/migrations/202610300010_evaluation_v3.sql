grant evaluation_engine,qualification_engine,content_engine,authoring_engine to postgres;
grant create on schema private to evaluation_engine;
update public.grading_jobs set state='failed',error_code='GRADING_REVISION_REQUIRED',
  lease_token=null,lease_until=null,updated_at=now() where state='grading';

update private.evaluation_jobs j set state='completed',reason='EVALUATION_REVISION_REQUIRED',
  lease=null,lease_until=null,updated_at=now()
  from private.evaluation_inputs i where i.id=j.id and j.state<>'completed'
    and i.plan->'configuration'->>'protocolVersion' is distinct from 'release-evaluation-v3';
update private.qualification_jobs j set state='rejected',reason='QUALIFICATION_DISABLED',
  lease=null,lease_until=null,updated_at=now()
  from private.qualification_inputs i join private.qualification_batches b on b.id=i.batch_id
  where i.id=j.id and j.state in ('queued','running')
    and b.configuration->>'modelEvaluationProtocolVersion' is distinct from 'release-evaluation-v3';
update private.authoring_jobs j set state='rejected',reason='AUTHORING_DISABLED',
  lease=null,lease_until=null,updated_at=now()
  from private.authoring_inputs i join private.qualification_batches b on b.id=i.batch_id
  where i.id=j.id and j.state in ('queued','running')
    and b.configuration->>'modelEvaluationProtocolVersion' is distinct from 'release-evaluation-v3';

create function private.evaluation_facets_valid(c jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare f jsonb:=c->'expected'->'facets'; b jsonb:=c->'candidate'; x jsonb; safe boolean;
  links jsonb:=case when b->>'kind'='question' then b->'payload'->'terms' else '[]'::jsonb end;
  fixtures jsonb:=case when b->>'kind'='question' then c->'fixtures'->'cases' else '[]'::jsonb end;
begin
  if c->>'stage' not in ('source','critic') then return f='null'::jsonb; end if;
  if jsonb_typeof(f) is distinct from 'object' or not f ?& array['privacy','originality','claims','fixtures','links']
    or f-array['privacy','originality','claims','fixtures','links']<>'{}'
    or not coalesce(f->>'privacy' in ('public','private_or_uncertain'),false)
    or not coalesce(f->>'originality' in ('original','reuse_or_uncertain'),false)
    or jsonb_typeof(f->'claims') is distinct from 'array'
    or jsonb_typeof(f->'fixtures') is distinct from 'array'
    or jsonb_typeof(f->'links') is distinct from 'array'
    or jsonb_typeof(c->'expected'->'accepted') is distinct from 'boolean'
    then return false; end if;
  if jsonb_array_length(f->'claims')>30 or jsonb_array_length(f->'fixtures')>5 or jsonb_array_length(f->'links')>20
    then return false; end if;
  for x in select value from jsonb_array_elements(f->'claims') loop
    if jsonb_typeof(x) is distinct from 'object' or not x ?& array['claim','sourceId','verdict']
      or x-array['claim','sourceId','verdict']<>'{}'
      or jsonb_typeof(x->'claim') is distinct from 'string' or jsonb_typeof(x->'sourceId') is distinct from 'string'
      or not coalesce(x->>'verdict' in ('supported','unsupported'),false)
      or not exists(select 1 from jsonb_array_elements(b->'claims') claim where claim->>'claim'=x->>'claim'
        and exists(select 1 from jsonb_array_elements_text(claim->'sourceIds') sid where sid=x->>'sourceId'))
      then return false; end if;
  end loop;
  for x in select value from jsonb_array_elements(f->'fixtures') loop
    if jsonb_typeof(x) is distinct from 'object' or not x ?& array['kind','verdict']
      or x-array['kind','verdict']<>'{}' or not coalesce(x->>'verdict' in ('supported','unsupported'),false)
      or not exists(select 1 from jsonb_array_elements(fixtures) fixture where fixture->>'kind'=x->>'kind')
      then return false; end if;
  end loop;
  for x in select value from jsonb_array_elements(f->'links') loop
    if jsonb_typeof(x) is distinct from 'object' or not x ?& array['termId','exposure','verdict']
      or x-array['termId','exposure','verdict']<>'{}'
      or not coalesce(x->>'verdict' in ('safe','post_grade_only','spoiler_or_uncertain'),false)
      or not exists(select 1 from jsonb_array_elements(links) link
        where link->>'termId'=x->>'termId' and link->>'exposure'=x->>'exposure')
      then return false; end if;
  end loop;
  if c->>'stage'='source' then
    if f->'fixtures'<>'[]' or f->'links'<>'[]'
      or jsonb_array_length(f->'claims') is distinct from jsonb_array_length(b->'claims')
      or (select count(distinct v->>'claim') from jsonb_array_elements(f->'claims') v)<>jsonb_array_length(f->'claims')
      then return false; end if;
  else
    if f->'claims'<>'[]' or fixtures is null
      or jsonb_array_length(f->'fixtures') is distinct from jsonb_array_length(fixtures)
      or (select count(distinct v->>'kind') from jsonb_array_elements(f->'fixtures') v)<>jsonb_array_length(f->'fixtures')
      or jsonb_array_length(f->'links') is distinct from jsonb_array_length(links)
      or (select count(distinct v->>'termId') from jsonb_array_elements(f->'links') v)<>jsonb_array_length(f->'links')
      then return false; end if;
  end if;
  safe:=f->>'privacy'='public' and f->>'originality'='original'
    and not exists(select 1 from jsonb_array_elements((f->'claims')||(f->'fixtures')) v where v->>'verdict'<>'supported')
    and not exists(select 1 from jsonb_array_elements(f->'links') v where
      v->>'verdict'<>case when v->>'exposure'='pre_attempt_safe' then 'safe' else 'post_grade_only' end);
  return safe=(c->'expected'->>'accepted')::boolean;
end;
$$;
alter function private.evaluation_facets_valid(jsonb) owner to evaluation_engine;
revoke all on function private.evaluation_facets_valid(jsonb) from public,anon,authenticated,service_role;

create function private.evaluation_facet_results(c jsonb,o jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare f jsonb:=c->'expected'->'facets'; result jsonb:='{}'; key text; wanted jsonb; observed jsonb;
begin
  if c->>'stage' not in ('source','critic') or jsonb_typeof(f) is distinct from 'object' then return result; end if;
  foreach key in array array['privacy','originality','claims','fixtures','links'] loop
    wanted:=f->key;
    observed:=o->key;
    if c->>'stage'='source' and key in ('fixtures','links') or c->>'stage'='critic' and key='claims' then
      observed:='[]';
    end if;
    if key in ('claims','fixtures','links') then
      select coalesce(jsonb_agg(v order by private.content_digest(v)),'[]') into wanted
        from jsonb_array_elements(wanted) v;
      if jsonb_typeof(observed)='array' then
        select coalesce(jsonb_agg(v order by private.content_digest(v)),'[]') into observed from (
          select case key
            when 'claims' then jsonb_build_object('claim',x->'claim','sourceId',x->'sourceId','verdict',
              case when exists(select 1 from jsonb_array_elements(c->'evidence') e
                where e->>'sourceId'=x->>'sourceId' and length(x->>'quote')>0 and position(x->>'quote' in e->>'text')>0)
                then x->'verdict' else 'null'::jsonb end)
            when 'fixtures' then jsonb_build_object('kind',x->'kind','verdict',x->'verdict')
            else jsonb_build_object('termId',x->'termId','exposure',x->'exposure','verdict',x->'verdict')
          end as v from jsonb_array_elements(observed) x
        ) findings;
      end if;
    end if;
    result:=result||jsonb_build_object(key,jsonb_build_object('expected',wanted,'observed',observed,
      'matched',wanted is not distinct from observed));
  end loop;
  return result;
end;
$$;
alter function private.evaluation_facet_results(jsonb,jsonb) owner to evaluation_engine;
revoke all on function private.evaluation_facet_results(jsonb,jsonb) from public,anon,authenticated,service_role;


create or replace function private.require_current_evaluation() returns trigger
language plpgsql set search_path='' as $$
begin
  if not exists(select 1 from private.evaluation_inputs where id=new.run_id
    and plan->'configuration'->>'protocolVersion'='release-evaluation-v3')
    then raise exception 'EVALUATION_DISABLED'; end if;
  return new;
end;
$$;

create or replace function private.passing_qualification(p_candidate uuid, p_run uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from private.qualification_runs r join private.content_candidates c on c.id = r.candidate_id
    where r.id = p_run and c.id = p_candidate and r.candidate_digest = c.digest and r.decision = 'qualified'
      and r.policy_version = 'content-policy-v2' and r.evidence_digest = private.content_digest(r.evidence)
      and r.evidence->>'bundleDigest' = c.digest
      and r.evidence->>'policyVersion' = r.policy_version
      and private.calibrated_rubric_v2(c.bundle)
      and r.evidence->>'modelVersion' = 'gpt-5.4-mini-2026-03-17'
      and r.evidence->>'promptVersion' = 'qualification-prompts-v3'
      and r.evidence->>'schemaVersion' = 'qualification-schema-v3'
      and r.evidence->>'modelEvaluationProtocolVersion' = 'release-evaluation-v3'
      and r.evidence->>'modelEvaluationDigest' ~ '^[a-f0-9]{64}$'
      and r.evidence->>'graderVersion' = 'grader-v3'
      and r.evidence->>'gradingPromptVersion' = 'grade-prompt-v3'
      and r.evidence->>'reasoningEffort'='low'
      and r.evidence->>'gradingSchemaVersion' = 'grade-schema-v1'
      and length(r.evidence->>'toolchainVersion') > 0 and r.evidence->>'fixtureVersion' = 'machine-fixtures-v2'
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
      and (c.kind = 'term' or r.evidence->'fixtureKinds' = '["wrong","partial","borderline_pass","strong","non_answer"]'::jsonb
        and r.evidence->>'fixtureAuthor' = 'machine' and r.evidence->>'graderReversals' = '0' and r.evidence->>'outOfRange' = '0')
  );
$$;

create or replace function public.finalize_grade(
  p_attempt uuid, p_generation integer, p_lease uuid, p_result jsonb,
  p_simulated boolean, p_model text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  j public.grading_jobs;
  a public.attempts;
  r private.rubrics;
  v_question text;
  v_grade uuid;
  v_finalized_lease uuid;
  v_previous uuid;
  v_outcome text := p_result->>'outcome';
  v_score integer;
  v_passed boolean;
begin
  select * into a from public.attempts where id = p_attempt;
  if not found then raise exception 'VALIDATION_ERROR'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(a.user_id::text, 1));
  select * into j from public.grading_jobs where attempt_id = p_attempt for update;
  select id,worker_lease into v_grade,v_finalized_lease from public.attempt_grades where attempt_id = p_attempt and generation = p_generation;
  if found then
    if j.generation = p_generation and v_finalized_lease = p_lease then return v_grade; end if;
    raise exception 'STALE_LEASE';
  end if;
  if j.state is distinct from 'grading' or j.generation is distinct from p_generation or j.lease_token is distinct from p_lease or j.lease_until <= now() then raise exception 'STALE_LEASE'; end if;
  select * into r from private.rubrics where question_version_id = a.question_version_id;
  if v_outcome not in ('scored','uncertain','invalidated') or v_outcome is null or
    jsonb_typeof(p_result) <> 'object' or octet_length(p_result::text) > 20000 or
    length(p_model) not between 1 and 100 or p_simulated is null then raise exception 'VALIDATION_ERROR'; end if;
  if v_outcome = 'scored' then
    if jsonb_typeof(p_result->'score') is distinct from 'number' or (p_result->>'score') !~ '^[0-5]$' then raise exception 'VALIDATION_ERROR'; end if;
    v_score := (p_result->>'score')::integer;
    if (p_result->>'criticalClaimsMet')::boolean is distinct from (v_score>=3) then raise exception 'VALIDATION_ERROR'; end if;
    if v_score is null or v_score not between 0 and 5 or jsonb_typeof(p_result->'criticalClaimsMet') is distinct from 'boolean' then raise exception 'VALIDATION_ERROR'; end if;
    v_passed := v_score >= r.pass_score and (p_result->>'criticalClaimsMet')::boolean;
  end if;
  insert into public.attempt_grades(user_id,attempt_id,generation,outcome,score,passed,details,rubric_version,
    grader_version,model,prompt_version,validator_version,worker_lease,simulated)
    values(a.user_id,a.id,p_generation,v_outcome,v_score,v_passed,p_result,r.version,
      'grader-v3',p_model,'grade-prompt-v3','grade-schema-v1',p_lease,p_simulated) returning id into v_grade;
  select grade_id into v_previous from public.grade_selections where attempt_id = p_attempt order by id desc limit 1;
  if v_outcome <> 'uncertain' or v_previous is null then
    insert into public.grade_selections(user_id,attempt_id,grade_id,previous_grade_id,reason)
      values(a.user_id,a.id,v_grade,v_previous,case when v_outcome = 'invalidated' then 'Explicit invalidation: ' || left(p_result->>'reason',260) else 'Validated grading generation' end);
  end if;
  update public.grading_jobs set state = case when v_outcome = 'scored' then 'scored' else 'uncertain' end,
    lease_token = null, lease_until = null, error_code = null, updated_at = now() where attempt_id = p_attempt;
  update public.session_items set state = 'graded' where id = a.item_id;
  update public.sessions set state = 'graded' where id = (select session_id from public.session_items where id = a.item_id);
  select question_id into v_question from public.question_versions where id = a.question_version_id;
  perform private.recalculate_review(a.user_id,v_question);
  return v_grade;
end;
$$;

create or replace function private.qualification_open_batch(p_configuration jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare id uuid; key text;
begin
  if jsonb_typeof(p_configuration) is distinct from 'object'
    or not p_configuration ?& array['policyVersion','modelVersion','promptVersion','schemaVersion','fixtureVersion','graderVersion','gradingPromptVersion','gradingSchemaVersion','reasoningEffort','toolchainVersion','modelEvaluationDigest','modelEvaluationProtocolVersion','privacyApprovalDigest','deploymentApprovalDigest','providerConfigurationDigest','enabled','publicationEnabled','requestCents','dailyCap','monthlyCap','batchCap','expiresAt']
    or p_configuration - array['policyVersion','modelVersion','promptVersion','schemaVersion','fixtureVersion','graderVersion','gradingPromptVersion','gradingSchemaVersion','reasoningEffort','toolchainVersion','modelEvaluationDigest','modelEvaluationProtocolVersion','privacyApprovalDigest','deploymentApprovalDigest','providerConfigurationDigest','enabled','publicationEnabled','requestCents','dailyCap','monthlyCap','batchCap','expiresAt'] <> '{}'
    or p_configuration->>'modelEvaluationProtocolVersion' is distinct from 'release-evaluation-v3'
    or p_configuration->>'policyVersion' is distinct from 'content-policy-v2'
    or p_configuration->>'modelVersion' is distinct from 'gpt-5.4-mini-2026-03-17'
    or p_configuration->>'promptVersion' is distinct from 'qualification-prompts-v3'
    or p_configuration->>'schemaVersion' is distinct from 'qualification-schema-v3'
    or p_configuration->>'fixtureVersion' is distinct from 'machine-fixtures-v2'
    or p_configuration->>'graderVersion' is distinct from 'grader-v3'
    or p_configuration->>'gradingPromptVersion' is distinct from 'grade-prompt-v3'
    or p_configuration->>'gradingSchemaVersion' is distinct from 'grade-schema-v1'
    or p_configuration->>'reasoningEffort' is distinct from 'low'
    or p_configuration->>'enabled' is distinct from 'true'
    or p_configuration->>'publicationEnabled' is distinct from 'false'
    or p_configuration->>'requestCents' is distinct from '10'
    or not coalesce((p_configuration->>'dailyCap')::integer between 1 and 1000,false)
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

create or replace function private.qualification_precheck(p_job uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare c private.content_candidates; evidence jsonb; s jsonb; e jsonb; d jsonb; reasons text[] := '{}'; duplicate uuid; similarity numeric;
begin
  if not exists(select 1 from private.qualification_inputs i join private.qualification_batches b on b.id=i.batch_id where i.id=p_job and b.configuration->>'policyVersion'='content-policy-v2' and b.configuration->>'modelEvaluationProtocolVersion'='release-evaluation-v3' and b.configuration->>'reasoningEffort'='low') then reasons:=array_append(reasons,'INCOMPATIBLE_VERSION'); end if;
  select candidate.* into c from private.content_candidates candidate join private.qualification_inputs i on i.candidate_id=candidate.id where i.id=p_job;
  select i.evidence into evidence from private.qualification_inputs i where i.id=p_job;
  if not private.calibrated_rubric_v2(c.bundle) then reasons:=array_append(reasons,'RUBRIC_CALIBRATION_REQUIRED'); end if;
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

create or replace function private.qualification_reserve_cost(p_job uuid,p_lease uuid,p_task text,p_repair boolean,p_prompt jsonb) returns uuid
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
  if configuration->>'modelEvaluationProtocolVersion' is distinct from 'release-evaluation-v3'
    or configuration->>'reasoningEffort' is distinct from 'low'
    or configuration->>'policyVersion' is distinct from 'content-policy-v2' or (configuration->>'expiresAt')::timestamptz<=now() then raise exception 'QUALIFICATION_DISABLED'; end if;
  if p_prompt->>'modelVersion' is distinct from configuration->>'modelVersion'
    or p_prompt->>'promptVersion' is distinct from configuration->>'promptVersion'
    or p_prompt->>'schemaVersion' is distinct from configuration->>'schemaVersion'
    or p_prompt->>'reasoningEffort' is distinct from configuration->>'reasoningEffort' then raise exception 'QUALIFICATION_DISABLED'; end if;
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

create or replace function private.qualification_finish(p_job uuid,p_lease uuid) returns jsonb
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
  if configuration->>'modelEvaluationProtocolVersion' is distinct from 'release-evaluation-v3'
    or configuration->>'reasoningEffort' is distinct from 'low'
    or configuration->>'policyVersion' is distinct from 'content-policy-v2' or (configuration->>'expiresAt')::timestamptz<=now() then
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
  if private.evaluation_acceptance(jsonb_build_object('stage','source','candidate',c.bundle,'evidence',i.evidence),source) is distinct from true
    then reasons:=array_append(reasons,'SOURCE_CHECK_FAILED'); end if;
  if private.evaluation_acceptance(jsonb_build_object('stage','critic','candidate',c.bundle,'evidence',i.evidence),critic) is distinct from true
    then reasons:=array_append(reasons,'CRITIC_OBJECTION'); end if;
  if c.kind='question' then
    if private.evaluation_acceptance(jsonb_build_object('stage','fixtures','candidate',c.bundle,'evidence',i.evidence),artifacts->'fixtures') is distinct from true
      then reasons:=array_append(reasons,'FIXTURES_INVALID'); end if;
    if jsonb_array_length(fixtures) is distinct from 5 or
      (select jsonb_agg(kind order by kind) from (select distinct x->>'kind' kind from jsonb_array_elements(fixtures) x) kinds)
      is distinct from '["borderline_pass","non_answer","partial","strong","wrong"]'::jsonb
      then reasons:=array_append(reasons,'FIXTURES_INVALID'); end if;
    for fixture in select value from jsonb_array_elements(fixtures) loop
      grade:=artifacts->('evaluate_'||(fixture->>'kind'));
      if not coalesce(length(fixture->>'reason')>0 and length(fixture->>'answer')>0,false)
        or not exists(select 1 from jsonb_array_elements(critic->'fixtures') f where f->>'kind'=fixture->>'kind' and f->>'verdict'='supported')
        then reasons:=array_append(reasons,'FIXTURE_UNSUPPORTED'); end if;
      if private.evaluation_mismatches(jsonb_build_object('stage','grade','candidate',c.bundle,
        'expected',jsonb_build_object('grade',jsonb_build_object('outcome',fixture->>'expected',
          'minScore',fixture->'minScore','maxScore',fixture->'maxScore','pass',fixture->'expectedPass'))),grade,null)<>'[]'::jsonb
        then reasons:=array_append(reasons,'GRADER_MISMATCH'); end if;
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
  select a.requests_used,a.lineage_requests_used into used,lineage_used from private.qualification_request_counts(p_job) a;
  select id into source_task from private.qualification_artifacts where job_id=p_job and task='source' and error is null;
  select id into critic_task from private.qualification_artifacts where job_id=p_job and task='critic' and error is null;
  select id into fixture_task from private.qualification_artifacts where job_id=p_job and task='fixtures' and error is null;
  receipt:=jsonb_build_object('reasoningEffort',configuration->>'reasoningEffort','bundleDigest',c.digest,'policyVersion','content-policy-v2','modelVersion',configuration->>'modelVersion',
    'graderVersion',configuration->>'graderVersion','gradingPromptVersion',configuration->>'gradingPromptVersion','gradingSchemaVersion',configuration->>'gradingSchemaVersion',
    'promptVersion',configuration->>'promptVersion','schemaVersion',configuration->>'schemaVersion','toolchainVersion',configuration->>'toolchainVersion','fixtureVersion',configuration->>'fixtureVersion',
    'modelEvaluationProtocolVersion',configuration->>'modelEvaluationProtocolVersion','modelEvaluationDigest',configuration->>'modelEvaluationDigest',
    'checks','{"schema":"pass","rights":"pass","claims":"pass","duplicates":"pass","critic":"pass","fixtures":"pass","grader":"pass","links":"pass","privacy":"pass"}'::jsonb,
    'criticObjections','[]'::jsonb,'authorTask',source_task,'criticTask',critic_task,'fixtureAuthorTask',fixture_task,
    'similarity','{"version":"jaccard-v1","threshold":0.85,"result":"clear"}'::jsonb,
    'dependencies',c.bundle->'dependencies','sourcesDigest',private.content_digest(c.bundle->'sources'),
    'execution',case when execution->>'status'='executed' then jsonb_build_object('status','pass','isolation','network-disabled-v1')
      else jsonb_build_object('status','not_applicable','reason',execution->>'reason') end,
    'requestsUsed',used,'lineageRequestsUsed',lineage_used,
    'fixtureKinds',case when c.kind='question' then '["wrong","partial","borderline_pass","strong","non_answer"]'::jsonb else '[]'::jsonb end,
    'fixtureAuthor','machine','graderReversals',0,'outOfRange',0,
    'applicability',case when c.kind='term' then 'Term-only: question fixtures and learner grading are not applicable.' else 'Five machine-authored consistency fixtures; not human gold or model-release evaluation.' end,
    'inputFingerprint',i.fingerprint,'configurationDigest',private.content_digest(configuration),'evidenceDigest',private.content_digest(i.evidence),
    'artifactDigest',private.content_digest(artifacts),'jobId',p_job);
  qualification:=gen_random_uuid();
  insert into private.qualification_runs(id,candidate_id,candidate_digest,policy_version,evidence,evidence_digest,decision)
    values(qualification,c.id,c.digest,'content-policy-v2',receipt,private.content_digest(receipt),'qualified');
  update private.qualification_jobs set state='qualified',qualification_id=qualification,updated_at=now() where id=p_job;
  return private.qualification_context(p_job);
end;
$$;

create or replace function private.evaluation_open(p_plan jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare configuration jsonb:=p_plan->'configuration'; key text; id uuid; previous private.evaluation_inputs; plan_identity text; study_scope text; entry_case jsonb; g jsonb;
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
  if configuration->>'protocolVersion' is distinct from 'release-evaluation-v3'
    or configuration->>'reasoningEffort' is distinct from 'low'
    or p_plan->'package'->>'schemaVersion' is distinct from '2'
    or configuration->>'policyVersion' is distinct from 'content-policy-v2'
    or configuration->>'modelVersion' is distinct from 'gpt-5.4-mini-2026-03-17'
    or configuration->>'promptVersion' is distinct from 'qualification-prompts-v3'
    or configuration->>'schemaVersion' is distinct from 'qualification-schema-v3'
    or configuration->>'fixtureVersion' is distinct from 'machine-fixtures-v2'
    or configuration->>'graderVersion' is distinct from 'grader-v3'
    or configuration->>'gradingPromptVersion' is distinct from 'grade-prompt-v3'
    or configuration->>'gradingSchemaVersion' is distinct from 'grade-schema-v1'
    or configuration->>'toolchainVersion' is distinct from 'conceptual-no-execution-v1'
    or configuration->>'inputUsdPerMillion' is distinct from '0.75'
    or configuration->>'outputUsdPerMillion' is distinct from '4.5'
    or configuration->>'requestCents' is distinct from '10'
    or not coalesce(configuration->>'mode' in ('live','mock'),false)
    or not coalesce((configuration->>'dailyCap')::integer between 1 and 1000,false)
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
  foreach key in array array['wrong','partial','borderline_pass','strong','non_answer','uncertain_context'] loop
    if not exists(select 1 from jsonb_array_elements(p_plan->'cases') entry
      where entry->>'stage'='grade' and entry->'expected'->'grade'->>'kind'=key)
      then raise exception 'EVALUATION_INPUT_INVALID'; end if;
  end loop;
  for entry_case in select value from jsonb_array_elements(p_plan->'cases') loop
    if private.evaluation_facets_valid(entry_case) is distinct from true then raise exception 'EVALUATION_INPUT_INVALID'; end if;
    if entry_case->>'stage'='policy' then continue; end if;
    if not private.calibrated_rubric_v2(entry_case->'candidate') then raise exception 'EVALUATION_INPUT_INVALID'; end if;
    if entry_case->>'stage'<>'grade' then continue; end if;
    g:=entry_case->'expected'->'grade';
    if entry_case->'candidate'->>'kind' is distinct from 'question' or jsonb_typeof(g) is distinct from 'object'
      or not coalesce(g->>'kind' in ('wrong','partial','borderline_pass','strong','non_answer','uncertain_context'),false)
      then raise exception 'EVALUATION_INPUT_INVALID'; end if;
    if g->>'kind'='uncertain_context' then
      if g->>'outcome' is distinct from 'uncertain' or g->'minScore' is distinct from 'null'::jsonb
        or g->'maxScore' is distinct from 'null'::jsonb or g->'pass' is distinct from 'null'::jsonb
        then raise exception 'EVALUATION_INPUT_INVALID'; end if;
    else
      if g->>'outcome' is distinct from 'scored' or jsonb_typeof(g->'minScore') is distinct from 'number'
        or jsonb_typeof(g->'maxScore') is distinct from 'number' or jsonb_typeof(g->'pass') is distinct from 'boolean'
        or not coalesce(g->>'minScore' ~ '^[0-5]$' and g->>'maxScore' ~ '^[0-5]$',false)
        then raise exception 'EVALUATION_INPUT_INVALID'; end if;
      if (g->>'minScore')::integer>(g->>'maxScore')::integer
        or (g->>'pass')::boolean is distinct from (g->>'kind' in ('borderline_pass','strong'))
        or (case when (g->>'pass')::boolean then (g->>'minScore')::integer<4 else (g->>'maxScore')::integer>=4 end)
        then raise exception 'EVALUATION_INPUT_INVALID'; end if;
    end if;
  end loop;
  for entry_case in select value from jsonb_array_elements(p_plan->'cases') where value->>'stage'<>'policy' loop
    foreach g in array array[entry_case->'requests'->'original',entry_case->'requests'->'repair'] loop
      if g->'reasoning' is distinct from '{"effort":"low"}'::jsonb
        or g->>'service_tier' is distinct from 'default' or g->>'max_output_tokens' is distinct from '3000'
        or g->>'model' is distinct from configuration->>'modelVersion' or g->>'store' is distinct from 'false'
        or g ? 'tools' then raise exception 'EVALUATION_INPUT_INVALID'; end if;
    end loop;
  end loop;
  plan_identity:=private.content_digest(jsonb_build_object('packageDigest',p_plan->>'packageDigest','datasetDigest',p_plan->>'datasetDigest',
    'codeDigest',configuration->>'codeDigest','protocolVersion',configuration->>'protocolVersion','modelVersion',configuration->>'modelVersion'));
  if plan_identity is distinct from p_plan->>'identity' then raise exception 'EVALUATION_INPUT_INVALID'; end if;
  perform pg_catalog.pg_advisory_xact_lock(813402);
  if exists(select 1 from private.evaluation_inputs where plan->'package'->>'id'=p_plan->'package'->>'id' and plan->>'packageDigest'<>p_plan->>'packageDigest')
    or exists(select 1 from private.evaluation_inputs where plan->'package'->'dataset'->>'id'=p_plan->'package'->'dataset'->>'id'
      and plan->'package'->'dataset'->'version'=p_plan->'package'->'dataset'->'version' and plan->>'datasetDigest'<>p_plan->>'datasetDigest')
    then raise exception 'EVALUATION_REVISION_REQUIRED'; end if;
  study_scope:=private.content_digest(jsonb_build_object(
    'cases',(select jsonb_agg(normalized order by private.content_digest(normalized))
      from (select private.evaluation_scope_case(c) normalized from jsonb_array_elements(p_plan->'package'->'dataset'->'cases') c) cases),
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

create or replace function private.evaluation_reserve(p_run uuid,p_lease uuid,p_repair boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare j private.evaluation_jobs; configuration jsonb; c jsonb; id uuid; task_count integer; used integer; day_cost integer; month_cost integer; run_cost integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(461920);
  select * into j from private.evaluation_jobs where evaluation_jobs.id=p_run for update;
  if not found or j.state<>'running' or j.lease is distinct from p_lease or j.lease_until<=now() then raise exception 'STALE_LEASE'; end if;
  select plan->'configuration' into configuration from private.evaluation_inputs where evaluation_inputs.id=p_run;
  if configuration->>'protocolVersion' is distinct from 'release-evaluation-v3' or (configuration->>'expiresAt')::timestamptz<=now() then raise exception 'EVALUATION_DISABLED'; end if;
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

create or replace function private.evaluation_acceptance(c jsonb,o jsonb) returns boolean
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
        or x-array['kind','verdict','reason']<>'{}' or not coalesce(x->>'kind' in ('wrong','partial','borderline_pass','strong','non_answer'),false)
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
    if jsonb_array_length(o->'links') is distinct from
      (case when b->>'kind'='question' then jsonb_array_length(b->'payload'->'terms') else 0 end)
      or (select count(distinct v->>'termId') from jsonb_array_elements(o->'links') v)<>jsonb_array_length(o->'links')
      then return false; end if;
    return o->>'privacy'='public' and o->>'originality'='original' and o->'objections'='[]' and jsonb_array_length(o->'proofLimits')>0
      and (b->>'kind'<>'question' or (
        not exists(select 1 from unnest(array['wrong','partial','borderline_pass','strong','non_answer']) kind where not exists(
          select 1 from jsonb_array_elements(o->'fixtures') finding where finding->>'kind'=kind and finding->>'verdict'='supported'))
        and not exists(select 1 from jsonb_array_elements(b->'payload'->'terms') link where not exists(
          select 1 from jsonb_array_elements(o->'links') finding where finding->>'termId'=link->>'termId' and finding->>'exposure'=link->>'exposure'
            and finding->>'verdict'=case when link->>'exposure'='pre_attempt_safe' then 'safe' else 'post_grade_only' end))));
  elsif c->>'stage'='fixtures' then
    if o-array['cases']<>'{}' or jsonb_typeof(o->'cases') is distinct from 'array' then return null; end if;
    if jsonb_array_length(o->'cases')<>5 or
      (select jsonb_agg(kind order by kind) from (select distinct value->>'kind' kind from jsonb_array_elements(o->'cases')) kinds)
      is distinct from '["borderline_pass","non_answer","partial","strong","wrong"]'::jsonb then return false; end if;
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
      if not coalesce(f->>'minScore' ~ '^[0-5]$',false) or not coalesce(f->>'maxScore' ~ '^[0-5]$',false)
        or jsonb_typeof(f->'minScore') is distinct from 'number' or jsonb_typeof(f->'maxScore') is distinct from 'number'
        or jsonb_typeof(f->'expectedPass') is distinct from 'boolean' then return null; end if;
      if f->>'expected' is distinct from 'scored' or (f->>'minScore')::integer>(f->>'maxScore')::integer
        or (f->>'expectedPass')::boolean is distinct from (f->>'kind' not in ('wrong','partial','non_answer'))
        or (case when (f->>'expectedPass')::boolean then (f->>'minScore')::integer<(b->'payload'->'rubric'->>'passScore')::integer
          else (f->>'maxScore')::integer>=(b->'payload'->'rubric'->>'passScore')::integer end) then return false; end if;
    end loop;
    return true;
  end if;
  return null;
end;
$$;

create or replace function private.evaluation_mismatches(c jsonb,o jsonb,err text) returns jsonb
language plpgsql set search_path='' as $$
declare expected jsonb:=c->'expected'; reasons text[]:='{}'; passed boolean; accepted boolean; facet text; result jsonb;
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
      if (o->>'criticalClaimsMet')::boolean is distinct from ((o->>'score')::integer>=3) then return '["INVALID_OUTPUT"]'::jsonb; end if;
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
    if accepted is not null then
      for facet,result in select * from jsonb_each(private.evaluation_facet_results(c,o)) loop
        if result->>'matched'='false' then reasons:=array_append(reasons,'FACET_'||upper(facet)||'_MISMATCH'); end if;
      end loop;
    end if;
  end if;
  return to_jsonb(reasons);
end;
$$;

create or replace function private.qualification_complete(p_job uuid,p_lease uuid,p_task text,p_request uuid,p_output jsonb,p_error text,p_cents integer,p_usage jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j private.qualification_jobs; request private.provider_requests; context jsonb; ordinal integer; charged integer;
begin
  select * into j from private.qualification_jobs where id=p_job for update;
  if not found or j.state<>'running' or j.lease is distinct from p_lease or j.lease_until<=now() then raise exception 'STALE_LEASE'; end if;
  if not exists(select 1 from private.qualification_inputs i join private.qualification_batches b on b.id=i.batch_id
    where i.id=p_job and b.configuration->>'modelEvaluationProtocolVersion'='release-evaluation-v3'
      and b.configuration->>'reasoningEffort'='low') then raise exception 'QUALIFICATION_DISABLED'; end if;
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
    if p_error is distinct from 'PROVIDER_TIMEOUT' and p_error is distinct from 'PROVIDER_REJECTED'
      and p_cents is not null and jsonb_typeof(p_usage->'inputTokens')='number' and jsonb_typeof(p_usage->'outputTokens')='number'
      and p_usage->>'inputTokens' ~ '^[0-9]{1,7}$' and p_usage->>'outputTokens' ~ '^[0-9]{1,4}$'
      and (p_usage->>'inputTokens')::integer<=1000000 and (p_usage->>'outputTokens')::integer<=3000 then
      charged:=ceil(((p_usage->>'inputTokens')::numeric*0.75+(p_usage->>'outputTokens')::numeric*4.5)/10000);
      if charged=p_cents and charged<=10 then
        update private.provider_requests set actual_cents=charged,usage=p_usage where id=p_request and actual_cents is null;
      end if;
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

create or replace function private.evaluation_complete(p_run uuid,p_lease uuid,p_request uuid,p_output jsonb,p_error text,p_cents integer,p_usage jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.evaluation_jobs; r private.provider_requests; terminal boolean; c jsonb; charged integer;
begin
  select * into j from private.evaluation_jobs where id=p_run for update;
  if not found or j.state<>'running' or j.lease is distinct from p_lease or j.lease_until<=now() then raise exception 'STALE_LEASE'; end if;
  if not exists(select 1 from private.evaluation_inputs where id=p_run
    and plan->'configuration'->>'protocolVersion'='release-evaluation-v3')
    then raise exception 'EVALUATION_DISABLED'; end if;
  select * into r from private.provider_requests where id=p_request and evaluation_run=p_run and worker_lease=p_lease;
  if not found then raise exception 'REQUEST_REQUIRED'; end if;
  if exists(select 1 from private.evaluation_observations where request_id=p_request) then return private.evaluation_context(p_run); end if;
  c:=private.evaluation_case(p_run);
  if c->>'id' is distinct from r.task or octet_length(p_output::text)>64000 or octet_length(p_usage::text)>2000
    or p_error is not null and p_error not in ('CHECK_FAILED','INVALID_OUTPUT','PROVIDER_TIMEOUT','PROVIDER_REJECTED')
    or p_cents is not null and p_cents not between 0 and 10 then raise exception 'EVALUATION_INPUT_INVALID'; end if;
  update private.provider_requests set usage=p_usage where id=p_request and actual_cents is null;
  if p_error is distinct from 'PROVIDER_TIMEOUT' and p_error is distinct from 'PROVIDER_REJECTED'
    and p_cents is not null and jsonb_typeof(p_usage->'inputTokens')='number' and jsonb_typeof(p_usage->'outputTokens')='number'
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

create or replace function private.evaluation_finish(p_run uuid,p_lease uuid,p_reason text default null) returns jsonb
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
    'output',o.output,'error',o.error,'facetResults',private.evaluation_facet_results(c.value,o.output),'mismatches',private.evaluation_mismatches(c.value,o.output,o.error)) order by c.n)
    into results from jsonb_array_elements(i.plan->'cases') with ordinality c(value,n)
    join private.evaluation_observations o on o.run_id=p_run and o.case_id=c.value->>'id' and o.terminal;
  report:=jsonb_build_object('schemaVersion','evaluation-report-v3','identity',i.identity,'packageDigest',i.plan->>'packageDigest','datasetDigest',i.plan->>'datasetDigest',
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

create or replace function private.authoring_open(p_plan jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare spec jsonb:=p_plan->'spec'; config jsonb; previous private.authoring_inputs;
  existing private.authoring_inputs; run uuid:=(spec->>'id')::uuid; candidate uuid:=gen_random_uuid();
  root uuid; parent uuid; version integer:=1; ordinal integer:=1; v_scope text; d jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(813401);
  select configuration into config from private.qualification_batches where id=(spec->>'batchId')::uuid;
  if not found or config->>'modelEvaluationProtocolVersion' is distinct from 'release-evaluation-v3'
    or config->>'reasoningEffort' is distinct from 'low'
    or config->>'policyVersion' is distinct from 'content-policy-v2'
    or config->>'toolchainVersion' is distinct from 'conceptual-no-execution-v1'
    or (config->>'expiresAt')::timestamptz<=now()
    or spec->'authorization'->>'promptVersion' is distinct from 'conceptual-authoring-prompts-v2'
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
      or d->'reasoning' is distinct from '{"effort":"low"}'::jsonb or d->>'service_tier' is distinct from 'default'
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

create or replace function private.authoring_reserve(p_run uuid,p_lease uuid,p_repair boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare i private.authoring_inputs; config jsonb; used integer; request uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(461920);
  perform 1 from private.authoring_jobs where id=p_run and state='running' and lease=p_lease and lease_until>now() for update;
  if not found then raise exception 'STALE_LEASE'; end if;
  select * into i from private.authoring_inputs where id=p_run;
  select configuration into config from private.qualification_batches where id=i.batch_id;
  if config->>'modelEvaluationProtocolVersion' is distinct from 'release-evaluation-v3'
    or config->>'reasoningEffort' is distinct from 'low' or config->>'policyVersion' is distinct from 'content-policy-v2' or (config->>'expiresAt')::timestamptz<=now() then raise exception 'AUTHORING_DISABLED'; end if;
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

create or replace function private.authoring_complete(p_run uuid,p_lease uuid,p_request uuid,p_bundle jsonb,p_error text,p_cents integer,p_usage jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i private.authoring_inputs; r private.provider_requests; charged integer;
begin
  perform 1 from private.authoring_jobs where id=p_run and state='running' and lease=p_lease and lease_until>now() for update;
  if not found then raise exception 'STALE_LEASE'; end if;
  select * into r from private.provider_requests where id=p_request and authoring_run=p_run and worker_lease=p_lease;
  if not found then raise exception 'REQUEST_REQUIRED'; end if;
  if exists(select 1 from private.authoring_artifacts where request_id=p_request) then return private.authoring_context(p_run); end if;
  select * into i from private.authoring_inputs where id=p_run;
  if not exists(select 1 from private.qualification_batches b where b.id=i.batch_id
    and b.configuration->>'modelEvaluationProtocolVersion'='release-evaluation-v3'
    and b.configuration->>'reasoningEffort'='low') then raise exception 'AUTHORING_DISABLED'; end if;
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

create or replace function private.qualification_enqueue(p_candidate uuid,p_batch uuid,p_evidence jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare c private.content_candidates; previous private.qualification_inputs; existing private.qualification_inputs;
  id uuid := gen_random_uuid(); root uuid; ordinal integer := 1; fingerprint text; configuration jsonb; authored private.authoring_inputs;
begin
  perform pg_catalog.pg_advisory_xact_lock(813401);
  select * into c from private.content_candidates where content_candidates.id = p_candidate;
  if not found then raise exception 'CANDIDATE_REQUIRED'; end if;
  select b.configuration into configuration from private.qualification_batches b where b.id = p_batch;
  if not found or configuration->>'modelEvaluationProtocolVersion' is distinct from 'release-evaluation-v3'
    or configuration->>'reasoningEffort' is distinct from 'low' or (configuration->>'expiresAt')::timestamptz <= now() then raise exception 'QUALIFICATION_DISABLED'; end if;
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
    if exists(select 1 from private.authoring_artifacts a join private.authoring_inputs ai on ai.id=a.run_id where a.error is null
      and private.evaluation_scope_case(jsonb_build_object('candidate',a.bundle-'origin','dependencies',ai.plan->'spec'->'dependencies'))
        =private.evaluation_scope_case(jsonb_build_object('candidate',c.bundle-'origin','dependencies',
          (select coalesce(jsonb_agg(d.bundle),'[]') from jsonb_array_elements(c.bundle->'dependencies') ref
            join private.content_candidates d on d.id=(ref->>'id')::uuid))))
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

revoke create on schema private from evaluation_engine;
revoke evaluation_engine,qualification_engine,content_engine,authoring_engine from postgres;
