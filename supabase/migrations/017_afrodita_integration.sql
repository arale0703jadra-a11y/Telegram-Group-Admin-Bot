-- 017_afrodita_integration.sql
-- Migración NUEVA y específica de la integración ZEUS ↔ AFRODITA.
-- Comunicación interna entre bots mediante Supabase/PostgreSQL:
-- sin mensajes de Telegram ni archivos JSON compartidos.
--
-- Tablas:
--   afrodita_group_state : instantánea del estado por grupo, escrita por AFRODITA
--                          (clave pública/anon) y leída por ZEUS (service_role).
--   afrodita_commands    : cola de órdenes ZEUS → AFRODITA (pausar, reanudar,
--                          ajustes de categoría). ZEUS inserta; AFRODITA lee y
--                          marca su aplicación.
--   afrodita_events      : historial de publicaciones y encuestas, escrito por
--                          AFRODITA y leído por el panel de ZEUS.
--
-- Seguridad:
--   - RLS habilitado en las tres tablas. La política `anon` solo permite
--     SELECT en todo, INSERT/UPDATE en state y events, y SELECT/UPDATE en
--     commands. No hay política DELETE: el rol anon no puede borrar.
--   - `service_role` (ZEUS) y el dueño de las tablas evitan RLS por rol.
--   - Los datos son operativos del bot (métricas agregadas, ajustes, IDs de
--     grupo); no contienen texto de mensajes de usuarios.
--   - Esta migración no toca tablas existentes ni aplica cambios ajenos.

create table if not exists public.afrodita_group_state (
  chat_id bigint primary key check (chat_id <> 0),
  state jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text not null default 'afrodita' check (char_length(updated_by) <= 40)
);

create table if not exists public.afrodita_commands (
  id bigint generated always as identity primary key,
  chat_id bigint not null check (chat_id <> 0),
  command text not null check (char_length(command) between 1 and 64),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'applied', 'failed')),
  created_by bigint,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 300)
);

create table if not exists public.afrodita_events (
  id bigint generated always as identity primary key,
  chat_id bigint not null check (chat_id <> 0),
  kind text not null check (char_length(kind) <= 40),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists afrodita_group_state_updated_at_idx
  on public.afrodita_group_state (updated_at desc);

create index if not exists afrodita_commands_pending_idx
  on public.afrodita_commands (chat_id, id)
  where status = 'pending';

create index if not exists afrodita_events_chat_kind_idx
  on public.afrodita_events (chat_id, kind, id desc);

alter table public.afrodita_group_state enable row level security;
alter table public.afrodita_commands enable row level security;
alter table public.afrodita_events enable row level security;

-- Políticas idempotentes (PostgreSQL no admite IF NOT EXISTS en CREATE POLICY).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'afrodita_group_state'
      and policyname = 'afrodita_state_anon_select'
  ) then
    create policy afrodita_state_anon_select
      on public.afrodita_group_state for select to anon using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'afrodita_group_state'
      and policyname = 'afrodita_state_anon_insert'
  ) then
    create policy afrodita_state_anon_insert
      on public.afrodita_group_state for insert to anon with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'afrodita_group_state'
      and policyname = 'afrodita_state_anon_update'
  ) then
    create policy afrodita_state_anon_update
      on public.afrodita_group_state for update to anon
      using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'afrodita_commands'
      and policyname = 'afrodita_commands_anon_select'
  ) then
    create policy afrodita_commands_anon_select
      on public.afrodita_commands for select to anon using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'afrodita_commands'
      and policyname = 'afrodita_commands_anon_update'
  ) then
    create policy afrodita_commands_anon_update
      on public.afrodita_commands for update to anon
      using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'afrodita_events'
      and policyname = 'afrodita_events_anon_select'
  ) then
    create policy afrodita_events_anon_select
      on public.afrodita_events for select to anon using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'afrodita_events'
      and policyname = 'afrodita_events_anon_insert'
  ) then
    create policy afrodita_events_anon_insert
      on public.afrodita_events for insert to anon with check (true);
  end if;
end $$;

revoke delete on public.afrodita_group_state from anon, authenticated;
revoke delete on public.afrodita_commands from anon, authenticated;
revoke delete on public.afrodita_events from anon, authenticated;
