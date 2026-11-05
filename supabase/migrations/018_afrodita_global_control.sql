-- Estado maestro persistente para pausar/reanudar AFRODITA en todos los grupos.
-- La migración solo crea/modifica el esquema local; no aplica cambios remotos.

alter table public.afrodita_commands
  drop constraint if exists afrodita_commands_chat_id_check;

alter table public.afrodita_commands
  add constraint afrodita_commands_chat_id_check
  check (
    chat_id <> 0
    or (command in ('pause', 'resume') and payload->>'scope' = 'global')
  );

create unique index if not exists afrodita_one_pending_global_command_idx
  on public.afrodita_commands ((payload->>'scope'))
  where status = 'pending'
    and command in ('pause', 'resume')
    and payload->>'scope' = 'global';

create table if not exists public.afrodita_control_state (
  id text primary key check (id = 'global'),
  mode text not null check (mode in ('running', 'paused')),
  updated_at timestamptz not null default now(),
  updated_by text not null default 'afrodita'
    check (char_length(updated_by) <= 40),
  heartbeat_at timestamptz not null default now()
);

insert into public.afrodita_control_state (id, mode, updated_by)
values ('global', 'paused', 'migration')
on conflict (id) do nothing;

alter table public.afrodita_control_state enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'afrodita_control_state'
      and policyname = 'afrodita_control_anon_select'
  ) then
    create policy afrodita_control_anon_select
      on public.afrodita_control_state for select to anon using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'afrodita_control_state'
      and policyname = 'afrodita_control_anon_insert'
  ) then
    create policy afrodita_control_anon_insert
      on public.afrodita_control_state for insert to anon
      with check (id = 'global' and mode in ('running', 'paused'));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'afrodita_control_state'
      and policyname = 'afrodita_control_anon_update'
  ) then
    create policy afrodita_control_anon_update
      on public.afrodita_control_state for update to anon
      using (id = 'global')
      with check (id = 'global' and mode in ('running', 'paused'));
  end if;
end $$;

grant select, insert, update on public.afrodita_control_state to anon;
