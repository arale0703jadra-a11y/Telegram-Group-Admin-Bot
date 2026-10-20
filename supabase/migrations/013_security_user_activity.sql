begin;

create table if not exists public.security_user_activity (
  group_id bigint not null,
  user_id bigint not null,
  last_active_at timestamptz not null,
  is_deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (group_id, user_id),
  constraint security_user_activity_group_id_check check (group_id <> 0),
  constraint security_user_activity_user_id_check check (user_id > 0)
);

create index if not exists security_user_activity_inactive_idx
  on public.security_user_activity(group_id, last_active_at)
  where is_deleted = false;

create index if not exists security_user_activity_deleted_idx
  on public.security_user_activity(group_id, user_id)
  where is_deleted = true;

alter table public.security_user_activity enable row level security;
revoke all privileges on table public.security_user_activity
  from public, anon, authenticated;
grant all privileges on table public.security_user_activity to service_role;

drop policy if exists security_user_activity_service_role_access
  on public.security_user_activity;
create policy security_user_activity_service_role_access
  on public.security_user_activity
  for all to service_role
  using (true)
  with check (true);

commit;
