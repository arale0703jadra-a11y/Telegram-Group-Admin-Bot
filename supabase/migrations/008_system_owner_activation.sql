-- ZEUS System Owner and Recovery Key support.
-- This migration is additive and does not alter CERBERO tables or migrations 001-007.
create extension if not exists pgcrypto;

create table if not exists public.system_owner (
  singleton boolean primary key default true check (singleton),
  owner_user_id bigint,
  activated_at timestamptz default now()
);
alter table public.system_owner enable row level security;

create table if not exists public.system_owner_recovery_keys (
  id uuid primary key default gen_random_uuid(),
  key_salt text not null,
  key_hash text not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.system_owner_recovery_keys enable row level security;
create index if not exists system_owner_recovery_available_idx
  on public.system_owner_recovery_keys (created_at)
  where used_at is null and revoked_at is null;

create table if not exists public.system_owner_recovery_attempts (
  user_id bigint primary key,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  last_attempt_at timestamptz
);
alter table public.system_owner_recovery_attempts enable row level security;

create table if not exists public.system_owner_recovery_challenges (
  id uuid primary key default gen_random_uuid(),
  recovery_key_id uuid not null references public.system_owner_recovery_keys(id) on delete cascade,
  challenge_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.system_owner_recovery_challenges enable row level security;
create index if not exists system_owner_recovery_challenge_idx
  on public.system_owner_recovery_challenges (recovery_key_id, expires_at)
  where consumed_at is null and invalidated_at is null;

create table if not exists public.system_owner_audit (
  id bigint generated always as identity primary key,
  event_type text not null check (event_type in
    ('SYSTEM_OWNER_BOOTSTRAPPED', 'RECOVERY_GENERATED', 'RECOVERY_CONSUMED',
     'RECOVERY_REJECTED', 'RECOVERY_REVOKED', 'SYSTEM_OWNER_CHANGED',
     'TRANSACTION_FAILED')),
  actor_user_id bigint not null,
  target_user_id bigint,
  recovery_key_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.system_owner_audit enable row level security;

create or replace function public.zeus_bootstrap_system_owner(
  p_owner_user_id bigint
) returns boolean
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or p_owner_user_id is null or p_owner_user_id <= 0 then
    return false;
  end if;

  insert into system_owner(singleton, owner_user_id)
    values (true, p_owner_user_id)
    on conflict (singleton) do nothing;
  if not found then
    return false;
  end if;

  insert into system_owner_audit(event_type, actor_user_id, target_user_id)
    values ('SYSTEM_OWNER_BOOTSTRAPPED', p_owner_user_id, p_owner_user_id);
  return true;
end;
$$;

create or replace function public.zeus_generate_recovery_key(
  p_actor_user_id bigint,
  p_key_salt text,
  p_key_hash text
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_key_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or p_actor_user_id is null or p_actor_user_id <= 0
     or coalesce(length(p_key_salt), 0) = 0
     or coalesce(length(p_key_hash), 0) = 0 then
    return null;
  end if;

  if not exists (
    select 1 from system_owner
    where singleton = true and owner_user_id = p_actor_user_id
  ) then
    return null;
  end if;

  insert into system_owner_recovery_keys(key_salt, key_hash)
    values (p_key_salt, p_key_hash)
    returning id into v_key_id;

  insert into system_owner_audit(
    event_type, actor_user_id, recovery_key_id
  ) values (
    'RECOVERY_GENERATED', p_actor_user_id, v_key_id
  );
  return v_key_id;
end;
$$;

create or replace function public.zeus_recovery_rate_limit_allowed(
  p_user_id bigint
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare v_locked_until timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or p_user_id is null or p_user_id <= 0 then return false; end if;
  insert into system_owner_recovery_attempts(user_id)
    values (p_user_id) on conflict (user_id) do nothing;
  select locked_until into v_locked_until
    from system_owner_recovery_attempts where user_id = p_user_id for update;
  return v_locked_until is null or v_locked_until <= now();
end;
$$;

create or replace function public.zeus_record_recovery_failure(
  p_user_id bigint
) returns void
language plpgsql security definer set search_path = public
as $$
declare v_attempts integer;
declare v_locked_until timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or p_user_id is null or p_user_id <= 0 then return; end if;
  insert into system_owner_recovery_attempts(user_id)
    values (p_user_id) on conflict (user_id) do nothing;
  select failed_attempts, locked_until into v_attempts, v_locked_until
    from system_owner_recovery_attempts where user_id = p_user_id for update;
  if v_locked_until is not null and v_locked_until > now() then return; end if;
  v_attempts := coalesce(v_attempts, 0) + 1;
  update system_owner_recovery_attempts
     set failed_attempts = v_attempts,
         locked_until = now() + least(interval '15 minutes',
           interval '1 second' * power(2, least(v_attempts - 1, 10))),
         last_attempt_at = now()
   where user_id = p_user_id;
end;
$$;

create or replace function public.zeus_clear_recovery_failures(
  p_user_id bigint
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or p_user_id is null or p_user_id <= 0 then return; end if;
  update system_owner_recovery_attempts
     set failed_attempts = 0, locked_until = null, last_attempt_at = now()
   where user_id = p_user_id;
end;
$$;

create or replace function public.zeus_cleanup_recovery_challenges()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_deleted integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    return 0;
  end if;

  delete from system_owner_recovery_challenges c
   where c.consumed_at is not null
      or c.invalidated_at is not null
      or c.expires_at <= now()
      or exists (
        select 1
          from system_owner_recovery_keys k
         where k.id = c.recovery_key_id
           and k.revoked_at is not null
      );
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

create or replace function public.zeus_record_recovery_rejection(
  p_actor_user_id bigint,
  p_key_id uuid,
  p_reason text
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or p_actor_user_id is null or p_actor_user_id <= 0 then
    return;
  end if;
  insert into system_owner_audit(
    event_type, actor_user_id, recovery_key_id, metadata
  ) values (
    'RECOVERY_REJECTED',
    p_actor_user_id,
    p_key_id,
    jsonb_build_object('action', 'recovery', 'reason', coalesce(p_reason, 'rejected'))
  );
end;
$$;

create or replace function public.zeus_record_transaction_failure(
  p_actor_user_id bigint,
  p_key_id uuid,
  p_reason text
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or p_actor_user_id is null or p_actor_user_id <= 0 then
    return;
  end if;
  insert into system_owner_audit(
    event_type, actor_user_id, recovery_key_id, metadata
  ) values (
    'TRANSACTION_FAILED',
    p_actor_user_id,
    p_key_id,
    jsonb_build_object('action', 'recovery', 'reason', coalesce(p_reason, 'transaction_failed'))
  );
end;
$$;

create or replace function public.zeus_begin_recovery(
  p_key_id uuid
) returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_challenge text := encode(gen_random_bytes(32), 'base64');
begin
  if coalesce(auth.role(), '') <> 'service_role' or p_key_id is null then
    return null;
  end if;
  perform 1 from system_owner_recovery_keys
   where id = p_key_id and used_at is null and revoked_at is null
   for update;
  if not found then
    return null;
  end if;
  update system_owner_recovery_challenges
     set invalidated_at = now()
   where recovery_key_id = p_key_id
     and consumed_at is null
     and invalidated_at is null;
  insert into system_owner_recovery_challenges(
    recovery_key_id, challenge_hash, expires_at
  ) values (
    p_key_id, encode(digest(v_challenge, 'sha256'), 'base64'),
    now() + interval '5 minutes'
  );
  return v_challenge;
end;
$$;

create or replace function public.zeus_recover_system_owner(
  p_key_id uuid,
  p_challenge text,
  p_new_owner_id bigint,
  p_actor_user_id bigint
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare v_challenge_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or p_key_id is null or coalesce(length(p_challenge), 0) = 0
     or p_new_owner_id is null or p_new_owner_id <= 0
     or p_actor_user_id is null or p_actor_user_id <= 0
     or p_new_owner_id <> p_actor_user_id then
    return false;
  end if;

  perform 1 from system_owner_recovery_keys
    where id = p_key_id and used_at is null and revoked_at is null
    for update;
  if not found then return false; end if;

  select id into v_challenge_id
    from system_owner_recovery_challenges
   where recovery_key_id = p_key_id
     and challenge_hash = encode(digest(p_challenge, 'sha256'), 'base64')
     and expires_at > now()
     and consumed_at is null
     and invalidated_at is null
   order by created_at desc
   limit 1
   for update;
  if not found then return false; end if;

  update system_owner_recovery_keys
     set used_at = now()
   where id = p_key_id and used_at is null and revoked_at is null;
  if not found then return false; end if;
  update system_owner_recovery_challenges
     set consumed_at = now()
   where id = v_challenge_id and consumed_at is null;

  update system_owner set owner_user_id = p_new_owner_id
   where singleton = true;
  if not found then
    insert into system_owner(singleton, owner_user_id)
      values (true, p_new_owner_id);
  end if;

  insert into system_owner_audit(event_type, actor_user_id, target_user_id, recovery_key_id)
    values ('RECOVERY_CONSUMED', p_actor_user_id, p_new_owner_id, p_key_id);
  insert into system_owner_audit(event_type, actor_user_id, target_user_id, recovery_key_id)
    values ('SYSTEM_OWNER_CHANGED', p_actor_user_id, p_new_owner_id, p_key_id);
  return true;
end;
$$;

revoke execute on function public.zeus_bootstrap_system_owner(bigint)
  from public, anon, authenticated;
revoke execute on function public.zeus_generate_recovery_key(bigint, text, text)
  from public, anon, authenticated;
revoke execute on function public.zeus_recovery_rate_limit_allowed(bigint)
  from public, anon, authenticated;
revoke execute on function public.zeus_record_recovery_failure(bigint)
  from public, anon, authenticated;
revoke execute on function public.zeus_clear_recovery_failures(bigint)
  from public, anon, authenticated;
revoke execute on function public.zeus_begin_recovery(uuid)
  from public, anon, authenticated;
revoke execute on function public.zeus_recover_system_owner(uuid, text, bigint, bigint)
  from public, anon, authenticated;
revoke execute on function public.zeus_cleanup_recovery_challenges()
  from public, anon, authenticated;
revoke execute on function public.zeus_record_recovery_rejection(bigint, uuid, text)
  from public, anon, authenticated;
revoke execute on function public.zeus_record_transaction_failure(bigint, uuid, text)
  from public, anon, authenticated;
grant execute on function public.zeus_bootstrap_system_owner(bigint) to service_role;
grant execute on function public.zeus_generate_recovery_key(bigint, text, text)
  to service_role;
grant execute on function public.zeus_recovery_rate_limit_allowed(bigint)
  to service_role;
grant execute on function public.zeus_record_recovery_failure(bigint) to service_role;
grant execute on function public.zeus_clear_recovery_failures(bigint) to service_role;
grant execute on function public.zeus_begin_recovery(uuid) to service_role;
grant execute on function public.zeus_recover_system_owner(uuid, text, bigint, bigint)
  to service_role;
grant execute on function public.zeus_cleanup_recovery_challenges()
  to service_role;
grant execute on function public.zeus_record_recovery_rejection(bigint, uuid, text)
  to service_role;
grant execute on function public.zeus_record_transaction_failure(bigint, uuid, text)
  to service_role;
