create or replace function public.start_study(p_question uuid, p_timezone text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_session uuid;
  v_item uuid;
  v_source text;
begin
  if v_user is null then raise exception 'UNAUTHENTICATED'; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then raise exception 'VALIDATION_ERROR'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text, 0));
  perform 1 from private.content_catalog_revision for share;
  if not public.content_is_qualified(p_question,true) then raise exception 'CONTENT_CHANGED'; end if;
  select i.id into v_item from public.session_items i join public.sessions s on s.id = i.session_id
    where s.user_id = v_user and s.state = 'active';
  if v_item is not null then return v_item; end if;
  insert into public.profiles(user_id, timezone) values(v_user, p_timezone) on conflict do nothing;
  v_source := case when exists (
    select 1 from public.attempts a join public.question_versions q on q.id = a.question_version_id
    where a.user_id = v_user and q.question_id = (select question_id from public.question_versions where id = p_question)
  ) then 'review' else 'first' end;
  insert into public.sessions(user_id) values(v_user) returning id into v_session;
  insert into public.session_items(user_id, session_id, question_version_id, source)
    values(v_user, v_session, p_question, v_source) returning id into v_item;
  return v_item;
end;
$$;

create or replace function public.study_state() returns jsonb
language sql stable security invoker set search_path = '' as $$
  with profile as (
    select coalesce((select timezone from public.profiles where user_id = auth.uid()),'UTC') as zone
  ), bounds as (
    select ((now() at time zone zone)::date::timestamp at time zone zone) as start_at,
      (((now() at time zone zone)::date + 1)::timestamp at time zone zone) as end_at from profile
  ), recent_attempts as (
    select * from public.attempts order by submitted_at desc, id limit 100
  ), owned_items as (
    select i.*, coalesce((select sum(extract(epoch from (t.ended_at - t.started_at))*1000)::bigint
      from public.timing_segments t where t.item_id = i.id),0) as active_ms
    from public.session_items i where i.state = 'answering' or i.id in (select item_id from recent_attempts)
  )
  select jsonb_build_object(
    'serverNow', now(),
    'timezone', (select zone from profile),
    'todayMs', coalesce((select sum(extract(epoch from (least(t.ended_at,b.end_at) - greatest(t.started_at,b.start_at)))*1000)::bigint
      from public.timing_segments t cross join bounds b where t.ended_at > b.start_at and t.started_at < b.end_at),0),
    'pinnedQuestions', coalesce((select jsonb_agg(q) from public.question_versions q
      where q.id in (select question_version_id from owned_items union select question_version_id from recent_attempts)),'[]'::jsonb),
    'items', coalesce((select jsonb_agg(i order by i.displayed_at desc,i.id) from owned_items i),'[]'::jsonb),
    'attempts', coalesce((select jsonb_agg(a order by a.submitted_at desc,a.id) from recent_attempts a),'[]'::jsonb),
    'jobs', coalesce((select jsonb_agg(j) from public.grading_jobs j where attempt_id in (select id from recent_attempts)),'[]'::jsonb),
    'grades', coalesce((select jsonb_agg(g) from public.attempt_grades g where attempt_id in (select id from recent_attempts)),'[]'::jsonb),
    'selections', coalesce((select jsonb_agg(s order by s.id) from public.grade_selections s where attempt_id in (select id from recent_attempts)),'[]'::jsonb)
  );
$$;

alter function public.claim_grading() rename to claim_grading_original;
alter function public.claim_grading_original() set schema private;
revoke all on function private.claim_grading_original() from public, anon, authenticated, service_role;
create function public.claim_grading() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare work jsonb;
begin
  work := private.claim_grading_original();
  if work is null then return null; end if;
  return work || jsonb_build_object('qualificationPolicy',
    case when public.content_is_qualified((work->'question'->>'id')::uuid) then 'content-policy-v1' end);
end;
$$;
revoke all on function public.claim_grading() from public, anon, authenticated;
grant execute on function public.claim_grading() to service_role;

create function private.require_qualified_provider_content() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists(select 1 from public.attempts a where a.id = new.attempt_id and public.content_is_qualified(a.question_version_id))
    then raise exception 'QUALIFICATION_REQUIRED'; end if;
  return new;
end;
$$;
create trigger qualified_provider_content before insert on private.provider_requests for each row execute function private.require_qualified_provider_content();
