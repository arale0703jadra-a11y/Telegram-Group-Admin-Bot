# AFRODITA — propuesta de aislamiento de permisos (no implementada)

Documento de diseño de la Fase 1.C. **No se ha aplicado ningún cambio**, ni en
Supabase ni en AFRODITA. AFRODITA está pausado y no se modificó su código.

## 1. Exposición confirmada

`017_afrodita_integration.sql` y `018_afrodita_global_control.sql` habilitan RLS
pero crean políticas para `anon`:

| Tabla | `anon` puede | No puede |
| --- | --- | --- |
| `afrodita_group_state` | `SELECT`, `INSERT`, `UPDATE` | `DELETE` |
| `afrodita_commands` | `SELECT`, `UPDATE` | `INSERT`, `DELETE` |
| `afrodita_events` | `SELECT`, `INSERT` | `UPDATE`, `DELETE` |
| `afrodita_control_state` | `SELECT`, `INSERT`, `UPDATE` (+ `GRANT` explícito) | `DELETE` |

La clave `anon`/publishable de Supabase es pública por diseño. En consecuencia,
hoy cualquiera que conozca la URL del proyecto y esa clave puede:

1. publicar un estado de grupo falso en `afrodita_group_state`;
2. insertar eventos falsos en `afrodita_events` (contaminando la auditoría);
3. marcar órdenes como `applied`/`failed` en `afrodita_commands`, haciendo que
   ZEUS crea que una orden se ejecutó cuando no fue así;
4. cambiar `afrodita_control_state.mode` a `paused`, deteniendo la actividad.

No puede borrar filas (`DELETE` está revocado), pero sí **falsificar evidencia y
provocar denegación de servicio**. Con AFRODITA pausado el impacto es latente; al
reactivarlo pasa a ser real.

## 2. Por qué no se corrige en esta fase

AFRODITA **escribe** con `AFRODITA_SUPABASE_KEY`, que su propia configuración
exige que sea publishable/anon (`AFRODITA/config.ts`). Sus escrituras observadas
en `AFRODITA/src/integration.ts` son:

- `POST afrodita_group_state?on_conflict=chat_id` (upsert de estado);
- `POST afrodita_events` (eventos);
- `GET afrodita_commands?status=eq.pending` y `PATCH afrodita_commands?id=eq.…`;
- `GET/POST/PATCH afrodita_control_state`.

Revocar `INSERT`/`UPDATE` a `anon` sin cambiar AFRODITA lo dejaría sin poder
publicar estado ni marcar órdenes. Cambiar su autenticación es una modificación
funcional de un servicio pausado y fuera de alcance: por eso se documenta y se
detiene aquí.

## 3. Opciones evaluadas

### Opción A — `service_role` en AFRODITA
Rápida, pero incumple el principio de privilegio mínimo y contradice la propia
configuración de AFRODITA (prohíbe explícitamente `service_role`). **Descartada.**

### Opción B — rol dedicado de base de datos (recomendada)
Un rol `afrodita_writer` sin pertenencia a `anon`/`authenticated`, con `GRANT`
mínimo por tabla y políticas RLS para ese rol. AFRODITA usa una credencial de ese
rol.

- Ventaja: mantiene el modelo tabla+RLS, cambia sólo la credencial.
- Requiere: crear el rol y su credencial (fuera del alcance de ZEUS) y cambiar la
  variable de AFRODITA en su despliegue.
- Riesgo: si la credencial se filtra, el atacante conserva los mismos permisos
  (acotados), no privilegios administrativos.

### Opción C — contrato por RPC
Funciones `SECURITY DEFINER` con parámetros cerrados (`afrodita_publish_state`,
`afrodita_claim_command`, `afrodita_complete_command`, `afrodita_set_control`),
`EXECUTE` sólo para el rol de AFRODITA, y tablas sin acceso directo.

- Ventaja: máxima restricción; además permite validar transiciones de estado.
- Requiere: reescribir la integración de AFRODITA (cambio funcional). Mayor
  esfuerzo y más superficie de error.

## 4. Recomendación

Opción **B** como paso inmediato cuando se autorice tocar AFRODITA, y **C** como
objetivo a medio plazo. Mientras tanto:

- no reactivar AFRODITA sin cerrar esta exposición;
- no usar la clave `anon` para nada que ZEUS necesite (ZEUS usa `service_role` a
  través de `src/supabase.ts` y no depende de estas políticas).

## 5. Borrador de migración futura (NO aplicar)

Se guarda sólo como referencia de diseño. Depende de que AFRODITA ya use el rol
nuevo; aplicarla antes lo dejaría sin escritura.

```sql
-- 022_afrodita_restricted_role.sql (BORRADOR, NO APLICAR AÚN)
-- begin;

-- 1. Rol de escritura dedicado (sin LOGIN interactivo).
-- do $$
-- begin
--   if not exists (select 1 from pg_roles where rolname = 'afrodita_writer') then
--     create role afrodita_writer nologin;
--   end if;
-- end $$;

-- 2. Revocar el acceso anónimo actual.
-- revoke all on public.afrodita_group_state   from anon, authenticated;
-- revoke all on public.afrodita_commands      from anon, authenticated;
-- revoke all on public.afrodita_events        from anon, authenticated;
-- revoke all on public.afrodita_control_state from anon, authenticated;

-- 3. Conceder el mínimo necesario al rol nuevo.
-- grant select, insert, update on public.afrodita_group_state   to afrodita_writer;
-- grant select, update         on public.afrodita_commands      to afrodita_writer;
-- grant select, insert         on public.afrodita_events        to afrodita_writer;
-- grant select, insert, update on public.afrodita_control_state to afrodita_writer;

-- 4. Sustituir las políticas *_anon_* por políticas para afrodita_writer,
--    conservando los DROP antes de cada CREATE. No tocar las de service_role.

-- commit;
```

## 6. Verificación del estado actual (sólo lectura)

```sql
select schemaname, tablename, policyname, roles, cmd
  from pg_policies
 where schemaname = 'public'
   and tablename like 'afrodita_%'
 order by tablename, policyname;

select table_name, grantee, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public'
   and table_name like 'afrodita_%'
   and grantee in ('anon', 'authenticated')
 order by table_name, grantee, privilege_type;
```

Resultado esperado hoy: políticas y privilegios para `anon`. Resultado esperado
tras aplicar la opción B: cero filas para `anon`/`authenticated` y privilegios
sólo para `afrodita_writer` y `service_role`.

