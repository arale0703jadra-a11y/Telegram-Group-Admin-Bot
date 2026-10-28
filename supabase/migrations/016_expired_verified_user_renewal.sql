begin;

create or replace function public.activate_manual_verified_user(
  p_group_id bigint,
  p_user_id bigint,
  p_actor_user_id bigint,
  p_username text,
  p_display_name text,
  p_permissions jsonb,
  p_reactivate boolean,
  p_event_key uuid,
  p_activated_at timestamptz,
  p_valid_until timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  existing_count integer;
  existing_user public.verified_users%rowtype;
  saved_user public.verified_users%rowtype;
  activation_type text;
begin
  if p_user_id <= 0 or p_actor_user_id <= 0 or p_group_id = 0 then
    raise exception 'INVALID_VERIFIED_USER_ID';
  end if;
  if extract(epoch from (p_valid_until - p_activated_at)) <> 2592000 then
    raise exception 'INVALID_VERIFICATION_VALIDITY';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'verified-user:' || p_group_id::text || ':' || p_user_id::text,
      0
    )
  );

  if exists (
    select 1
    from public.verified_user_manual_audit
    where event_key = p_event_key
  ) then
    return jsonb_build_object('status', 'already_active');
  end if;

  select count(*) into existing_count
  from public.verified_users
  where group_id = p_group_id and user_id = p_user_id;
  if existing_count > 1 then
    raise exception 'DUPLICATE_VERIFIED_USER_RECORDS';
  end if;

  if existing_count = 1 then
    select * into existing_user
    from public.verified_users
    where group_id = p_group_id and user_id = p_user_id
    for update;

    if existing_user.verified
      and existing_user.revoked_at is null
      and (
        existing_user.valid_until is null
        or existing_user.valid_until > p_activated_at
      )
    then
      return jsonb_build_object('status', 'already_active');
    end if;
    if not p_reactivate then
      return jsonb_build_object('status', 'reactivation_required');
    end if;

    update public.verified_users
    set username = coalesce(p_username, existing_user.username),
        display_name = coalesce(p_display_name, existing_user.display_name),
        verified = true,
        created_by = p_actor_user_id,
        revoked_at = null,
        verification_method = 'manual',
        detected_at = null,
        activated_at = p_activated_at,
        valid_until = p_valid_until,
        updated_at = p_activated_at
    where group_id = p_group_id and user_id = p_user_id
    returning * into saved_user;
    activation_type := 'reactivated';
  else
    if p_reactivate then
      return jsonb_build_object('status', 'not_found');
    end if;

    insert into public.verified_users (
      group_id,
      user_id,
      username,
      display_name,
      verified,
      permissions,
      created_by,
      revoked_at,
      verification_method,
      detected_at,
      activated_at,
      valid_until,
      updated_at
    ) values (
      p_group_id,
      p_user_id,
      p_username,
      p_display_name,
      true,
      coalesce(p_permissions, '{}'::jsonb),
      p_actor_user_id,
      null,
      'manual',
      null,
      p_activated_at,
      p_valid_until,
      p_activated_at
    )
    returning * into saved_user;
    activation_type := 'activated';
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
    p_actor_user_id,
    activation_type,
    p_activated_at,
    p_valid_until
  );

  return jsonb_build_object(
    'status', case when activation_type = 'activated' then 'created' else 'reactivated' end,
    'user', to_jsonb(saved_user)
  );
end;
$$;

revoke all on function public.activate_manual_verified_user(
  bigint, bigint, bigint, text, text, jsonb, boolean, uuid, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.activate_manual_verified_user(
  bigint, bigint, bigint, text, text, jsonb, boolean, uuid, timestamptz, timestamptz
) to service_role;

commit;
