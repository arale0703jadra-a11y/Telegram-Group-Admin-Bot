begin;

do $$
declare
  relation_name text;
  relation_names text[] := array[
    'bots',
    'groups',
    'group_bot_bindings',
    'security_commands',
    'security_events',
    'security_audit_log',
    'security_group_configs',
    'security_sanctions',
    'security_protected_users',
    'security_warnings',
    'verified_users',
    'system_owner',
    'system_owner_recovery_keys',
    'system_owner_recovery_attempts',
    'system_owner_recovery_challenges',
    'system_owner_audit',
    'verified_member_tag_reviews',
    'verified_member_tag_audit'
  ];
begin
  foreach relation_name in array relation_names loop
    if to_regclass(format('public.%I', relation_name)) is null then
      continue;
    end if;

    execute format(
      'alter table public.%I enable row level security',
      relation_name
    );
    execute format(
      'revoke all privileges on table public.%I from public, anon, authenticated',
      relation_name
    );
    execute format(
      'grant all privileges on table public.%I to service_role',
      relation_name
    );
    execute format(
      'drop policy if exists %I on public.%I',
      relation_name || '_service_role_access',
      relation_name
    );
    execute format(
      'create policy %I on public.%I for all to service_role using (true) with check (true)',
      relation_name || '_service_role_access',
      relation_name
    );
  end loop;

  if to_regprocedure('public.claim_security_command(text)') is not null then
    execute
      'revoke all privileges on function public.claim_security_command(text) from public, anon, authenticated';
    execute
      'grant execute on function public.claim_security_command(text) to service_role';
  end if;
end;
$$;

commit;
