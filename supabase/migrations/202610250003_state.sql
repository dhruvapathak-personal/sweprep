create function public.study_state() returns jsonb
language sql stable security invoker set search_path = '' as $$
  with profile as (
    select coalesce((select timezone from public.profiles where user_id = auth.uid()),'UTC') as zone
  ), bounds as (
    select ((now() at time zone zone)::date::timestamp at time zone zone) as start_at,
      (((now() at time zone zone)::date + 1)::timestamp at time zone zone) as end_at from profile
  ), recent_items as (
    select i.*, coalesce((select sum(extract(epoch from (t.ended_at - t.started_at))*1000)::bigint
      from public.timing_segments t where t.item_id = i.id),0) as active_ms
    from public.session_items i order by i.displayed_at desc, i.id limit 100
  ), recent_attempts as (
    select * from public.attempts order by submitted_at desc, id limit 100
  )
  select jsonb_build_object(
    'serverNow', now(),
    'timezone', (select zone from profile),
    'todayMs', coalesce((select sum(extract(epoch from (least(t.ended_at,b.end_at) - greatest(t.started_at,b.start_at)))*1000)::bigint
      from public.timing_segments t cross join bounds b where t.ended_at > b.start_at and t.started_at < b.end_at),0),
    'questions', coalesce((select jsonb_agg(q) from (select * from public.question_versions order by id limit 100) q),'[]'::jsonb),
    'items', coalesce((select jsonb_agg(i) from recent_items i),'[]'::jsonb),
    'attempts', coalesce((select jsonb_agg(a) from recent_attempts a),'[]'::jsonb),
    'jobs', coalesce((select jsonb_agg(j) from public.grading_jobs j where attempt_id in (select id from recent_attempts)),'[]'::jsonb),
    'grades', coalesce((select jsonb_agg(g) from public.attempt_grades g where attempt_id in (select id from recent_attempts)),'[]'::jsonb),
    'selections', coalesce((select jsonb_agg(s order by s.id) from public.grade_selections s where attempt_id in (select id from recent_attempts)),'[]'::jsonb)
  );
$$;
revoke all on function public.study_state() from public, anon;
grant execute on function public.study_state() to authenticated;
