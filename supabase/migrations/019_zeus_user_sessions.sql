create table if not exists public.zeus_user_sessions (
  session_key text primary key
    check (session_key ~ '^user:[1-9][0-9]{0,15}$'),
  payload jsonb not null
    check (jsonb_typeof(payload) = 'object')
    check (octet_length(payload::text) <= 16384),
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  pending_action_expires_at timestamptz
);

alter table public.zeus_user_sessions enable row level security;
revoke all on table public.zeus_user_sessions from public, anon, authenticated;

create or replace function public.zeus_read_user_session(p_session_key text)
returns table (
  payload jsonb,
  version bigint,
  expires_at timestamptz,
  pending_action_expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_session_key is null
    or p_session_key !~ '^user:[1-9][0-9]{0,15}$' then
    raise exception 'Invalid ZEUS session key' using errcode = '22023';
  end if;

  delete from public.zeus_user_sessions as sessions
  where sessions.session_key = p_session_key
    and sessions.expires_at <= clock_timestamp();

  return query
    select sessions.payload,
      sessions.version,
      sessions.expires_at,
      sessions.pending_action_expires_at
    from public.zeus_user_sessions as sessions
    where sessions.session_key = p_session_key;
end;
$$;

create or replace function public.zeus_write_user_session(
  p_session_key text,
  p_payload jsonb,
  p_expected_version bigint,
  p_session_ttl_seconds integer,
  p_pending_ttl_seconds integer
)
returns table (version bigint)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_version bigint;
begin
  if p_session_key is null
    or p_session_key !~ '^user:[1-9][0-9]{0,15}$'
    or p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or octet_length(p_payload::text) > 16384
    or p_payload - array[
      'selectedGroupId',
      'selectedGroupTitle',
      'selectedVerifiedSearch',
      'pendingAction',
      'verifiedConfirmation'
    ] <> '{}'::jsonb
    or p_expected_version is null
    or p_expected_version < 0
    or p_session_ttl_seconds not between 60 and 2592000
    or p_pending_ttl_seconds not between 60 and 3600 then
    raise exception 'Invalid ZEUS user session payload' using errcode = '22023';
  end if;

  insert into public.zeus_user_sessions as sessions (
    session_key,
    payload,
    version,
    updated_at,
    expires_at,
    pending_action_expires_at
  )
  values (
    p_session_key,
    p_payload,
    1,
    clock_timestamp(),
    clock_timestamp() + make_interval(secs => p_session_ttl_seconds),
    case when p_payload ? 'pendingAction'
      then clock_timestamp() + make_interval(secs => p_pending_ttl_seconds)
      else null
    end
  )
  on conflict (session_key) do update
  set payload = excluded.payload,
      version = sessions.version + 1,
      updated_at = clock_timestamp(),
      expires_at = clock_timestamp() + make_interval(secs => p_session_ttl_seconds),
      pending_action_expires_at = case
        when not (excluded.payload ? 'pendingAction') then null
        when sessions.payload->'pendingAction'
          is distinct from excluded.payload->'pendingAction'
          then clock_timestamp() + make_interval(secs => p_pending_ttl_seconds)
        else sessions.pending_action_expires_at
      end
  where sessions.version = p_expected_version
    or (sessions.expires_at <= clock_timestamp() and p_expected_version = 0)
  returning sessions.version into new_version;

  if new_version is null then
    raise exception 'ZEUS user session version conflict' using errcode = '40001';
  end if;

  return query select new_version;
end;
$$;

create or replace function public.zeus_delete_user_session(p_session_key text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_session_key is null
    or p_session_key !~ '^user:[1-9][0-9]{0,15}$' then
    raise exception 'Invalid ZEUS session key' using errcode = '22023';
  end if;

  delete from public.zeus_user_sessions
  where session_key = p_session_key;
end;
$$;

revoke all on function public.zeus_read_user_session(text)
  from public, anon, authenticated;
revoke all on function public.zeus_write_user_session(text, jsonb, bigint, integer, integer)
  from public, anon, authenticated;
revoke all on function public.zeus_delete_user_session(text)
  from public, anon, authenticated;

grant execute on function public.zeus_read_user_session(text) to service_role;
grant execute on function public.zeus_write_user_session(text, jsonb, bigint, integer, integer)
  to service_role;
grant execute on function public.zeus_delete_user_session(text) to service_role;
