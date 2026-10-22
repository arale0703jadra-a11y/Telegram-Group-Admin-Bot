begin;

alter table public.verified_users
  alter column permissions set default
  '{"can_post":true,"can_send_media":true,"can_send_links":true,"bypass_antispam":false,"bypass_promotion_filter":false,"bypass_illegal_filter":false,"bypass_automatic_deletion":false}'::jsonb;

alter table public.verified_user_manual_audit
  alter column actor_user_id drop not null;

alter table public.verified_user_manual_audit
  drop constraint if exists verified_user_manual_audit_event_type_check;

alter table public.verified_user_manual_audit
  add constraint verified_user_manual_audit_event_type_check
  check (event_type in ('activated', 'reactivated', 'revoked', 'auto_revoked'));

create table if not exists public.verified_user_auto_revocation_outbox (
  event_key uuid primary key
    references public.verified_user_manual_audit(event_key) on delete cascade,
  group_id bigint not null,
  user_id bigint not null,
  username text,
  display_name text,
  status text not null default 'pending' check (
    status in ('pending', 'sending', 'sent', 'unknown')
  ),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  resolved_at timestamptz
);

create index if not exists verified_user_auto_revocation_outbox_pending_idx
  on public.verified_user_auto_revocation_outbox (group_id, created_at)
  where status = 'pending';

alter table public.verified_user_auto_revocation_outbox enable row level security;
revoke all on public.verified_user_auto_revocation_outbox
  from public, anon, authenticated;
grant all on public.verified_user_auto_revocation_outbox to service_role;

create or replace function public.revoke_expired_verified_user(
  p_group_id bigint,
  p_user_id bigint,
  p_now timestamptz,
  p_event_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  changed_user public.verified_users%rowtype;
begin
  if p_user_id <= 0 or p_group_id = 0 or p_event_key is null then
    raise exception 'INVALID_VERIFIED_USER_ID';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'verified-user:' || p_group_id::text || ':' || p_user_id::text,
      0
    )
  );

  update public.verified_users
  set verified = false,
      revoked_at = p_now,
      updated_at = p_now
  where group_id = p_group_id
    and user_id = p_user_id
    and verified = true
    and revoked_at is null
    and valid_until is not null
    and valid_until <= p_now
  returning * into changed_user;

  if not found then
    return jsonb_build_object('status', 'not_expired');
  end if;

  insert into public.verified_user_manual_audit (
    event_key,
    group_id,
    user_id,
    actor_user_id,
    event_type,
    activated_at,
    valid_until
  ) values (
    p_event_key,
    p_group_id,
    p_user_id,
    null,
    'auto_revoked',
    changed_user.activated_at,
    changed_user.valid_until
  );

  insert into public.verified_user_auto_revocation_outbox (
    event_key,
    group_id,
    user_id,
    username,
    display_name
  ) values (
    p_event_key,
    p_group_id,
    p_user_id,
    changed_user.username,
    changed_user.display_name
  );

  return jsonb_build_object(
    'status', 'revoked',
    'event_key', p_event_key,
    'group_id', p_group_id,
    'user_id', p_user_id,
    'username', changed_user.username,
    'display_name', changed_user.display_name
  );
end;
$$;

create or replace function public.claim_verified_auto_revocation_notification(
  p_event_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claimed public.verified_user_auto_revocation_outbox%rowtype;
begin
  update public.verified_user_auto_revocation_outbox
  set status = 'sending',
      claimed_at = clock_timestamp()
  where event_key = p_event_key
    and status = 'pending'
  returning * into claimed;

  if not found then
    return jsonb_build_object('status', 'not_pending');
  end if;

  return jsonb_build_object(
    'status', 'claimed',
    'event_key', claimed.event_key,
    'group_id', claimed.group_id,
    'user_id', claimed.user_id,
    'username', claimed.username,
    'display_name', claimed.display_name
  );
end;
$$;

create or replace function public.finish_verified_auto_revocation_notification(
  p_event_key uuid,
  p_outcome text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_outcome not in ('sent', 'unknown') then
    raise exception 'INVALID_NOTIFICATION_OUTCOME';
  end if;

  update public.verified_user_auto_revocation_outbox
  set status = p_outcome,
      resolved_at = clock_timestamp()
  where event_key = p_event_key
    and status = 'sending';

  return found;
end;
$$;

revoke all on function public.revoke_expired_verified_user(
  bigint, bigint, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.revoke_expired_verified_user(
  bigint, bigint, timestamptz, uuid
) to service_role;

revoke all on function public.claim_verified_auto_revocation_notification(
  uuid
) from public, anon, authenticated;
grant execute on function public.claim_verified_auto_revocation_notification(
  uuid
) to service_role;

revoke all on function public.finish_verified_auto_revocation_notification(
  uuid, text
) from public, anon, authenticated;
grant execute on function public.finish_verified_auto_revocation_notification(
  uuid, text
) to service_role;

commit;
