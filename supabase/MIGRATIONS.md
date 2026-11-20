# Inventario de migraciones — ZEUS

Documento de la Fase 5 de la auditoría. Describe qué existe en
`supabase/migrations`, de qué depende cada objeto y en qué estado se cree que
está. **No es una certificación del proyecto remoto:** el estado remoto sólo se
puede afirmar tras consultarlo con autorización explícita (ver
`RUNBOOK.md`, sección 10).

Leyenda de estado:

| Estado | Significado |
| --- | --- |
| **Aplicada** | Existe constancia local de aplicación y verificación en el proyecto compartido. |
| **Aplicada (sin historial)** | Sus efectos se verificaron por consulta, pero no hay fila en `supabase_migrations`. |
| **Preparada** | Revisada y lista para aplicar. **No aplicada.** |
| **Desconocida** | No verificable sin acceso remoto autorizado. |

## 1. Migraciones de ZEUS

> **Regla de citación (hallazgo D7).** Un número de migración **no** identifica un
> archivo. En este workspace conviven cuatro árboles de migraciones y `008`–`011`
> tienen contenidos diferentes según el árbol. Toda referencia debe indicar
> repositorio y ruta completa
> (`ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql`, no `021`).
> Las rutas de esta tabla son relativas a `ZEUS/supabase/migrations/`.

| # | Archivo | Objetos principales | Depende de | Estado |
| --- | --- | --- | --- | --- |
| 008 | `008_system_owner_activation.sql` | Tablas `system_owner*`; 10 RPC `SECURITY DEFINER` (`zeus_bootstrap_system_owner`, `zeus_begin_recovery`, `zeus_recover_system_owner`, …) con `REVOKE` de `public/anon/authenticated` | CERBERO 001 | Aplicada |
| 009 | `009_verified_user_detection_metadata.sql` | Columnas de detección en `verified_users` | CERBERO 006 | Aplicada |
| 010 | `010_verified_title_tracking.sql` | Seguimiento de título personalizado | 009 | Aplicada |
| 011 | `011_verified_member_tag_reviews.sql` | `verified_member_tag_reviews`, `verified_member_tag_audit` | 009 | Aplicada |
| 012 | `012_lock_down_security_data_api.sql` | RLS + `REVOKE`/`GRANT` de 18 tablas y de `claim_security_command` | 001–011 | Aplicada (sin historial) |
| 013 | `013_security_user_activity.sql` | `security_user_activity` (RLS + `service_role`) | — | Aplicada |
| 014 | `014_manual_verified_validity_audit.sql` | 2 RPC de validez manual | 011 | Aplicada |
| 015 | `015_verified_auto_revocation.sql` | 3 RPC y `verified_user_auto_revocation_outbox` | 011 | Aplicada |
| 016 | `016_expired_verified_user_renewal.sql` | 1 RPC de renovación explícita | 011 | Aplicada |
| 017 | `017_afrodita_integration.sql` | Tablas `afrodita_*` (AFRODITA pausado) | — | Aplicada |
| 018 | `018_afrodita_global_control.sql` | `afrodita_control_state` | 017 | Aplicada |
| 019 | `019_zeus_user_sessions.sql` | `zeus_user_sessions` + 3 RPC de sesión | 008 | Aplicada |
| 020 | `020_zeus_security_retention_and_rpcs.sql` | 2 RPC de actividad, 3 purgas por lotes, `zeus_maintenance_runs`, `zeus_log_maintenance_run` | 013, CERBERO 001/002/004/009/011 | **Preparada** |
| 021 | `021_zeus_security_command_requeue.sql` | `zeus_requeue_security_command` (reencolado atómico) | CERBERO 009 y 011 | **Preparada** |

El detalle de aplicación de 008–016 y 019 procede del registro de
`PRODUCTION_READINESS.md` (2026-11-05). No se ha vuelto a consultar el proyecto
remoto en esta revisión.

### Cambios de la Fase 4D (sólo copias locales, sin aplicar)

Ambas migraciones siguen en estado **Preparada** y **no se han ejecutado** en
ninguna base de datos.

| Archivo (ruta completa) | Cambio | Hallazgo |
| --- | --- | --- |
| `ZEUS/supabase/migrations/020_zeus_security_retention_and_rpcs.sql` | El preflight exige `command_id` en `security_warnings`, `security_events` y `security_audit_log`. | E2 |
| `ZEUS/supabase/migrations/020_zeus_security_retention_and_rpcs.sql` | `zeus_purge_security_commands` excluye órdenes referenciadas por las tres tablas (antes sólo `security_warnings`). | E2 |
| `ZEUS/supabase/migrations/020_zeus_security_retention_and_rpcs.sql` | Política explícita de `result_state='unknown'`: no se purga nunca; documentada en `RETENTION_POLICY.md`. | E3 |
| `ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql` | `p_max_attempts`, `p_max_retry_depth` y `p_mute_min_remaining_seconds` se recortan contra techos internos no relajables (5 / 3 / 30 s). | E4 |
| `ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql` | `unique_violation` se clasifica por `constraint_name` y exige la fila ganadora; si no, se propaga el error (nada de `already_retried` sin reintento real). | E5 |

En el resto del documento los archivos se citan por su ruta completa por la misma
razón que en §1 (hallazgo D7 / F-04): `020` y `021` a secas no identifican un
archivo en un workspace con cuatro árboles de migraciones.


## 2. Contrato consumido de CERBERO (no se modifica)

ZEUS no define estos objetos: los **usa**. Cualquier cambio en ellos es una
dependencia que debe coordinarse antes de tocar ZEUS.

| Objeto | Origen | Uso en ZEUS |
| --- | --- | --- |
| `security_commands` (`operation_key`, `result_state`, `execution_started_at`, `lease_expires_at`, `processing_token`, `attempts`) | CERBERO 001/002/007/009/011 | Encolado, reconciliación y reencolado |
| `claim_security_command(text)` | SQL — `CERBERO/supabase/migrations/011_safe_command_lease_recovery.sql` | Reclamación por CERBERO (no invocada por ZEUS) |
| `markCommandExecutionStarted` | TypeScript — `CERBERO/src/database/repositories/commands-repository.ts` (fence de inicio, 6 filtros) | Contrato de ejecución que asume `021` |
| `completeCommand` | TypeScript — `CERBERO/src/database/repositories/commands-repository.ts` (fence de cierre; limpia token/instancia) | Contrato de ejecución |
| `renewCommandLease` | TypeScript — `CERBERO/src/database/repositories/commands-repository.ts` (fence de renovación de lease) | Contrato de ejecución |
| `markCommandUnknown` | TypeScript — `CERBERO/src/database/repositories/commands-repository.ts` (fence de resultado no confirmado) | Contrato de ejecución |
| `security_commands_operation_key_idx` (único parcial sobre `group_id, action, operation_key`) | CERBERO 009 | Garantía de no duplicar órdenes y reintentos |
| `security_warnings.command_id` (`ON DELETE SET NULL`) | CERBERO 004 | La purga de `ZEUS/supabase/migrations/020_zeus_security_retention_and_rpcs.sql` excluye órdenes referenciadas |
| `security_events.command_id` (`ON DELETE SET NULL`) | CERBERO 003 | Igual: la purga de `ZEUS/supabase/migrations/020_zeus_security_retention_and_rpcs.sql` excluye órdenes referenciadas (Fase 4D / E2) |
| `security_audit_log.command_id` (`ON DELETE SET NULL`) | CERBERO 003/007 | Igual: la purga de `ZEUS/supabase/migrations/020_zeus_security_retention_and_rpcs.sql` excluye órdenes referenciadas (Fase 4D / E2) |
| `security_events`, `security_audit_log` | CERBERO 001/003 | Auditoría de órdenes y reintentos |

La migración `ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql`
verifica en su preflight que el índice existe, es `UNIQUE` y cubre exactamente
esas tres columnas; si no, aborta en lugar de operar en degradado.

## 3. Divergencias y riesgos conocidos

1. **Cuatro árboles de migraciones con números repetidos.** El mismo número no
   significa el mismo contenido:
   - `ZEUS/supabase/migrations/` — 008–021 de ZEUS (008–011 son `system_owner`,
     `verified_*`).
   - `CERBERO/supabase/migrations/` — 001–013 del contrato CERBERO (008–011 son
     `restrict_command_claim`, `command_idempotence`, `lock_down`,
     `safe_command_lease_recovery`). **Es la única fuente válida** para el
     contrato que consume ZEUS.
   - `CERBERO/Cerbero-Security-Bot/supabase/migrations/` — 001–009 más
     `APPLY_ALL_001_TO_007.sql`; **le falta 011**, así que un proyecto creado desde
     ahí no tiene `execution_started_at` y
     `ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql` aborta en su
     preflight.
   - `CERBERO/Telegram-Group-Admin-Bot/supabase/migrations/` — 008–011, que son
     copias **de ZEUS**, no de CERBERO.
   Además, `ZEUS/supabase/migrations/012_lock_down_security_data_api.sql` y
   `CERBERO/supabase/migrations/010_lock_down_security_data_api.sql` son el mismo
   archivo con números distintos: aplicar los dos es redundante (elegir uno).

   **`APPLY_ALL_001_TO_007.sql` existe dos veces y las copias no son iguales
   (hallazgo F-01).**

   | Copia (ruta completa) | Tamaño y SHA-256 | Bloque final de endurecimiento |
   | --- | --- | --- |
   | `CERBERO/supabase/migrations/APPLY_ALL_001_TO_007.sql` | 480 líneas, 16 102 B, `d0da4a51…39d5` | Sí (líneas 416-480): RLS, `revoke` a `public/anon/authenticated`, `grant` a `service_role`, políticas `*_service_role_access` y permisos de `claim_security_command` |
   | `CERBERO/Cerbero-Security-Bot/supabase/migrations/APPLY_ALL_001_TO_007.sql` | 414 líneas, 14 294 B, `78e6f088…828a` | No: termina en la definición de `claim_security_command` (línea 414) |

   Los SHA-256 completos están en `tests/README.md` §2.2.1. Las dos copias
   terminan con la `claim_security_command` de la era 007, así que aplicarlas
   **después** de `CERBERO/supabase/migrations/009_command_idempotence.sql` o de
   `CERBERO/supabase/migrations/011_safe_command_lease_recovery.sql` degrada la
   función en silencio (pierde `result_state='processing'` y la protección por
   `execution_started_at`).

   Consecuencia operativa: **en la FASE 4D no se ejecuta ninguna de las dos** (la
   cadena 001→011 ya las hace innecesarias) y, en particular, **nunca**
   `CERBERO/Cerbero-Security-Bot/supabase/migrations/APPLY_ALL_001_TO_007.sql`,
   que pertenece al árbol heredado —el que no tiene `011`— y carece del bloque de
   endurecimiento. Ninguna se borra ni se renombra.

   **No se modificó nada en CERBERO** (fuera de alcance).
2. **`ZEUS/supabase/migrations/012_lock_down_security_data_api.sql` sin fila de
   historial.** Sus efectos están verificados, pero no hay registro en
   `supabase_migrations`. No se insertaron filas manualmente.
3. **`ZEUS/supabase/migrations/020_zeus_security_retention_and_rpcs.sql` y
   `ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql` no
   aplicadas.** Mientras no se apliquen:
   - la actividad usa la ruta REST compatible (con `service_role`) en vez de RPC;
   - `requeueSecurityCommand` responde `rpc_unavailable` y no reencola.
   Ambas rutas degradan de forma segura (no duplican ni pierden órdenes).
4. **Estado remoto desconocido.** Sin acceso autorizado no se puede afirmar qué
   migraciones están aplicadas ahora mismo.

## 4. Verificación previa (sólo lectura)

Ejecutar con el editor SQL del proyecto, nunca desde el bot. Todas las consultas
son de lectura y no modifican nada.

```sql
-- 1. Qué migraciones constan como aplicadas (no prueba efectos, sólo historial).
select version, name, inserted_at
  from supabase_migrations.schema_migrations
 order by version;

-- 2. ¿Existen ya las funciones que crea
--    ZEUS/supabase/migrations/020_zeus_security_retention_and_rpcs.sql?
select p.proname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in (
     'zeus_upsert_user_activity',
     'zeus_get_inactive_activity_candidates',
     'zeus_log_maintenance_run',
     'zeus_purge_security_commands',
     'zeus_purge_security_events',
     'zeus_purge_security_audit_log'
   );

-- 3. ¿Alguna función privilegiada sigue ejecutable por anon/authenticated?
select p.proname, r.rolname as granted_to
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
  join pg_roles r on r.oid = acl.grantee
 where n.nspname = 'public'
   and p.prosecdef
   and r.rolname in ('anon', 'authenticated')
   and acl.privilege_type = 'EXECUTE';
-- Resultado esperado: 0 filas. Cualquier fila es un hallazgo de seguridad.

-- 4. Dependencias que exige
--    ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql.
select indexname, indexdef
  from pg_indexes
 where schemaname = 'public'
   and tablename = 'security_commands'
   and indexname = 'security_commands_operation_key_idx';

select column_name
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'security_commands'
   and column_name in ('operation_key', 'result_state', 'execution_started_at');
```

## 5. Aplicación controlada

Este apartado describe el proyecto **compartido** (el real). Para un proyecto
**desechable nuevo** —validación de la suite de reencolado— el orden mínimo con
rutas completas y el seed obligatorio están en `tests/README.md` §2.2.1 y §2.2.2.

1. Ejecutar el bloque 4 y archivar la salida como evidencia.
2. Aplicar `ZEUS/supabase/migrations/020_zeus_security_retention_and_rpcs.sql` y
   después `ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql` (en ese
   orden: la de reencolado no depende de la de retención, pero mantener el orden
   numérico conserva la trazabilidad).
3. Verificar de nuevo el bloque 4: las seis funciones existen y el punto 3 sigue
   devolviendo 0 filas.
4. Comprobar que las purgas de
   `ZEUS/supabase/migrations/020_zeus_security_retention_and_rpcs.sql` rechazan
   valores fuera de política (`pending`, `processing`, lotes > 5000, retención <
   mínimo) — deben lanzar excepción, no ejecutarse.
5. Registrar version, fecha, ejecutor y resultado.

## 6. Rollback

Sólo es posible de forma limpia porque las dos migraciones de la Fase 4D **no
modifican objetos preexistentes**: se limita a eliminar lo añadido.

```sql
-- ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql
drop function if exists public.zeus_requeue_security_command(
  uuid, bigint, bigint, text, boolean, text, integer, integer, integer
);

-- ZEUS/supabase/migrations/020_zeus_security_retention_and_rpcs.sql
drop function if exists public.zeus_purge_security_audit_log(integer, integer);
drop function if exists public.zeus_purge_security_events(integer, integer);
drop function if exists public.zeus_purge_security_commands(text[], integer, integer);
drop function if exists public.zeus_log_maintenance_run(text, bigint, integer, jsonb);
drop function if exists public.zeus_get_inactive_activity_candidates(bigint, timestamptz, integer);
drop function if exists public.zeus_upsert_user_activity(bigint, bigint, timestamptz);
drop table if exists public.zeus_maintenance_runs;  -- sólo si se acepta perder el registro
```

Tras un rollback de
`ZEUS/supabase/migrations/020_zeus_security_retention_and_rpcs.sql`,
`recordUserActivity` vuelve automáticamente a la ruta REST compatible (la detecta
como `PGRST202`/`42883`), así que no deja de registrar actividad. La tabla de
mantenimiento puede conservarse aunque se eliminen las funciones.

No manipular el historial `supabase_migrations` a mano para "simular" un
rollback: los efectos son lo que importa.


## 7. Decisiones pendientes (propuestas, no implementadas)

Nada de esta sección se ha implementado: **no** se ha tocado SQL, ni la RPC, ni las
pruebas, ni los fixtures. Cada punto requiere aprobación explícita antes de abrir un
cambio. Los identificadores (`P2-2`, `P2-3`, …) son los de la revisión de FASE
4D-REVIEW y se conservan tal cual.

El desarrollo completo de las dos decisiones —alternativas evaluadas, máquinas de
estado, matriz de riesgos, casos de prueba con resultado esperado, archivos que
cambiarían y criterios de autorización— está en
[`../FASE4D_DECISIONS.md`](../FASE4D_DECISIONS.md). Este §7 sigue siendo el
índice; el informe es el detalle. Nada de lo descrito en ambos está implementado.

### 7.1 P2-2 — Borrado de grupo frente a la evidencia de seguridad

**Qué pasa hoy** (leído en los archivos; no se ha ejecutado nada):

| FK | Archivo y línea | Efecto al borrar la fila de `groups` |
| --- | --- | --- |
| `security_commands.group_id` | `CERBERO/supabase/migrations/001_initial_schema.sql:33` | `ON DELETE CASCADE`: se borra la orden, en cualquier estado |
| `security_events.group_id` | `CERBERO/supabase/migrations/001_initial_schema.sql:56` | `ON DELETE CASCADE`: se borra el evento |
| `security_warnings.group_id` | `CERBERO/supabase/migrations/004_security_warnings.sql:3` | `ON DELETE CASCADE` |
| políticas y usuarios protegidos | `CERBERO/supabase/migrations/002_security_policies.sql:2,47,60` | `ON DELETE CASCADE` |
| `security_audit_log.group_id` y `.command_id` | `CERBERO/supabase/migrations/003_command_traceability.sql:6-7`, `CERBERO/supabase/migrations/007_command_leases_audit.sql:6-7` | `ON DELETE SET NULL`: la fila **sobrevive**, desvinculada |

Nadie en el producto borra grupos: ZEUS hace `upsert` del grupo
(`ZEUS/src/services/security-commands.ts:255-258`), lo lee filtrando
`active = true` (`:615-622`) y su único `.delete()` es sobre `security_events` en
`clearSecurityWarnings` (`:893-901`). No hay `delete from groups` en ninguna
migración. El borrado es, por tanto, una acción manual de operador (SQL editor) o
de un proceso futuro de CERBERO.

**Efectos reales que hay que aceptar o corregir:**

1. `result_state='unknown'` está protegido de la purga de
   `ZEUS/supabase/migrations/020_zeus_security_retention_and_rpcs.sql`, pero **no**
   del CASCADE: la política de retención y el borrado de grupo dicen cosas distintas
   sobre la misma fila.
2. Una orden `processing` con lease vivo puede desaparecer a mitad de ejecución:
   `completeCommand` y `renewCommandLease` (helpers TypeScript de `CERBERO/src/database/repositories/commands-repository.ts`) dejan de encontrar la
   fila, la acción puede haberse ejecutado en Telegram y no queda ni rastro ni fence
   que lo detecte.
3. `security_events` alimenta el perfil y las advertencias
   (`getSecurityUserProfile`, `clearSecurityWarnings`): se pierde el historial del
   usuario en ese grupo.
4. El espejo queda huérfano: las filas de `security_audit_log` con
   `action = 'security_command_requeue'` sobreviven con `group_id` y `command_id` a
   `NULL`, así que ya no se puede reconstruir a qué grupo pertenecía el reencolado.

**Alternativas:**

| Opción | Qué implica | Ventajas | Costes y riesgos |
| --- | --- | --- | --- |
| **A.** Mantener `CASCADE` y declarar el límite | Documentar que borrar un grupo destruye su evidencia, prohibirlo salvo incidente y añadirlo al runbook | Coste 0, sin migración, coherente con el estado actual | Depende de disciplina humana; el borrado es irreversible (no hay papelera); el límite hay que repetirlo en cada documento |
| **B.** `ON DELETE RESTRICT` en `security_commands`, `security_events` y `security_warnings` | El borrado del grupo falla mientras haya evidencia: obliga a archivar o purgar antes | Hace imposible la pérdida accidental | Migración de CERBERO (fuera de ZEUS); sin TTL las filas bloquean el borrado para siempre; exige procedimiento de dos pasos y coordinación con CERBERO |
| **C.** Archivo o baja lógica | Fase 1: `groups.deleted_at` + `active = false` y prohibir `DELETE`. Fase 2: `before delete` que copia a `security_*_archive` y deja actuar al `CASCADE` | Conserva evidencia y permite purga política (nunca `unknown`) | Tablas nuevas + RLS/`revoke`/`grant` + purga + pruebas; requiere decidir cuánto se conserva la evidencia de un grupo dado de baja |

**Recomendación (para aprobar, sin implementar):** opción **C en dos fases** —
primero la baja lógica en `groups` (barata, reversible y sin tocar las tablas de
seguridad) y después el archivo. Mientras no haya aprobación, el estado real es **A**
y así queda declarado. B sólo tiene sentido si se quiere un candado duro inmediato y
CERBERO acepta el coste.

### 7.2 P2-3 — Carrera de `operation_key` en `zeus_requeue_security_command`

**Comportamiento actual** (todo en
`ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql`):

1. La original se lee con `select … for update` (`:279-283`): dos reencolados de la
   **misma** orden se serializan.
2. Pre-check del reintento (`:369-379`): se busca una fila con `(group_id, action,
   operation_key = <clave>#retry)` y, si existe, se devuelve `already_retried` con su
   id. **No se comprueba de qué intención es esa fila.**
3. Si nada falla, la original se neutraliza (`:415-436`) y se inserta la copia
   (`:441-461`).
4. `unique_violation` (`:462-493`): se clasifica por `constraint_name` y se exige una
   fila ganadora; sin ganador, o con otra restricción, se propaga el error y revierte
   la sentencia completa.
5. La auditoría obligatoria (`security_events`, `:501-523`) y el espejo (`:525-571`)
   se escriben en la misma transacción.

**Corrección de premisa (FASE 4D-DECISIONS §3.2).** `operation_key` **no** es
texto libre: es un SHA-256 hexadecimal calculado en
`src/services/security-commands.ts:142-172`, de modo que una clave generada por
`enqueueSecurityCommand` **nunca** termina en `#retry`. El vector descrito a
continuación sólo es alcanzable con datos no conformes (SQL manual, fixture o
fila histórica anterior a la convención del hash). La conclusión —no fiarse de la
forma de la clave— se mantiene; lo que cambia es la justificación y el montaje de
la prueba.

**La carrera.** El índice único protege `(group_id, action, operation_key)`, no la
*procedencia* del ganador, y la clave del reintento es una convención de texto
(`<clave>#retry`, `SECURITY_COMMAND_RETRY_SUFFIX` en
`ZEUS/src/services/security-command-recovery.ts:23`), no un espacio de nombres
reservado:

1. La orden A tiene `operation_key = K` y un humano pide reencolarla.
2. Aparece una fila B con `operation_key = 'K#retry'` que pertenece a **otra
   intención**. Con datos conformes eso no puede ocurrir (ver la corrección de
   premisa), así que B sólo puede venir de una escritura que no pase por
   `buildSecurityCommandOperationKey`: SQL manual, script de operador, fixture o
   fila histórica con clave no-hash.
3. El `insert` choca con `security_commands_operation_key_idx`; el ganador se busca
   sólo por `(group_id, action, operation_key)` (`:477-481`) y la RPC responde
   `already_retried` con el id de B.
4. Resultado: A quedó neutralizada (`result_state='unknown'`, lease y token
   borrados) y el operador recibe "ya reencolada" señalando a una orden que hace otra
   cosa. El reintento pedido **no existe** y A ya no es reclamable ni renovable.
   - Variante sin neutralización (choque detectado en el pre-check): A no se toca,
     pero la RPC igualmente informa `already_retried` ajeno: el humano cree que el
     reintento está en marcha cuando no lo está.
   - El cliente repite la comprobación sin procedencia
     (`ZEUS/src/services/security-commands.ts:1483-1496`): también acepta cualquier
     fila con esa clave.

**Comportamiento esperado propuesto (a aprobar, no implementado):**

- **P-1 (recomendada).** Reservar la clave **antes** de neutralizar e identificar al
  ganador por procedencia:
  - el reintento se inserta con `payload.requeuedFrom = <id de la original>` y
    `payload.requeueDepth`;
  - se invierte el orden: `insert` del reintento → si prospera, neutralizar la
    original → auditoría;
  - si el `insert` choca, sólo se informa `already_retried` cuando
    `payload.requeuedFrom` es la **misma** original; en cualquier otro caso se
    devuelve un outcome nuevo `retry_key_conflict` (con revisión humana) **sin
    neutralizar nada**.
  - Efecto: desaparece la combinación "orden neutralizada + reintento inexistente" y
    el fallo deja de ser un `raise` genérico para volverse un resultado auditable.
- **P-2 (mínima).** Mantener el orden actual y añadir la comprobación de procedencia
  en los dos puntos (`:369` y `:477`), devolviendo `retry_key_conflict` en vez de
  `already_retried` cuando el ganador no sea de la misma original.
- **P-3 (estructural, mayor).** Dejar de derivar la clave por texto y dar al
  reintento un espacio de nombres propio (`zeus:retry:<uuid de la original>`). Hace
  la colisión imposible, pero rompe la paridad con `SECURITY_COMMAND_RETRY_SUFFIX`,
  con `tests/security-command-requeue.test.ts` y con las claves de los fixtures.

**Pruebas necesarias (ninguna implementada todavía):**

| # | Escenario | Montaje | Resultado esperado con P-1 |
| --- | --- | --- | --- |
| 1 | Misma orden original reencolada concurrentemente | Dos llamadas simultáneas a la RPC sobre la misma orden; `for update` (`:279`) las serializa | 1 `requeued` + 1 `already_retried` con el id del reintento real; una sola fila `K#retry`; un solo `security_events` |
| 2 | Fila no conforme cuya clave imita el sufijo (`K#retry`) | Sembrar por SQL una fila B con `operation_key = 'K#retry'` (otra intención, sin pasar por `buildSecurityCommandOperationKey`) y reencolar A (`operation_key = K`) | Hoy: `already_retried` con el id de B y, si el choque ocurre tras el pre-check, A neutralizada. Con P-1: `retry_key_conflict`, A **no** neutralizada y sin fila nueva |
| 3 | Conflicto por otra restricción única | Índice único temporal creado por la prueba (p. ej. sobre `(group_id, action, status)`) que el reintento viole | La sentencia entera revierte; ZEUS traduce a `unexpected_rpc_outcome` con revisión humana (`security-commands.ts:1497-1504`); nunca `already_retried` |
| 4 | Rollback y conservación de evidencia | Fallo determinista del `insert` de auditoría (fixture `tests/fixtures/security-command-requeue-audit-failure.sql`) | La original conserva `result_state`, lease y token; no queda fila `K#retry`; no queda `security_events` con `originalCommandId` de A; el espejo no añade filas (escritura best-effort: §2.7 de `tests/README.md`, límite D4) |

La 4 corresponde al escenario que ya monta el fixture de auditoría bloqueada y la 3
usa la misma clasificación E5 que hoy se prueba de forma unitaria; las pruebas 1 y 2
son nuevas y necesitan **dos conexiones concurrentes**, que la suite no abre en la
actualidad.

### 7.3 Otros hallazgos abiertos (documentados, fuera de alcance)

Se conservan tal cual, sin ampliar el alcance de implementación. Los de las series P2
y P3 proceden de la revisión de FASE 4D-REVIEW y **no se reescriben** aquí para no
alterar su clasificación.

| ID | Clasificación | Estado / qué falta |
| --- | --- | --- |
| P2-1 | Atribución de helpers TypeScript y divergencia entre las dos copias de CERBERO | Pendiente. Las dos copias (`CERBERO/supabase/migrations/` y `CERBERO/Cerbero-Security-Bot/supabase/migrations/`) no coinciden y la documentación debe citar siempre la canónica (la de la cadena 001→011, `CERBERO/supabase/migrations/`). Requiere una pasada de atribución con rutas completas |
| P2-4 | Ausencia de interfaz de revisión para `stale`, `unknown` y `requeue` | Pendiente. La revisión es manual (SQL + `requeueSecurityCommand`); no hay UI ni comando de operador. Requiere diseño de producto |
| H-R1 | Un reintento **terminal** (`completed`/`failed`/`unknown`) bloquea para siempre el reencolado de su original | Pendiente. El pre-check (`021:368-380`) no mira el estado del ganador, así que `already_retried` es permanente y el operador no puede distinguir «en marcha» de «ya falló». Corregirlo exige una decisión de producto (¿segundo reintento con clave nueva?) y redefinir `already_retried`. Análisis completo en [`../FASE4D_DECISIONS.md`](../FASE4D_DECISIONS.md) §3.3 y §3.8 |
| P3-1 … P3-8 | Mejoras menores de la revisión | Pendientes; conservan su numeración y descripción originales. No se detallan aquí precisamente para no reescribirlas |
| D4 | El escenario `default` no demuestra que el espejo escriba | Límite de diseño ya documentado en `tests/README.md` §2.7 y en `tests/fixtures/security-command-requeue-audit-failure.sql`: la escritura del espejo es best-effort (`ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql:525-571`) y degrada a warning. No se corrige |
| — | Sin bloqueo distribuido en el diario local de bindings (`tests/.artifacts/bindings-journal.json`) | Pendiente. Dos runners concurrentes no se excluyen entre sí; la exclusividad se declara a mano en el runbook (§3.1, paso 3) |
| — | Vaciedad del preflight limitada a `security_commands` | Pendiente. `tests/support/preflight.ts:247-254` sólo exige que `security_commands` esté vacía (descontando residuos recuperables); `security_events`, `security_warnings` y `security_audit_log` pueden contener filas ajenas. La limpieza borra sólo lo propio, así que no destruye datos de terceros, pero la exclusividad del proyecto queda probada sólo para órdenes |

**Regla de cierre:** ninguno de estos puntos se implementa en ZEUS FASE 4D. Cualquier
cambio en `ZEUS/supabase/migrations/020_zeus_security_retention_and_rpcs.sql`,
`ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql`, en las políticas de
borrado o en la interfaz de revisión abre una fase nueva con su propia aprobación; y
nada de lo aquí descrito se aplica a CERBERO, que permanece intacto.

