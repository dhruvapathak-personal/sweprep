create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema private revoke execute on functions from public;

create table public.profiles (
  user_id uuid primary key references auth.users on delete cascade,
  timezone text not null default 'UTC' check (length(timezone) between 1 and 100),
  created_at timestamptz not null default now()
);

create table public.question_versions (
  id uuid primary key,
  question_id text not null check (length(question_id) between 1 and 100),
  version integer not null check (version > 0),
  title text not null check (length(title) between 1 and 200),
  skill text not null check (length(skill) between 1 and 100),
  content_blocks jsonb not null check (jsonb_typeof(content_blocks) = 'array' and octet_length(content_blocks::text) < 20000),
  content_review text not null check (content_review in ('candidate', 'approved')),
  prompt_version text not null,
  unique (question_id, version)
);

create table private.rubrics (
  question_version_id uuid primary key references public.question_versions,
  version text not null,
  pass_score integer not null check (pass_score between 0 and 5),
  required_claims text[] not null,
  reference_answer text not null check (length(reference_answer) between 1 and 10000)
);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  state text not null default 'active' check (state in ('active', 'submitted', 'graded')),
  started_at timestamptz not null default now(),
  unique (id, user_id)
);
create unique index one_active_session on public.sessions(user_id) where state = 'active';

create table public.session_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  session_id uuid not null,
  question_version_id uuid not null references public.question_versions,
  sequence integer not null default 1 check (sequence = 1),
  source text not null check (source in ('first', 'review')),
  state text not null default 'answering' check (state in ('answering', 'submitted', 'graded')),
  answer_text text not null default '' check (length(answer_text) <= 12000),
  confidence text not null default 'unsure' check (confidence in ('guess', 'unsure', 'fairly_sure', 'certain')),
  assisted boolean not null default false,
  version integer not null default 0 check (version >= 0),
  displayed_at timestamptz not null default now(),
  first_interaction_at timestamptz,
  saved_at timestamptz not null default now(),
  lease_device uuid,
  lease_until timestamptz,
  last_ack_at timestamptz,
  paused boolean not null default true,
  foreign key (session_id, user_id) references public.sessions(id, user_id),
  unique (session_id, sequence),
  unique (id, user_id),
  unique (id, user_id, question_version_id)
);

create table public.timing_segments (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  item_id uuid not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  foreign key (item_id, user_id) references public.session_items(id, user_id),
  check (ended_at >= started_at and ended_at - started_at <= interval '30 seconds')
);

create table public.attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  item_id uuid not null unique,
  question_version_id uuid not null,
  answer_text text not null check (length(btrim(answer_text)) between 1 and 12000),
  confidence text not null check (confidence in ('guess', 'unsure', 'fairly_sure', 'certain')),
  assisted boolean not null,
  source text not null check (source in ('first', 'review')),
  input_mode text not null default 'text' check (input_mode = 'text'),
  active_ms bigint not null check (active_ms >= 0),
  submitted_at timestamptz not null default now(),
  idempotency_key uuid not null,
  request_fingerprint text not null,
  scheduling_jitter double precision not null default random() check (scheduling_jitter >= 0 and scheduling_jitter <= 1),
  foreign key (item_id, user_id, question_version_id) references public.session_items(id, user_id, question_version_id),
  unique (user_id, idempotency_key),
  unique (id, user_id)
);

create table public.grading_jobs (
  attempt_id uuid primary key,
  user_id uuid not null references auth.users on delete cascade,
  generation integer not null default 1 check (generation > 0),
  state text not null default 'pending' check (state in ('pending', 'grading', 'retry_wait', 'failed', 'uncertain', 'scored')),
  request_count integer not null default 0 check (request_count between 0 and 3),
  repair_used boolean not null default false,
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  error_code text check (length(error_code) <= 100),
  updated_at timestamptz not null default now(),
  foreign key (attempt_id, user_id) references public.attempts(id, user_id)
);

create table public.attempt_grades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  attempt_id uuid not null,
  generation integer not null check (generation > 0),
  outcome text not null check (outcome in ('scored', 'uncertain', 'invalidated')),
  score integer check (score between 0 and 5),
  passed boolean,
  details jsonb not null check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 20000),
  rubric_version text not null,
  grader_version text not null,
  model text not null,
  prompt_version text not null,
  validator_version text not null,
  simulated boolean not null,
  created_at timestamptz not null default now(),
  foreign key (attempt_id, user_id) references public.attempts(id, user_id),
  unique (attempt_id, generation),
  unique (id, attempt_id, user_id),
  check ((outcome = 'scored' and score is not null and passed is not null) or
         (outcome <> 'scored' and score is null and passed is null))
);

create table public.grade_selections (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  attempt_id uuid not null,
  grade_id uuid not null,
  previous_grade_id uuid references public.attempt_grades,
  reason text not null check (length(reason) between 1 and 300),
  selected_at timestamptz not null default now(),
  foreign key (grade_id, attempt_id, user_id) references public.attempt_grades(id, attempt_id, user_id)
);

create table public.review_episodes (
  id uuid primary key references public.attempts,
  user_id uuid not null references auth.users on delete cascade,
  question_id text not null,
  first_missed_at timestamptz not null,
  streak integer not null check (streak >= 0),
  graduated_at timestamptz,
  next_due_at timestamptz,
  rules_version text not null default 'review-v1'
);

create table private.provider_requests (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.attempts,
  generation integer not null,
  ordinal integer not null check (ordinal between 1 and 3),
  reserved_cents integer not null check (reserved_cents > 0),
  actual_cents integer check (actual_cents between 0 and reserved_cents),
  usage jsonb,
  created_at timestamptz not null default now(),
  unique (attempt_id, generation, ordinal)
);

create function private.immutable_history() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'IMMUTABLE_HISTORY';
end;
$$;

create trigger attempts_immutable before update or delete on public.attempts for each row execute function private.immutable_history();
create trigger grades_immutable before update or delete on public.attempt_grades for each row execute function private.immutable_history();
create trigger selections_immutable before update or delete on public.grade_selections for each row execute function private.immutable_history();
create trigger questions_immutable before update or delete on public.question_versions for each row execute function private.immutable_history();
create trigger rubrics_immutable before update or delete on private.rubrics for each row execute function private.immutable_history();

alter table public.profiles enable row level security;
alter table public.question_versions enable row level security;
alter table public.sessions enable row level security;
alter table public.session_items enable row level security;
alter table public.timing_segments enable row level security;
alter table public.attempts enable row level security;
alter table public.grading_jobs enable row level security;
alter table public.attempt_grades enable row level security;
alter table public.grade_selections enable row level security;
alter table public.review_episodes enable row level security;
alter table private.rubrics enable row level security;
alter table private.provider_requests enable row level security;

create policy own_profile on public.profiles for select to authenticated using (user_id = (select auth.uid()));
create policy signed_in_questions on public.question_versions for select to authenticated using (true);
create policy own_sessions on public.sessions for select to authenticated using (user_id = (select auth.uid()));
create policy own_items on public.session_items for select to authenticated using (user_id = (select auth.uid()));
create policy own_time on public.timing_segments for select to authenticated using (user_id = (select auth.uid()));
create policy own_attempts on public.attempts for select to authenticated using (user_id = (select auth.uid()));
create policy own_jobs on public.grading_jobs for select to authenticated using (user_id = (select auth.uid()));
create policy own_grades on public.attempt_grades for select to authenticated using (user_id = (select auth.uid()));
create policy own_selections on public.grade_selections for select to authenticated using (user_id = (select auth.uid()));
create policy own_episodes on public.review_episodes for select to authenticated using (user_id = (select auth.uid()));

revoke all on all tables in schema public from anon, authenticated;
grant select on public.profiles, public.question_versions, public.sessions, public.session_items,
  public.timing_segments, public.attempts, public.grading_jobs, public.attempt_grades,
  public.grade_selections, public.review_episodes to authenticated;
revoke all on all tables in schema private from anon, authenticated, service_role;

create function public.start_study(p_question uuid, p_timezone text) returns uuid
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
  select i.id into v_item from public.session_items i join public.sessions s on s.id = i.session_id
    where s.user_id = v_user and s.state = 'active';
  if v_item is not null then return v_item; end if;
  if not exists (select 1 from public.question_versions where id = p_question) then raise exception 'VALIDATION_ERROR'; end if;
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

create function public.checkpoint(
  p_item uuid, p_version integer, p_answer text, p_confidence text, p_assisted boolean,
  p_device uuid, p_action text
) returns public.session_items
language plpgsql security definer set search_path = '' as $$
declare
  v public.session_items;
  t timestamptz := clock_timestamp();
begin
  select * into v from public.session_items where id = p_item and user_id = auth.uid() for update;
  if not found then raise exception 'FORBIDDEN'; end if;
  if v.state <> 'answering' then raise exception 'ALREADY_SUBMITTED'; end if;
  if v.version is distinct from p_version then raise exception 'SYNC_CONFLICT'; end if;
  if p_answer is null or length(p_answer) > 12000 or p_confidence is null or p_confidence not in ('guess','unsure','fairly_sure','certain')
    or p_assisted is null or p_device is null or p_action is null or p_action not in ('save','claim','takeover','pause','resume') then
    raise exception 'VALIDATION_ERROR';
  end if;
  if v.lease_device is not null and v.lease_device is distinct from p_device and
    (p_action not in ('claim','takeover') or (v.lease_until > t and p_action <> 'takeover')) then
    raise exception 'TIMER_OWNED';
  end if;
  if v.lease_device = p_device and v.lease_until > t and not v.paused then
    insert into public.timing_segments(user_id, item_id, started_at, ended_at)
      values(v.user_id, v.id, v.last_ack_at, t);
  end if;
  if p_action in ('claim','takeover','resume') then
    v.lease_device := p_device;
    v.paused := false;
  elsif p_action = 'pause' or v.lease_until <= t then
    v.paused := true;
  end if;
  if v.lease_device = p_device then
    v.last_ack_at := t;
    v.lease_until := t + interval '30 seconds';
  end if;
  update public.session_items set
    answer_text = p_answer, confidence = p_confidence, assisted = assisted or p_assisted,
    version = version + 1, saved_at = t,
    first_interaction_at = case when length(p_answer) > 0 then coalesce(first_interaction_at, t) else first_interaction_at end,
    lease_device = v.lease_device, lease_until = v.lease_until, last_ack_at = v.last_ack_at, paused = v.paused
    where id = p_item returning * into v;
  return v;
end;
$$;

create function public.submit_answer(
  p_item uuid, p_version integer, p_question uuid, p_answer text, p_confidence text,
  p_assisted boolean, p_device uuid, p_key uuid
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v public.session_items;
  a public.attempts;
  v_fingerprint text;
  v_id uuid;
  v_ms bigint;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_answer is null or length(btrim(p_answer)) not between 1 and 12000 or p_key is null or p_question is null or
    p_confidence is null or p_confidence not in ('guess','unsure','fairly_sure','certain') or p_assisted is null then raise exception 'VALIDATION_ERROR'; end if;
  v_fingerprint := encode(extensions.digest(jsonb_build_array(p_item,p_question,p_answer,p_confidence,p_assisted)::text, 'sha256'), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text || p_key::text, 0));
  select * into a from public.attempts where user_id = auth.uid() and idempotency_key = p_key;
  if found then
    if a.request_fingerprint <> v_fingerprint then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return a.id;
  end if;
  select * into v from public.session_items where id = p_item and user_id = auth.uid() for update;
  if not found then raise exception 'FORBIDDEN'; end if;
  if v.state <> 'answering' then raise exception 'ALREADY_SUBMITTED'; end if;
  if v.question_version_id <> p_question then raise exception 'VALIDATION_ERROR'; end if;
  v := public.checkpoint(p_item,p_version,p_answer,p_confidence,p_assisted,p_device,'pause');
  select coalesce(sum(extract(epoch from (ended_at - started_at)) * 1000),0)::bigint
    into v_ms from public.timing_segments where item_id = p_item;
  insert into public.attempts(user_id,item_id,question_version_id,answer_text,confidence,assisted,source,active_ms,idempotency_key,request_fingerprint)
    values(v.user_id,v.id,v.question_version_id,p_answer,p_confidence,v.assisted,v.source,v_ms,p_key,v_fingerprint) returning id into v_id;
  insert into public.grading_jobs(attempt_id,user_id) values(v_id,v.user_id);
  update public.session_items set state = 'submitted' where id = v.id;
  update public.sessions set state = 'submitted' where id = v.session_id;
  return v_id;
end;
$$;

create function public.retry_grade(p_attempt uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare j public.grading_jobs;
begin
  select * into j from public.grading_jobs where attempt_id = p_attempt and user_id = auth.uid() for update;
  if not found then raise exception 'FORBIDDEN'; end if;
  if j.state not in ('failed','uncertain','scored') then raise exception 'GRADING_PENDING'; end if;
  if j.generation >= 10 then raise exception 'RETRY_LIMIT'; end if;
  update public.grading_jobs set generation = generation + 1, state = 'pending', request_count = 0,
    repair_used = false, lease_token = null, lease_until = null, next_attempt_at = now(), error_code = null, updated_at = now()
    where attempt_id = p_attempt returning * into j;
  return j.generation;
end;
$$;

revoke all on function public.start_study(uuid,text), public.checkpoint(uuid,integer,text,text,boolean,uuid,text),
  public.submit_answer(uuid,integer,uuid,text,text,boolean,uuid,uuid), public.retry_grade(uuid) from public, anon;
grant execute on function public.start_study(uuid,text), public.checkpoint(uuid,integer,text,text,boolean,uuid,text),
  public.submit_answer(uuid,integer,uuid,text,text,boolean,uuid,uuid), public.retry_grade(uuid) to authenticated;
