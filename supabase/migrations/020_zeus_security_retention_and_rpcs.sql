-- 020_zeus_security_retention_and_rpcs.sql
--
-- Migración PREPARADA para aplicación controlada.
-- NO aplicar en producción sin autorización explícita del propietario.
-- A la fecha de esta revisión esta migración NO está aplicada en el proyecto
-- remoto y su estado allí es "no verificable" (sin acceso autorizado).
--
-- Contenido:
--   1. RPCs de contrato para actividad de usuario. Sustituyen las escrituras
--      REST autenticadas con SUPABASE_SERVICE_ROLE_KEY en el data-plane: la
--      lógica vive en PostgreSQL y el cliente sólo envía parámetros
--      (privilegio mínimo sobre columnas y tablas).
--   2. Funciones de mantenimiento conservadoras, por lotes y con retención
--      explícita para órdenes y eventos de seguridad.
--   3. Tabla de registro de ejecuciones de mantenimiento.
--
-- Compatibilidad: sólo añade objetos nuevos. No modifica tablas, columnas,
-- políticas, índices ni funciones existentes, y no toca ningún objeto de
-- CERBERO (las funciones de CERBERO se consumen tal cual están definidas).
--
-- Convención de permisos: en PostgreSQL una función nace ejecutable por
-- PUBLIC. Por tanto cada función creada aquí se revoca de
-- public/anon/authenticated y se concede sólo a service_role, igual que hacen
-- 012, 019 y 021. Sin esos REVOKE, una función SECURITY DEFINER quedaría
-- invocable desde PostgREST/anon: eso sería una escalada de privilegios.
--
-- Esta migración NO programa ninguna limpieza automática (no usa pg_cron).
-- Las funciones de purga sólo actúan cuando un operador las invoca de forma
-- explícita; ver las políticas de retención al final del archivo.

begin;

-- ============================================================================
-- 0. Precondiciones verificadas (falla explícitamente si falta una dependencia)
-- ============================================================================

do $$
begin
  if to_regclass('public.security_user_activity') is null then
    raise exception '020: falta public.security_user_activity (aplicar 013 antes)';
  end if;

  if to_regclass('public.security_commands') is null then
    raise exception '020: falta public.security_commands (aplicar CERBERO 001/002 antes)';
  end if;

  if to_regclass('public.security_events') is null then
    raise exception '020: falta public.security_events (aplicar CERBERO 001 antes)';
  end if;

  if to_regclass('public.security_audit_log') is null then
    raise exception '020: falta public.security_audit_log (aplicar CERBERO 001 antes)';
  end if;

  if to_regclass('public.security_warnings') is null then
    raise exception '020: falta public.security_warnings (aplicar CERBERO 004 antes)';
  end if;

  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'security_commands'
       and column_name = 'result_state'
  ) then
    raise exception '020: falta security_commands.result_state (aplicar CERBERO 009 antes)';
  end if;

  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'security_commands'
       and column_name = 'execution_started_at'
  ) then
    raise exception '020: falta security_commands.execution_started_at (aplicar CERBERO 011 antes)';
  end if;

  -- Fase 4D / E2: la purga de órdenes comprueba las tres referencias
  -- `command_id` que son ON DELETE SET NULL. Sin estas columnas la función de
  -- purga fallaría en tiempo de ejecución; mejor que la migración lo diga aquí.
  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'security_warnings'
       and column_name = 'command_id'
  ) then
    raise exception '020: falta security_warnings.command_id (aplicar CERBERO 004 antes)';
  end if;

  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'security_events'
       and column_name = 'command_id'
  ) then
    raise exception '020: falta security_events.command_id (aplicar CERBERO 003 antes)';
  end if;

  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'security_audit_log'
       and column_name = 'command_id'
  ) then
    raise exception '020: falta security_audit_log.command_id (aplicar CERBERO 003/007 antes)';
  end if;
end;
$$;

-- ============================================================================
-- 1. RPCs de contrato para actividad de usuario
-- ============================================================================

create or replace function public.zeus_upsert_user_activity(
  p_group_id bigint,
  p_user_id bigint,
  p_last_active_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_group_id is null or p_group_id = 0 then
    raise exception 'zeus_upsert_user_activity: p_group_id inválido';
  end if;
  if p_user_id is null or p_user_id <= 0 then
    raise exception 'zeus_upsert_user_activity: p_user_id inválido';
  end if;
  if p_last_active_at is null then
    raise exception 'zeus_upsert_user_activity: p_last_active_at es obligatorio';
  end if;

  insert into public.security_user_activity (group_id, user_id, last_active_at)
  values (p_group_id, p_user_id, p_last_active_at)
  on conflict (group_id, user_id) do update
    set last_active_at = excluded.last_active_at,
        is_deleted = false,
        updated_at = clock_timestamp();
end;
$$;

revoke all on function public.zeus_upsert_user_activity(
  bigint, bigint, timestamptz
) from public, anon, authenticated;

grant execute on function public.zeus_upsert_user_activity(
  bigint, bigint, timestamptz
) to service_role;

-- Candidatos a limpieza por inactividad. Devuelve sólo las columnas necesarias
-- y siempre acotado por grupo y por límite: nunca expone la tabla completa.
create or replace function public.zeus_get_inactive_activity_candidates(
  p_group_id bigint,
  p_cutoff timestamptz,
  p_limit integer
)
returns table (
  group_id bigint,
  user_id bigint,
  last_active_at timestamptz
)
language sql
security definer
set search_path = pg_catalog, public
as $$
  select
    s.group_id,
    s.user_id,
    s.last_active_at
  from public.security_user_activity as s
  where
        s.group_id = p_group_id
    and s.is_deleted = false
    and s.last_active_at < p_cutoff
  order by s.last_active_at asc
  limit least(greatest(coalesce(p_limit, 100), 1), 200);
$$;

revoke all on function public.zeus_get_inactive_activity_candidates(
  bigint, timestamptz, integer
) from public, anon, authenticated;

grant execute on function public.zeus_get_inactive_activity_candidates(
  bigint, timestamptz, integer
) to service_role;

-- ============================================================================
-- 2. Registro de mantenimiento
-- ============================================================================

create table if not exists public.zeus_maintenance_runs (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  deleted_rows bigint not null default 0,
  retention_days integer,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists zeus_maintenance_runs_job_idx
  on public.zeus_maintenance_runs(job, created_at desc);

alter table public.zeus_maintenance_runs enable row level security;

revoke all privileges on table public.zeus_maintenance_runs
  from public, anon, authenticated;

grant all privileges on table public.zeus_maintenance_runs to service_role;

drop policy if exists zeus_maintenance_runs_service_role_access
  on public.zeus_maintenance_runs;

create policy zeus_maintenance_runs_service_role_access
  on public.zeus_maintenance_runs
  for all to service_role
  using (true)
  with check (true);

create or replace function public.zeus_log_maintenance_run(
  p_job text,
  p_deleted_rows bigint,
  p_retention_days integer,
  p_detail jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
begin
  if p_job is null or length(btrim(p_job)) = 0 or length(p_job) > 120 then
    raise exception 'zeus_log_maintenance_run: p_job inválido';
  end if;

  insert into public.zeus_maintenance_runs (job, deleted_rows, retention_days, detail)
  values (
    btrim(p_job),
    coalesce(p_deleted_rows, 0),
    p_retention_days,
    coalesce(p_detail, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.zeus_log_maintenance_run(
  text, bigint, integer, jsonb
) from public, anon, authenticated;

grant execute on function public.zeus_log_maintenance_run(
  text, bigint, integer, jsonb
) to service_role;

-- ============================================================================
-- 3. Purga conservadora y por lotes
-- ============================================================================

-- Purga de órdenes cerradas. Reglas deliberadamente estrictas:
--   * sólo estados terminales (completed/failed/cancelled);
--   * nunca result_state 'processing' (ejecución en curso) ni 'unknown'
--     (resultado sin confirmar). Fase 4D / E3: 'unknown' no tiene salida
--     automática a propósito. Purga, neutralización y reintento son decisiones
--     humanas auditables (zeus_requeue_security_command + el panel); esta
--     función NO debe convertirse en un borrado silencioso de evidencia. La
--     política completa está en supabase/RETENTION_POLICY.md;
--   * nunca órdenes 'pending': una orden pendiente sigue siendo intención
--     vigente; su recuperación se hace con reconcileStaleSecurityCommands y
--     requeueSecurityCommand, no borrándola;
--   * nunca órdenes referenciadas desde otra tabla con FK ON DELETE SET NULL.
--     Fase 4D / E2: `ON DELETE SET NULL` NO conserva la auditoría. Al borrar la
--     orden sólo queda NULL y se pierde el vínculo; por eso la comprobación
--     cubre las tres referencias, no sólo security_warnings:
--       - security_warnings.command_id  (004, ON DELETE SET NULL)
--       - security_events.command_id    (003, ON DELETE SET NULL)
--       - security_audit_log.command_id (003/007, ON DELETE SET NULL)
--     La estrategia es preservar/archivar: la orden se conserva mientras
--     cualquier fila la referencie;
--   * lote acotado y FOR UPDATE SKIP LOCKED para no bloquear a CERBERO.
create or replace function public.zeus_purge_security_commands(
  p_statuses text[],
  p_older_than_days integer,
  p_batch_limit integer default 500
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_deleted bigint := 0;
  v_cutoff timestamptz;
begin
  if p_statuses is null or cardinality(p_statuses) = 0 then
    raise exception 'zeus_purge_security_commands: p_statuses es obligatorio';
  end if;

  if exists (
    select 1
      from unnest(p_statuses) as s(value)
     where s.value not in ('completed', 'failed', 'cancelled')
  ) then
    raise exception
      'zeus_purge_security_commands: sólo completed/failed/cancelled; recibido %',
      array_to_string(p_statuses, ',');
  end if;

  if p_older_than_days is null or p_older_than_days < 30 then
    raise exception 'zeus_purge_security_commands: p_older_than_days debe ser >= 30';
  end if;

  if p_batch_limit is null or p_batch_limit < 1 or p_batch_limit > 5000 then
    raise exception 'zeus_purge_security_commands: p_batch_limit entre 1 y 5000';
  end if;

  v_cutoff := now() - make_interval(days => p_older_than_days);

  with doomed as (
    select c.id
      from public.security_commands as c
     where
           c.status = any(p_statuses)
       and c.created_at < v_cutoff
       and c.result_state not in ('processing', 'unknown')
       and not exists (
         select 1
           from public.security_warnings as w
          where w.command_id = c.id
       )
       -- E2: las otras dos referencias también son ON DELETE SET NULL. Comprobar
       -- sólo security_warnings dejaba que un evento o una entrada de auditoría
       -- perdieran su command_id al purgar la orden.
       and not exists (
         select 1
           from public.security_events as e
          where e.command_id = c.id
       )
       and not exists (
         select 1
           from public.security_audit_log as a
          where a.command_id = c.id
       )
     order by c.created_at
     limit p_batch_limit
     for update of c skip locked
  )
  delete from public.security_commands as t
   using doomed as d
   where t.id = d.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.zeus_purge_security_commands(
  text[], integer, integer
) from public, anon, authenticated;

grant execute on function public.zeus_purge_security_commands(
  text[], integer, integer
) to service_role;

-- Purga de eventos de seguridad. No distingue por grupo a propósito: la
-- retención es global y homogénea; lo que sí respeta es el lote máximo.
create or replace function public.zeus_purge_security_events(
  p_retention_days integer default 90,
  p_batch_limit integer default 1000
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_deleted bigint := 0;
  v_cutoff timestamptz;
begin
  if p_retention_days is null or p_retention_days < 30 then
    raise exception 'zeus_purge_security_events: p_retention_days debe ser >= 30';
  end if;

  if p_batch_limit is null or p_batch_limit < 1 or p_batch_limit > 5000 then
    raise exception 'zeus_purge_security_events: p_batch_limit entre 1 y 5000';
  end if;

  v_cutoff := now() - make_interval(days => p_retention_days);

  with doomed as (
    select e.id
      from public.security_events as e
     where e.created_at < v_cutoff
     order by e.created_at
     limit p_batch_limit
     for update of e skip locked
  )
  delete from public.security_events as t
   using doomed as d
   where t.id = d.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.zeus_purge_security_events(
  integer, integer
) from public, anon, authenticated;

grant execute on function public.zeus_purge_security_events(
  integer, integer
) to service_role;

-- Purga del registro de auditoría. Es la operación más sensible de esta
-- migración: el mínimo es 90 días y el valor por defecto 365 para que nadie la
-- use por accidente con una ventana corta. Se invoca sólo como decisión
-- explícita de gobernanza y su resultado debe registrarse con
-- zeus_log_maintenance_run.
create or replace function public.zeus_purge_security_audit_log(
  p_retention_days integer default 365,
  p_batch_limit integer default 1000
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_deleted bigint := 0;
  v_cutoff timestamptz;
begin
  if p_retention_days is null or p_retention_days < 90 then
    raise exception 'zeus_purge_security_audit_log: p_retention_days debe ser >= 90';
  end if;

  if p_batch_limit is null or p_batch_limit < 1 or p_batch_limit > 5000 then
    raise exception 'zeus_purge_security_audit_log: p_batch_limit entre 1 y 5000';
  end if;

  v_cutoff := now() - make_interval(days => p_retention_days);

  with doomed as (
    select a.id
      from public.security_audit_log as a
     where a.created_at < v_cutoff
     order by a.created_at
     limit p_batch_limit
     for update of a skip locked
  )
  delete from public.security_audit_log as t
   using doomed as d
   where t.id = d.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.zeus_purge_security_audit_log(
  integer, integer
) from public, anon, authenticated;

grant execute on function public.zeus_purge_security_audit_log(
  integer, integer
) to service_role;

commit;

-- ============================================================================
-- 4. Política de retención documentada (no ejecutada por esta migración)
-- ============================================================================
--
--   security_commands
--     pending    : NO se purga. Una orden pendiente es intención vigente; se
--                  recupera con reconcileStaleSecurityCommands /
--                  requeueSecurityCommand y queda auditada.
--     processing : NO se purga (ejecución en curso o lease vivo).
--     failed     : 90 días, sólo si result_state <> 'unknown'.
--     cancelled  : 30 días.
--     completed  : 365 días, salvo que otra tabla la referencie.
--     result_state = 'unknown' : NO se purga automáticamente (además de
--                  result_state <> 'unknown' en el WHERE). Es una decisión de
--                  política, no un efecto colateral: una orden 'unknown' es
--                  evidencia de un resultado no confirmado y su resolución
--                  (reintento auditado o neutralización) es humana. Ver
--                  supabase/RETENTION_POLICY.md.
--   Referencias protegidas (Fase 4D / E2): la purga de órdenes excluye
--   cualquier orden referenciada por:
--     security_warnings.command_id    (ON DELETE SET NULL)
--     security_events.command_id      (ON DELETE SET NULL)
--     security_audit_log.command_id   (ON DELETE SET NULL)
--   ON DELETE SET NULL no conserva el vínculo: al borrar la orden quedaría NULL
--   y la auditoría perdería a qué ejecución pertenece. La estrategia es
--   preservar/archivar, no "confiar en el FK".
--   security_events            : 90 días.
--   security_audit_log         : 365 días (mínimo permitido: 90).
--   verified_member_tag_audit  : 365 días (sin función en esta migración).
--   verified_user_auto_revocation_outbox : 30 días (sin función aquí).
--   system_owner_recovery_challenges     : 7 días (sin función aquí).
--   zeus_maintenance_runs      : sin purga automática; es el propio registro.
--
-- Invocación prevista (manual, nunca automática):
--
--   select public.zeus_purge_security_commands(
--     array['cancelled','failed'], 90, 500
--   );
--   select public.zeus_log_maintenance_run(
--     'purge_security_commands', <filas>, 90, '{"batch":500}'::jsonb
--   );
--
-- Registrar siempre el número de filas devuelto y la hora de ejecución.



