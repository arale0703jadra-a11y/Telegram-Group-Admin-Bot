-- tests/fixtures/security-command-requeue-audit-failure.sql
--
-- Fixture OPCIONAL para las pruebas de atomicidad de
-- `tests/security-command-requeue-postgres.test.ts`.
--
-- Úsalo SÓLO en un proyecto PostgreSQL desechable. Nunca en producción.
--
-- Para qué sirve: la prueba "if the mandatory audit insert fails, the whole
-- requeue is rolled back" necesita que `insert into security_events` falle de
-- forma determinista. PostgREST no permite DDL, así que el bloqueo se instala
-- aquí (una vez, a mano) y la prueba lo detecta; si no está instalado, la prueba
-- se OMITE con un mensaje que apunta a este archivo (nunca pasa en falso).
--
-- Cómo armarlo en el proyecto desechable (SQL editor o psql):
--   1. ejecutar el marcador obligatorio:
--      tests/fixtures/security-command-requeue-disposable-marker.sql
--   2. ejecutar este archivo completo
--   3. insert into public.zeus_test_audit_failure(reason) values ('zeus-it-audit-failure');
--   4. ejecutar las pruebas: ZEUS_TEST_SUPABASE_* + ZEUS_TEST_SUPABASE_DISPOSABLE=yes
--
-- Las pruebas exigen además que la URL sea `https://<ref>.supabase.co` y que la
-- clave service_role (JWT legacy) declare la MISMA referencia de proyecto: una
-- variable de entorno no basta para declarar un proyecto como desechable (C7).
--
-- Cómo desarmarlo:
--   delete from public.zeus_test_audit_failure where reason = 'zeus-it-audit-failure';
-- y, cuando ya no se necesite, borrar el fixture:
--   drop trigger if exists zeus_test_block_security_event_trg on public.security_events;
--   drop function if exists public.zeus_test_block_security_event();
--   drop table if exists public.zeus_test_audit_failure;
--   drop table if exists public.zeus_test_disposable_marker;

begin;

create table if not exists public.zeus_test_audit_failure (
  reason text primary key,
  created_at timestamptz not null default now()
);

create or replace function public.zeus_test_block_security_event()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
      from public.zeus_test_audit_failure f
     where f.reason = new.details ->> 'reason'
  ) then
    raise exception
      'zeus_test: insercion de auditoria bloqueada a proposito (fixture de pruebas)'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists zeus_test_block_security_event_trg on public.security_events;

create trigger zeus_test_block_security_event_trg
before insert on public.security_events
for each row
execute function public.zeus_test_block_security_event();

commit;

-- ---------------------------------------------------------------------------
-- Espejo `security_audit_log` (prueba "the optional security_audit_log mirror
-- may fail without invalidating the mandatory audit").
--
-- Esa prueba requiere que la tabla NO exista, para que la RPC caiga en su rama
-- `undefined_table` (warning) sin abortar el reintento. PostgREST no ejecuta DDL,
-- así que el renombrado lo hace el operador y la suite sólo verifica el estado:
--
--   1. preparar:
--      alter table public.security_audit_log rename to security_audit_log_zeus_test_backup;
--   2. ejecutar con ZEUS_TEST_SCENARIO=audit-log-rename (ver tests/README.md §2.7);
--   3. restaurar SIEMPRE al terminar:
--      alter table public.security_audit_log_zeus_test_backup rename to security_audit_log;
--
-- Contrato del escenario, corregido en la auditoría FASE 4D-REVIEW (hallazgos D1,
-- D4 y M3). Los comentarios anteriores estaban desactualizados:
--   - `default` (o sin ZEUS_TEST_SCENARIO): se exige `security_audit_log` presente,
--     o ausente **sin** backup, y NINGÚN backup. Si el backup existe, la suite falla
--     al arrancar (primera prueba) con la sentencia exacta de restauración: es un
--     renombrado pendiente de una ejecución anterior, no una simple omisión. Con el
--     espejo ausente y sin backup no se bloquea: sólo se anota un diagnóstico.
--   - `audit-log-rename`: se exige el espejo AUSENTE y el backup presente. La prueba
--     del espejo se ejecuta (antes se omitía siempre).
--   - La prueba de higiene (`the run leaves no rows of its own behind`) NO se omite
--     en ningún escenario. Lo que cambia es su alcance: sin espejo, comprueba que
--     tampoco exista un backup inesperado y retorna antes de consultar filas del
--     espejo. Antes se omitía, y por eso contradecía a la prueba del espejo.
--   - `default` NO demuestra que el espejo se escriba: la escritura de la RPC vive
--     en un bloque `begin … exception … raise warning`
--     (ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql:522-568), así
--     que un espejo roto degrada a warning sin poner la corrida en rojo (límite D4).
--     Si se necesita esa evidencia, hay que pedirla a mano tras la corrida.
--
-- La limpieza (C6) borra las filas espejo creadas por la ejecución por
-- `command_id` exacto (original + reintentos), con `action='security_command_requeue'`
-- y el RUN_MARKER en `result`, y siempre antes de borrar las órdenes, porque el FK
-- `on delete set null` las dejaría huérfanas.
--
-- No se deja como bloque ejecutable a propósito: es demasiado fácil olvidarlo.
