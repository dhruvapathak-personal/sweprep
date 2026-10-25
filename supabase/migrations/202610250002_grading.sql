create function private.recalculate_review(p_user uuid, p_question text) returns void
language plpgsql set search_path = '' as $$
declare
  r record;
  episode public.review_episodes;
  has_episode boolean := false;
begin
  delete from public.review_episodes where user_id = p_user and question_id = p_question;
  for r in
    select a.*, g.passed from public.attempts a
    join public.question_versions q on q.id = a.question_version_id
    join lateral (select s.grade_id from public.grade_selections s where s.attempt_id = a.id order by s.id desc limit 1) selected on true
    join public.attempt_grades g on g.id = selected.grade_id
    where a.user_id = p_user and q.question_id = p_question and g.outcome = 'scored' and not g.simulated
    order by a.submitted_at, a.id
  loop
    if not r.passed then
      if not has_episode or episode.graduated_at is not null then
        episode.id := r.id;
        episode.user_id := p_user;
        episode.question_id := p_question;
        episode.first_missed_at := r.submitted_at;
        episode.graduated_at := null;
        has_episode := true;
      end if;
      episode.streak := 0;
    elsif has_episode and episode.graduated_at is null and not r.assisted and r.source = 'review' then
      episode.streak := episode.streak + 1;
      if episode.streak >= 10 and r.submitted_at >= episode.first_missed_at + interval '720 hours' then
        episode.graduated_at := r.submitted_at;
      end if;
    end if;
    if has_episode then
      episode.next_due_at := case when episode.graduated_at is null then r.submitted_at +
        make_interval(secs => least(30.0, power(2.0, least(episode.streak,5))) * 86400 * (0.9 + r.scheduling_jitter * 0.2)) end;
      insert into public.review_episodes(id,user_id,question_id,first_missed_at,streak,graduated_at,next_due_at)
        values(episode.id,p_user,p_question,episode.first_missed_at,episode.streak,episode.graduated_at,episode.next_due_at)
        on conflict (id) do update set streak = excluded.streak, graduated_at = excluded.graduated_at, next_due_at = excluded.next_due_at;
    end if;
  end loop;
end;
$$;

create function public.claim_grading() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j public.grading_jobs;
begin
  select * into j from public.grading_jobs
    where (state in ('pending','retry_wait') and next_attempt_at <= now())
       or (state = 'grading' and lease_until < now())
    order by updated_at, attempt_id for update skip locked limit 1;
  if not found then return null; end if;
  if j.request_count >= 3 then
    update public.grading_jobs set state = 'failed', error_code = 'REQUEST_LIMIT', updated_at = now() where attempt_id = j.attempt_id;
    return null;
  end if;
  update public.grading_jobs set state = 'grading', lease_token = gen_random_uuid(),
    lease_until = now() + interval '90 seconds', updated_at = now()
    where attempt_id = j.attempt_id returning * into j;
  return (
    select jsonb_build_object('job', to_jsonb(j), 'attempt', to_jsonb(a), 'question', to_jsonb(q), 'rubric', to_jsonb(r))
    from public.attempts a join public.question_versions q on q.id = a.question_version_id
    join private.rubrics r on r.question_version_id = q.id where a.id = j.attempt_id
  );
end;
$$;

create function public.reserve_provider_request(
  p_attempt uuid, p_generation integer, p_lease uuid, p_cents integer,
  p_daily_cap integer, p_monthly_cap integer, p_repair boolean
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  j public.grading_jobs;
  v_id uuid;
  v_day integer;
  v_month integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(461920);
  select * into j from public.grading_jobs where attempt_id = p_attempt for update;
  if not found or j.state <> 'grading' or j.generation is distinct from p_generation or j.lease_token is distinct from p_lease or j.lease_until <= now() then raise exception 'STALE_LEASE'; end if;
  if p_cents is null or p_cents <= 0 or p_cents > 100 or p_daily_cap is null or p_monthly_cap is null or p_daily_cap not between 1 and 100 or p_monthly_cap not between 1 and 2000 or p_repair is null then raise exception 'BUDGET_EXCEEDED'; end if;
  if j.request_count >= 3 or (p_repair and j.repair_used) then raise exception 'REQUEST_LIMIT'; end if;
  select coalesce(sum(coalesce(actual_cents,reserved_cents)) filter (where created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),0),
    coalesce(sum(coalesce(actual_cents,reserved_cents)),0)
    into v_day,v_month from private.provider_requests
    where created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  if v_day + p_cents > p_daily_cap or v_month + p_cents > p_monthly_cap then raise exception 'BUDGET_EXCEEDED'; end if;
  insert into private.provider_requests(attempt_id,generation,ordinal,reserved_cents)
    values(p_attempt,p_generation,j.request_count+1,p_cents) returning id into v_id;
  update public.grading_jobs set request_count = request_count + 1,
    repair_used = repair_used or p_repair, updated_at = now() where attempt_id = p_attempt;
  return v_id;
end;
$$;

create function public.settle_provider_request(p_request uuid, p_cents integer, p_usage jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if octet_length(p_usage::text) > 2000 then raise exception 'VALIDATION_ERROR'; end if;
  update private.provider_requests set actual_cents = p_cents, usage = p_usage
    where id = p_request and actual_cents is null;
end;
$$;

create function public.fail_grading(
  p_attempt uuid, p_generation integer, p_lease uuid, p_error text, p_retry_seconds integer
) returns void
language plpgsql security definer set search_path = '' as $$
declare j public.grading_jobs;
begin
  select * into j from public.grading_jobs where attempt_id = p_attempt for update;
  if not found or j.state <> 'grading' or j.generation is distinct from p_generation or j.lease_token is distinct from p_lease or j.lease_until <= now() then raise exception 'STALE_LEASE'; end if;
  if p_error is null or p_retry_seconds is null or length(p_error) not between 1 and 100 or p_retry_seconds not between 0 and 86400 then raise exception 'VALIDATION_ERROR'; end if;
  update public.grading_jobs set state = case when p_retry_seconds > 0 and request_count < 3 then 'retry_wait' else 'failed' end,
    next_attempt_at = now() + make_interval(secs => p_retry_seconds), error_code = p_error,
    lease_token = null, lease_until = null, updated_at = now() where attempt_id = p_attempt;
end;
$$;

create function public.finalize_grade(
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
    if v_score is null or v_score not between 0 and 5 or jsonb_typeof(p_result->'criticalClaimsMet') is distinct from 'boolean' then raise exception 'VALIDATION_ERROR'; end if;
    v_passed := v_score >= r.pass_score and (p_result->>'criticalClaimsMet')::boolean;
  end if;
  insert into public.attempt_grades(user_id,attempt_id,generation,outcome,score,passed,details,rubric_version,
    grader_version,model,prompt_version,validator_version,worker_lease,simulated)
    values(a.user_id,a.id,p_generation,v_outcome,v_score,v_passed,p_result,r.version,
      'grader-v1',p_model,'grade-prompt-v1','grade-schema-v1',p_lease,p_simulated) returning id into v_grade;
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

revoke all on function public.claim_grading(),
  public.reserve_provider_request(uuid,integer,uuid,integer,integer,integer,boolean),
  public.settle_provider_request(uuid,integer,jsonb), public.fail_grading(uuid,integer,uuid,text,integer),
  public.finalize_grade(uuid,integer,uuid,jsonb,boolean,text) from public, anon, authenticated;
grant execute on function public.claim_grading(),
  public.reserve_provider_request(uuid,integer,uuid,integer,integer,integer,boolean),
  public.settle_provider_request(uuid,integer,jsonb), public.fail_grading(uuid,integer,uuid,text,integer),
  public.finalize_grade(uuid,integer,uuid,jsonb,boolean,text) to service_role;
