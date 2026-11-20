-- tests/fixtures/security-command-requeue-disposable-marker.sql
--
-- MARCADOR OBLIGATORIO para ejecutar
-- `tests/security-command-requeue-postgres.test.ts` (endurecimiento C7).
--
-- Por qué existe: `ZEUS_TEST_SUPABASE_DISPOSABLE=yes` es sólo una variable de
-- entorno; cualquiera puede exportarla apuntando al proyecto equivocado. El
-- marcador es un objeto que SÓLO existe en un proyecto creado para estas
-- pruebas, así que la suite lo exige antes de insertar o borrar una sola fila.
--
-- La prueba comprueba: la tabla existe, es legible con la clave de servicio y
-- tiene al menos una fila. Si no puede comprobarlo (tabla ausente, error de
-- permisos o de red), OMITE las pruebas con el motivo; nunca las ejecuta.
--
-- Ejecutar UNA VEZ en el proyecto desechable (SQL editor o psql), después de las
-- migraciones CERBERO 001→011 y ZEUS 021:
--
--   psql "$ZEUS_TEST_DATABASE_URL" -f tests/fixtures/security-command-requeue-disposable-marker.sql
--
-- RLS activado y sin políticas: ni `anon` ni `authenticated` pueden leerla; sólo
-- `service_role` (que omite RLS), que es la única clave que usan las pruebas.
--
-- Cómo retirarlo al destruir el proyecto:
--   drop table if exists public.zeus_test_disposable_marker;

begin;

create table if not exists public.zeus_test_disposable_marker (
  note text not null,
  created_at timestamptz not null default now()
);

alter table public.zeus_test_disposable_marker enable row level security;

insert into public.zeus_test_disposable_marker (note)
select 'proyecto desechable para las pruebas de integración de ZEUS'
where not exists (select 1 from public.zeus_test_disposable_marker);

revoke all on public.zeus_test_disposable_marker from public, anon, authenticated;

commit;

-- Verificación rápida (debe devolver 1):
--   select count(*) from public.zeus_test_disposable_marker;
