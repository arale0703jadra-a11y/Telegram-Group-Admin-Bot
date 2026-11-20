# ZEUS — FASE 4D-DECISIONS

**Informe de diseño para P2-2 (ciclo de vida de grupos) y P2-3 (colisiones de
`operation_key`).**

Estado: **sólo diseño. Nada implementado.** Este documento es el «informe de la
Fase 4D» al que remiten `src/services/security-command-recovery.ts:219-220`,
`src/services/security-commands.ts:1099-1102` y
`supabase/RETENTION_POLICY.md:107`.

| Dato | Valor |
| --- | --- |
| Repositorio | `C:\Users\cjus2\OneDrive\Documentos\Telegram-Bots\ZEUS` |
| Rama / HEAD | `main` / `d3658dc5a1010d6d98fd664722dd5aa7aed3b725` |
| Entradas de Git preexistentes | **Dato histórico** (no refleja el estado actual del repositorio): 46 al redactar este informe; la auditoría posterior registró 50 → 51 (ver §9.3) |
| SQL ejecutado | Ninguno |
| Migraciones creadas o modificadas | Ninguna |
| Supabase CLI / red / PostgreSQL | No utilizados |
| CERBERO / AFRODITA | Sólo lectura; sin cambios |

---

## 0. Método y límites

Todo lo que sigue se obtuvo **leyendo** los archivos del repositorio. No se ha
ejecutado SQL, no se ha abierto conexión a PostgreSQL ni a Supabase, no se ha
leído ningún secreto y no se ha modificado código de producción, fixtures con
sentencias ni migraciones. Las referencias `archivo:línea` apuntan a la copia
canónica `CERBERO/supabase/migrations/` (cadena 001→013), conforme a P2-1.

Convención: cuando dice «hoy», describe el comportamiento del código en `HEAD`;
cuando dice «propuesto», describe algo que **requiere aprobación** y que no
existe en el repositorio. Las referencias a la migración `021` corresponden al
archivo tal como estaba a las 13:20 del 18/11/2026; §9.3 explica por qué eso
importa.

---

## 1. Resumen ejecutivo

### 1.1 P2-2 — Grupos

1. Borrar una fila de `groups` **destruye evidencia**: nueve FK con
   `ON DELETE CASCADE` arrastran órdenes en cualquier estado, eventos,
   advertencias, sanciones, protegidos, verificados, configuración y bindings
   (§2.1).
2. `groups.active` ya es un punto de control real: lo respetan la reclamación de
   CERBERO (`CERBERO/supabase/migrations/011_safe_command_lease_recovery.sql:68`),
   la elegibilidad del reencolado
   (`supabase/migrations/021_zeus_security_command_requeue.sql:383-398`), el
   listado de grupos conectados (`src/services/security-commands.ts:619-621`) y
   el catálogo de AFRODITA (`CERBERO/supabase/migrations/012_afrodita_verified_catalog_read.sql:42`).
3. **Bloqueador nuevo, no documentado hasta ahora:** `ensureCerberoBinding`
   hace `upsert({ chat_id, active: true })`
   (`src/services/security-commands.ts:255-258`) en **cada** encolado. Una baja
   lógica basada sólo en `active = false` se **resucita** con la siguiente orden
   del grupo. Cualquier fase 1 que ignore esto es decorativa.
4. **Riesgo de borrado físico:** el esquema vigente de CERBERO tiene nueve FK con
   `ON DELETE CASCADE` hacia `groups` (§2.1), de modo que un `DELETE FROM groups`
   destruye evidencia sin pasar por la política de retención. La política
   (`supabase/RETENTION_POLICY.md` §3, «Eliminación física») lo documenta como
   una acción manual destructiva distinta de la purga por lotes. No es una
   contradicción entre documentos: es un hueco operativo que P2-2 debe cerrar.
5. Recomendación: **C en dos fases**, con la fase 1 apoyada en una tabla
   propiedad de ZEUS (`zeus_group_lifecycle`) para **no alterar** `groups`
   (tabla de CERBERO), más la corrección del `upsert` y un rechazo tipado en el
   encolado. Fase 2: archivo por copia + manifiesto antes del borrado.

### 1.2 P2-3 — `operation_key`

1. **Corrección al análisis previo:** `operation_key` **no** es texto libre. Es
   un SHA-256 hexadecimal calculado en
   `src/services/security-commands.ts:142-172`. Por tanto la clave de un
   encolado normal **nunca** termina en `#retry` y el vector descrito en
   `supabase/MIGRATIONS.md:325-330` («un `idempotencyKey` explícito cuyo texto
   coincide con el sufijo») **no es alcanzable** por `enqueueSecurityCommand`.
   Hay que corregir esa premisa antes de escribir pruebas sobre ella.
2. Lo que **sí** es alcanzable: (a) filas no conformes (SQL manual, fixtures o
   escrituras ajenas a `buildSecurityCommandOperationKey`); (b) el cliente repite la misma
   suposición sin procedencia en el camino `23505`
   (`src/services/security-commands.ts:1483-1496`); (c) un reintento **terminal**
   bloquea para siempre el reencolado de su original (§3.3, H-R1).
3. Recomendación: **P-1 con inversión de orden** (insertar el reintento antes de
   neutralizar), procedencia en `payload.requeuedFrom`, y un outcome nuevo
   `retry_key_conflict` que **no** neutraliza nada. La inversión es segura por
   MVCC: ninguna otra sesión ve la fila insertada antes del `commit`, y al
   `commit` la original ya está neutralizada.

### 1.3 Dependencia entre ambas

P2-2 fase 2 archiva `security_commands` **con su `payload`**. Si P2-3 introduce
procedencia en `payload`, el archivo debe conservarla (copia íntegra de la fila)
o la trazabilidad del reintento se pierde justo cuando se intenta conservar
todo. Ver §7.

### 1.4 Divergencia entre los dos árboles locales de CERBERO (documentado, sin decisión)

Existen **dos** árboles locales de código CERBERO, ambos en el mismo repositorio:

- `CERBERO/src/**` — cadena de migraciones **001–013**; su
  `commands-repository.ts` define `markCommandExecutionStarted` (6 fences) y es la
  copia referenciada como canónica en `MIGRATIONS.md` y en la guarda T-14.
- `CERBERO/Cerbero-Security-Bot/**` — migraciones **001–009** (sin `011`, por
  tanto sin `execution_started_at`) y **sin** `markCommandExecutionStarted`.

Riesgo: si un ejecutor que carece de la marca de inicio
(`markCommandExecutionStarted`) se ejecutara contra un esquema que **sí** contiene
`execution_started_at`, ZEUS podría interpretar una ejecución ya iniciada como «no
iniciada» y reprocesarla (la reconciliación y el reencolado de 021 usan
`execution_started_at IS NULL`), con riesgo latente de **doble ejecución de
sanciones**. No es posible confirmar **localmente** qué árbol está desplegado en
Railway; esa verificación queda **pendiente de acceso remoto autorizado**, y **no
se afirma aquí cuál es la versión de producción**.

---

## 2. P2-2 — Ciclo de vida de grupos

### 2.1 Inventario verificado de dependencias

`groups` sólo tiene cuatro columnas: `chat_id`, `title`, `active` (default
`true`), `created_at` (`CERBERO/supabase/migrations/001_initial_schema.sql:14-19`).
**No existe `deleted_at` ni equivalente.**

FK con `ON DELETE CASCADE` (borrar el grupo borra la fila hija):

| Tabla | Columna | Origen | Qué se pierde |
| --- | --- | --- | --- |
| `group_bot_bindings` | `group_id` | CERBERO 001:22 | vínculo grupo↔bot y sus `permissions` |
| `security_commands` | `group_id` (NOT NULL) | CERBERO 001:33 | **todas las órdenes, en cualquier estado** |
| `security_events` | `group_id` (NOT NULL) | CERBERO 001:56 | **todo evento, incluida la auditoría de reencolado** |
| `security_group_configs` | `group_id` (PK) | CERBERO 002:2 | política, antispam, umbrales |
| `security_sanctions` | `group_id` | CERBERO 002:47 | historial de sanciones |
| `security_protected_users` | `group_id` | CERBERO 002:60 | lista de protegidos |
| `security_warnings` | `group_id` | CERBERO 004:3 | advertencias |
| `verified_users` | `group_id` | CERBERO 006:3 | lista de verificados |
| `afrodita_verified_catalog_groups` | `group_id` (PK) | CERBERO 012:7 | permiso de publicación del catálogo |

FK con `ON DELETE SET NULL` (la fila sobrevive, desvinculada):

| Tabla | Columna | Origen | Efecto |
| --- | --- | --- | --- |
| `security_audit_log` | `group_id` | CERBERO 003:7 (007:7 idempotente) | fila sin grupo |
| `security_audit_log` | `command_id` | CERBERO 003:6 / 007:6 | fila sin orden |
| `security_events` | `command_id` | CERBERO 003:2 | irrelevante: la fila ya cayó por `group_id` |
| `security_warnings` | `command_id` | CERBERO 004:8 | ídem |

Tablas **de ZEUS** con `group_id`/`chat_id` y **sin FK** a `groups`: sobreviven
**huérfanas** (no se borran; apuntan a un grupo inexistente):

| Tabla | Columna | Origen |
| --- | --- | --- |
| `verified_member_tag_reviews` | `group_id` | ZEUS 011:2 |
| `verified_member_tag_audit` | `group_id` | ZEUS 011:39 |
| `security_user_activity` | `group_id` | ZEUS 013:4 |
| `verified_user_manual_audit` | `group_id` | ZEUS 014:25 |
| `verified_user_auto_revocation_outbox` | `group_id` | ZEUS 015:19-20 (FK a `manual_audit(event_key)`) |
| `afrodita_group_state` / `afrodita_commands` / `afrodita_events` | `chat_id` | ZEUS 017:24, 017:33, 017:46 |

`zeus_user_sessions` (ZEUS 019:1-11) no tiene `group_id`: se indexa por usuario
y no se ve afectada.

**Consecuencia:** borrar un grupo no es «borrar un grupo». Es un borrado parcial
de evidencia (lo que cuelga de una FK) más un conjunto de huérfanos (lo que no
cuelga). Hoy ningún documento enumera ambos efectos, así que el operador no
puede saber qué está perdiendo.

### 2.2 Qué existe ya y sirve (sin escribir nada)

`groups.active = false` **ya** detiene la ejecución, sin tocar el esquema:

| Punto de control | Archivo:línea | Efecto de `active = false` |
| --- | --- | --- |
| Reclamación de CERBERO | `CERBERO/.../011_safe_command_lease_recovery.sql:68` (`join public.groups g on … and g.active = true`) | ninguna orden del grupo se reclama |
| Elegibilidad del reencolado | `ZEUS/.../021_...requeue.sql:383-398` | `group_not_eligible`, no se crea nada |
| Grupos conectados | `ZEUS/src/services/security-commands.ts:619-621` (`.eq("active", true)`) | desaparece del listado/panel |
| Catálogo AFRODITA | `CERBERO/.../012_afrodita_verified_catalog_read.sql:42` y `013:46` | deja de publicarse |

Es decir: la **fase 1 no necesita DDL en tablas de CERBERO**. Lo que falta no es
un flag, es (a) que nadie lo revierta, (b) que el encolado lo respete y (c) que
quede auditado.

### 2.3 El bloqueador: el `upsert` que resucita el grupo

```ts
// src/services/security-commands.ts:255-258
const { error: groupError } = await db
  .from("groups")
  .upsert({ chat_id: groupId, active: true }, { onConflict: "chat_id" });
```

`enqueueSecurityCommand` llama a `ensureCerberoBinding` **antes** de insertar
(`src/services/security-commands.ts:272`). PostgREST traduce ese `upsert` a
`insert … on conflict (chat_id) do update set active = excluded.active`, de modo
que **cada** acción de seguridad del grupo vuelve a poner `active = true`.

Efecto práctico: una baja lógica basada sólo en `active` dura hasta la siguiente
orden. Peor: mientras el grupo está «de baja», ZEUS sigue creando órdenes
`pending` que CERBERO no puede reclamar; quedan como intención vigente invisible
(la política de retención prohíbe purgar `pending`,
`supabase/RETENTION_POLICY.md:30`).

### 2.4 El hueco que hay que cerrar: borrado físico frente a la política de retención

La política (`supabase/RETENTION_POLICY.md`) separa explícitamente dos
operaciones:

- **Purga por lotes** (`zeus_purge_*`): respeta `result_state`, las referencias
  (`command_id` en `security_warnings`/`security_events`/`security_audit_log`) y
  la retención; nunca activa las FK sobre `groups`.
- **Eliminación física** (`DELETE FROM groups`): dispara los nueve `ON DELETE
  CASCADE` de §2.1 y destruye evidencia **sin** pasar por la política.

No se afirma aquí que la política contenga como principio «sin `ON DELETE
CASCADE`»: esa frase **no** aparece en la versión vigente de
`RETENTION_POLICY.md`. Su §1 fija el criterio «Nada automático» (sin cron ni
triggers de borrado ejecutados por ZEUS) y su §3 documenta los `CASCADE` como
riesgo de la eliminación física. Lo que existe es una **asimetría operativa**:
dos mecanismos de borrado tratan la misma fila de forma distinta.

No es un detalle de redacción: `zeus_purge_security_commands` se diseñó
explícitamente para **no** confiar en `ON DELETE SET NULL`
(`supabase/migrations/020_zeus_security_retention_and_rpcs.sql:279-287` y
`:496-503`); el autor de la retención ya razonó que el borrado por FK no
conserva trazabilidad… y aun así el borrado de grupo sigue usándolo. P2-2 es la
corrección de esa asimetría.

### 2.5 Máquina de estados propuesta para un grupo

```
                        (upsert de enqueue: NO debe reactivar)
                                        |
  [sin fila] --ensureCerberoBinding--> activo --operador--> pausado
                                        ^  |                (active=false)
                  (sólo explícito)      |  |                     |
                                        |  +------operador------>|
                                        |                        v
                                        |                   baja lógica
                                        |              (lifecycle.deleted_at)
                                        |                        |
                                        |                [ventana de gracia]
                                        |                        v
                                        |                     archivado
                                        |        (copia + manifiesto + DELETE)
                                        v                        |
                                   reactivado <-- (sólo si NO archivado) <
```

Reglas duras:

1. `activo → pausado` y `pausado → activo` son reversibles y baratos.
2. La `baja lógica` **no** se revierte por un `upsert`; sólo por una acción
   explícita de operador con motivo y auditoría.
3. `archivado` es terminal: el `chat_id` puede volver a existir (Telegram lo
   permite), pero sería un grupo **nuevo**, sin historia heredada. El manifiesto
   conserva el vínculo por `chat_id` + `archived_at`.

### 2.6 Fase 1 — desactivación (propuesta, sin implementar)

Objetivo: que «dar de baja» sea reversible, auditado y no dependa de disciplina
humana, **sin DDL sobre tablas de CERBERO**. La fase 1 ejecuta DML sobre una
tabla existente de CERBERO (`groups.active = false`) y crea objetos nuevos
propiedad de ZEUS (`zeus_group_lifecycle` + RPC); no exige `ALTER`/`DROP` de
objetos ajenos.

1. **Tabla de ciclo de vida propiedad de ZEUS** (evita `ALTER TABLE groups`):

   ```
   -- BORRADOR de diseño (no es una migración; no aplicar)
   zeus_group_lifecycle(
     chat_id       bigint primary key references public.groups(chat_id) on delete restrict,
     disabled_at   timestamptz,
     disabled_by   bigint,
     reason        text check (char_length(reason) between 3 and 500),
     deleted_at    timestamptz,
     deleted_by    bigint,
     archive_requested_at timestamptz,
     updated_at    timestamptz not null default now()
   )
   ```

   Sin `cascade` a propósito: la fila conserva `deleted_at`, `deleted_by`,
   `reason` y `archive_requested_at`, que son **auditoría de la baja**, no una
   simple descripción del grupo. Con `on delete restrict`, un `DELETE FROM
   groups` manual falla mientras exista la fila de ciclo de vida, lo que obliga
   a pasar por la fase 2 (copiar al manifiesto y borrar la fila explícitamente)
   antes de poder eliminar el grupo. Alternativas a evaluar (sin implementar):
   (a) `restrict` + borrado explícito en fase 2; (b) FK diferible; (c) copia al
   manifiesto y borrado en la misma transacción. La solución elegida debe
   garantizar que la auditoría de la baja sobreviva al borrado del grupo.

2. **Corregir el `upsert`** (`src/services/security-commands.ts:255-258`) para
   que **no** escriba `active` cuando la fila ya existe (insertar sólo si falta;
   si existe, no tocar la columna). Es el cambio que hace real la fase 1.

3. **Rechazo tipado en el encolado (preventivo, no autoritativo).**
   `enqueueSecurityCommand` debe consultar el ciclo de vida y devolver un
   resultado explícito —`group_disabled` / `group_archived`— en vez de crear
   órdenes `pending` que nadie reclamará. Si la consulta es una **caché**, es
   una defensa preventiva y **no** una garantía transaccional: entre la
   invalidación de la caché y el `insert` permanece una ventana. Las garantías
   autoritativas son otras dos: (a) `claim_security_command` de CERBERO sólo
   reclama con `active = true` (011:68) y (b) la precondición de fase 2
   (`FOR UPDATE` sobre `groups`). **No** debe afirmarse que la fase 1 impide por
   completo nuevas órdenes mientras dependa de una caché.

4. **Operación de baja**: `active = false` + fila en `zeus_group_lifecycle` con
   `deleted_at`, `deleted_by`, `reason` + evento `security_group_deactivated` en
   `security_events`, todo en **una** RPC transaccional (nunca varias llamadas
   sueltas desde el bot).

5. **Prohibición explícita de `DELETE`**: no se puede impedir con `REVOKE` sin
   tocar privilegios de `groups` (CERBERO 010:8 concede `service_role`), así que
   se declara en el runbook y se verifica con una consulta de control. La fase 2
   sustituye la prohibición por un procedimiento.

6. **Órdenes ya en vuelo**: la baja **no** cancela órdenes `processing`. Se
   espera a que CERBERO cierre o abandone; la política de staleness y el
   reencolado existentes siguen aplicando. Cancelar en masa sería una decisión
   destructiva que ninguna aprobación cubre hoy.

7. **Reactivación explícita y condicionada.** `zeus_reactivate_security_group`
   debe rechazar un grupo que esté en proceso de archivado, que tenga
   `archive_requested_at` o `deleted_at` establecidos, o que ya esté archivado.
   La reactivación exige una transición explícita y validada (actor + motivo),
   nunca un `upsert`. Reactivar un `chat_id` ya archivado **no** está permitido:
   Telegram puede reutilizar el id, pero sería un grupo nuevo sin historia.

### 2.7 Qué ocurre con cada tipo de fila (requisito explícito)

| Elemento | Fase 1 (baja lógica) | Fase 2 (archivo) |
| --- | --- | --- |
| Órdenes `pending` | **No se tocan.** Dejan de poder reclamarse (grupo inactivo) y son la razón para no archivar un grupo con intención viva: la fase 2 **aborta** si existen | Se archivan como `pending`; el manifiesto lo marca para revisión humana |
| Órdenes `processing` con lease vivo | **No se tocan.** Pueden terminar: `complete_command`/`renew_command_lease` siguen funcionando porque la fila existe | La fase 2 **aborta**: archivar una ejecución en curso destruye el fence |
| Órdenes `processing` + `result_state='unknown'` | **No se tocan.** Evidencia de resultado no confirmado | Se archivan; el manifiesto las cuenta y exige confirmación explícita |
| Órdenes `completed` / `failed` / `cancelled` | **No se tocan** | Se archivan y después se borran (el `CASCADE` las habría borrado igual, pero sin copia) |
| `security_events` (incluida la auditoría de reencolado) | Se conservan; se **añade** el evento de baja | Se archivan y se borran |
| `security_warnings`, `security_sanctions`, `security_protected_users`, `verified_users`, `security_group_configs` | Se conservan | Se archivan y se borran |
| `security_audit_log` (espejo) | Se conserva | **Copia** al archivo (el `SET NULL` destruye el vínculo); después el FK la desvincula |
| Reintentos pendientes (`<clave>#retry`) | **No se tocan**: son `pending` y bloquean la fase 2 | Ídem `pending` |
| Tablas de ZEUS sin FK (§2.1) | Se conservan | Se archivan y se borran **explícitamente**; el `CASCADE` no las tocaría y quedarían huérfanas |
| `afrodita_group_state` / `afrodita_commands` / `afrodita_events` | Se conservan | Se archivan y se borran; si AFRODITA siguiera activo, la fase 2 exige su visto bueno |

### 2.8 Fase 2 — archivo o eliminación controlada (propuesta, sin implementar)

Precondiciones obligatorias (si cualquiera falla, la RPC **aborta** y no escribe
nada):

1. `zeus_group_lifecycle.deleted_at is not null` y `groups.active = false`.
2. `archive_requested_at is not null` (la fase 2 se marca antes de empezar).
3. Sin órdenes `pending` ni `processing` en el grupo.
4. Antigüedad mínima desde `deleted_at` (ventana de gracia; propuesta: 30 días,
   alineada con el mínimo de `zeus_purge_security_commands`, 020:317-319).
5. Confirmación explícita del operador (`p_acknowledged = true`), como en 021:406.

Esquema de archivo (todo propiedad de ZEUS, sin tocar CERBERO):

```
-- BORRADOR de diseño (no es una migración; no aplicar)
zeus_group_archive_manifest(
  archive_id    uuid primary key default gen_random_uuid(),
  chat_id       bigint not null,
  group_row     jsonb not null,   -- copia íntegra de groups
  lifecycle_row jsonb not null,   -- copia íntegra de zeus_group_lifecycle
  counts        jsonb not null,   -- filas copiadas por tabla
  archived_at   timestamptz not null default now(),
  archived_by   bigint not null,
  reason        text not null
)

zeus_archive_security_commands  (like public.security_commands)  + archive_id
zeus_archive_security_events    (like public.security_events)    + archive_id
zeus_archive_security_audit_log (like public.security_audit_log) + archive_id
... una tabla espejo por cada tabla de §2.1 (CERBERO y ZEUS)
```

`like` sin `including all` (sin PK/FK/índices ajenos) y con `archive_id` como
única clave: el archivo es un registro inmutable, no una réplica operativa.

Orden de operaciones (una sola transacción):

1. `insert into zeus_group_archive_manifest …` (con `counts` calculados antes).
2. `insert into zeus_archive_* select … where group_id = …` para cada tabla,
   **empezando por `security_audit_log`** (el único que el `CASCADE` no borra y
   el único cuyo vínculo se pierde por `SET NULL`).
3. `delete` explícito de las tablas de ZEUS sin FK (§2.1); si no, quedan
   huérfanas y el archivo sería incompleto.
4. `delete from public.groups where chat_id = …` — aquí actúan los `CASCADE` de
   CERBERO. **No** se borran a mano las tablas de CERBERO: hacerlo crearía un
   segundo procedimiento que hay que mantener en paralelo a los FK.
5. No se escribe ningún estado final en `zeus_group_lifecycle`: la fila cae por el
   `cascade` del paso 4. La prueba de que el grupo fue archivado es el
   **manifiesto** (`exists(select 1 from zeus_group_archive_manifest where
   chat_id = …)`), no una columna de estado. Por eso §2.6 usa
   `archive_requested_at` (una marca de petición) y no un `archive_state` que
   moriría con la fila.

Carrera de archivado. Entre la copia (pasos 2-3) y el borrado (paso 4) puede
aparecer una escritura concurrente:

- Sobre tablas **con FK a `groups`** (p. ej. `security_commands`), el `INSERT`
  hijo toma `KEY SHARE` sobre el padre, de modo que el `for update` sobre
  `groups` en el paso 0 lo bloquea. La fase 1 (rechazo al encolar un grupo con
  `deleted_at`) es una defensa adicional, no una garantía.
- Sobre tablas **sin FK a `groups`** (§2.1: `security_user_activity`, `verified_*`,
  `afrodita_*`), el `for update` sobre `groups` **no** bloquea nada: una
  escritura concurrente entre copia y borrado quedaría fuera del manifiesto o se
  borraría sin copia.

`FOR UPDATE` sobre `groups` **no es suficiente** para las tablas huérfanas.
Alternativas a evaluar (todas sin implementar, a decidir antes de autorizar la
fase 2):

1. Estado de archivado visible (`archive_requested_at`) que todo escritor de
   tablas huérfanas consulte de forma obligatoria.
2. Bloqueo explícito de escrituras (p. ej. `LOCK TABLE … IN EXCLUSIVE MODE`)
   durante la transacción de archivo.
3. `zeus_group_lifecycle` consultado obligatoriamente por cada escritor (sin
   caché) antes de escribir.
4. Snapshot consistente (p. ej. `REPEATABLE READ` + verificación de un contador o
   de `counts` antes del `DELETE`).
5. Archivado transaccional cuando sea viable, con verificación por conteo
   (`counts` del manifiesto == filas copiadas; caso G8).

La solución elegida debe garantizar que **ninguna** escritura concurrente quede
fuera del manifiesto. Queda como condición para autorizar la fase 2 (§6.2 y §8).

### 2.9 Alternativas, con los datos nuevos

| Opción | Qué implica | Ventajas | Costes y riesgos |
| --- | --- | --- | --- |
| **A.** Mantener `CASCADE` y declararlo | Documentar que borrar un grupo destruye evidencia; prohibirlo salvo incidente | Coste 0, sin migración | No cierra el hueco de §2.4; irreversible; el operador no ve qué pierde; depende de disciplina (el `DELETE` físico sigue destruyendo 9 tablas) |
| **B.** `ON DELETE RESTRICT` en las 9 FK | El borrado falla mientras haya evidencia | Candado duro inmediato | Requiere migración en **CERBERO** (9 `ALTER TABLE`), fuera de ZEUS; sin TTL, el grupo no se puede borrar nunca; obliga a un procedimiento de dos pasos igualmente |
| **C.** Baja lógica + archivo en dos fases | Fase 1 sin DDL de CERBERO; fase 2 con copia + manifiesto | Conserva evidencia, permite purga política, no toca CERBERO, separable en el tiempo | Tablas nuevas + RLS/`revoke`/`grant` + RPC + pruebas; hay que decidir la ventana de gracia y el tamaño del archivo |
| **D.** (nueva) Tabla de archivo única `jsonb` | Un solo `zeus_group_archive(snapshot jsonb)` | Menos tablas | Sin consultas por columna, sin índices útiles, sin validación de forma; malo para evidencia |

**Recomendación: C en dos fases**, con la fase 1 exactamente como §2.6 (tabla de
ciclo de vida + `upsert` corregido + rechazo tipado) y la fase 2 como §2.8. B sólo
si se quiere candado inmediato y CERBERO acepta el coste; A deja sin cerrar el
borrado físico destructivo descrito en §2.4.

### 2.10 Riesgos específicos de P2-2

Se consolidan en la matriz de §4 (R-01 … R-08).

---

## 3. P2-3 — Colisiones de `operation_key` y procedencia del reintento

### 3.1 Flujo actual, paso a paso

Todo ocurre en `supabase/migrations/021_zeus_security_command_requeue.sql`
(función `zeus_requeue_security_command`, firma en `:165-186`, retorno
`(outcome, original_command_id, retry_command_id, …)`).

| # | Paso | Líneas | Nota |
| --- | --- | --- | --- |
| 1 | Validación de parámetros | 225-251 | `p_actor_id > 0`, motivo obligatorio, sufijo no vacío |
| 2 | Recorte de política | 253-275 | sólo endurece; techos en constantes |
| 3 | Bloqueo de la original | 279-283 | `select … for update`; serializa contra claim/renovación/cierre |
| 4 | Compuertas de estado | 287-323 | `not_processing`, `not_stale`, `execution_may_have_started`, `unsupported_result_state` |
| 5 | Intentos, acción, ventana de mute | 315-347 | `attempts_exhausted`, `not_retryable`, `temporal_window_expired` |
| 6 | Clave y profundidad | 349-366 | `v_retry_key := v_base_key || v_suffix`; profundidad por conteo de sufijos |
| 7 | **Pre-check del reintento** | 368-380 | `select … for update` por `(group_id, action, operation_key = v_retry_key)` → `already_retried` |
| 8 | Elegibilidad del grupo | 383-398 | `group_not_eligible` |
| 9 | Confirmación humana | 406-409 | `confirmation_required` |
| 10 | **Neutralización** | 411-437 | `result_state='unknown'`, limpia `processing_*`, `lease_expires_at` |
| 11 | **Inserción del reintento** | 439-461 | copia `payload` tal cual, `status='pending'`, `result_state='queued'` |
| 12 | `unique_violation` | 462-493 | clasifica por `constraint_name`; exige ganador; si no, `raise` |
| 13 | Salvaguarda de id | 496-499 | sin id → `raise` |
| 14 | Auditoría obligatoria | 501-523 | `security_events`, **sin** `command_id` |
| 15 | Espejo best-effort | 525-571 | `security_audit_log` con `command_id`/`group_id`; degrada a warning |
| 16 | Retorno | 577-588 | `coalesce(v_outcome, 'concurrent_change')` |

Dos detalles que importan y no están en `MIGRATIONS.md` §7.2:

- El pre-check del paso 7 toma `for update` sobre una fila que **no** es la
  original. Si esa fila la está reclamando CERBERO, el reencolado espera por un
  lock ajeno para, en el mejor caso, responder `already_retried`.
- La auditoría del paso 14 **no** rellena `security_events.command_id`, así que
  no protege al reintento de la purga: `zeus_purge_security_commands` protege
  por `command_id` en `security_events`/`security_audit_log`/`security_warnings`
  (020:334-351). El único vínculo que protege al reintento es el **espejo** del
  paso 15, que es best-effort (§7.3, D4). Si el espejo falla, el reintento es
  purgable en cuanto cumpla su retención.

### 3.2 Corrección de la premisa documentada

`supabase/MIGRATIONS.md:319-343` afirma que otro proceso puede sembrar una fila
con `operation_key = 'K#retry'` usando `enqueueSecurityCommand({ idempotencyKey })`
y que su texto «coincide con la convención del sufijo». **Eso no es posible:**

```ts
// src/services/security-commands.ts:161-172
const normalized = canonicalizeValue({
  idempotencyKey: input.idempotencyKey,
  groupId: input.groupId,
  action: input.action,
  targetUserId: input.targetUserId ?? null,
  targetMessageId: input.targetMessageId ?? null,
  payload,
});
return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
```

`operation_key` es un SHA-256 hexadecimal de 64 caracteres: no contiene `#` y
ninguna entrada de `idempotencyKey` cambia eso. Por tanto:

- el vector «clave de usuario que imita el sufijo» **no existe** en el camino
  normal;
- antes de CERBERO 009 la columna `operation_key` no existía: las filas antiguas
  quedan con `operation_key = NULL`, no con un texto no-hash colisionable;
- la colisión sólo puede producirla (a) la propia RPC o (b) una escritura que no
  pase por `buildSecurityCommandOperationKey` (SQL manual, fixture, script de
  operador) o cualquier otro mecanismo que introduzca un valor no conforme.

La conclusión de diseño no cambia (la RPC no debe fiarse de la forma de la
clave), pero **la justificación sí**: no es una carrera rutinaria, es una
defensa contra datos no conformes. Escribir la prueba como si el vector fuera
alcanzable produciría un test verde que no prueba el riesgo real.

### 3.3 Qué es alcanzable de verdad

| # | Vector | ¿Alcanzable? | Por qué | Consecuencia hoy |
| --- | --- | --- | --- | --- |
| V1 | Dos reencolados concurrentes de la **misma** original | Sí | `for update` en 021:279 los serializa | El segundo ve el reintento del primero → `already_retried` correcto |
| V2 | Reencolado concurrente de **dos originales distintas** | Sí | claves distintas ⇒ claves de reintento distintas | Sin colisión; ambos `requeued` |
| V3 | Fila no conforme con `operation_key = <hash>#retry` (SQL manual, fixture, script) | Sí | nada valida la forma de la columna | Pre-check → `already_retried` con id ajeno; si el choque ocurre tras el pre-check, **original neutralizada y reintento inexistente** |
| V4 | Fila antigua anterior a CERBERO 009 | **No** colisiona | 009 añadió `operation_key` con `add column … nullable`; las filas previas quedan con `operation_key = NULL`, no con un texto que pueda acabar en `#retry` | Sin vector de colisión por clave histórica |
| V5 | Carrera real entre el pre-check y el `insert` con datos conformes | **No** | el único escritor de `<K>#retry` es esta RPC, y la original está bloqueada | — |
| V6 | Colisión SHA-256 entre dos encolados distintos | No (2⁻¹²⁸) | — | — |
| V7 | Cliente repite la comprobación sin procedencia tras `23505` | Sí | `security-commands.ts:1483-1496` busca sólo `(group, action, key)` | Reporta `already_retried` con un id ajeno: afirma un reintento que quizá no existe |
| V8 | Reintento **terminal** ya existente | Sí, y es el caso frecuente | el pre-check no mira `status` | `already_retried` permanente: el original queda neutralizado o neutralizable, pero **no hay forma de reintentarlo otra vez** |
| V9 | Reintento purgado por retención | Sí | 020:327-358 lo permite si no está referenciado | El bloqueo de V8 desaparece **en silencio**; el siguiente reencolado crea otra fila con la misma clave |

**H-R1 (hallazgo nuevo, el más operativo):** V8 es un callejón sin salida. Si el
reintento de A se completó, falló o quedó `unknown`, `already_retried` sigue
devolviendo su id indefinidamente. El operador no puede distinguir «ya está en
marcha» de «ya se intentó y no funcionó». La única salida actual es reencolar
**el reintento** (cadena de profundidad), que exige que ese reintento esté
`processing` y stale: si está `completed`/`failed`, la política lo rechaza con
`not_processing` (recovery:363-365). Resultado: la intención original queda
irrecuperable por la vía auditada.

### 3.4 Alternativas P-1 / P-2 / P-3, evaluadas

| | P-1 (invertir orden + procedencia) | P-2 (mínima: sólo procedencia) | P-3 (espacio de nombres propio) |
| --- | --- | --- | --- |
| Qué cambia | `insert` antes de neutralizar; `payload.requeuedFrom`; nuevo outcome | Sólo añade comprobación de procedencia en 021:369 y 021:477 | Clave `zeus:retry:<uuid>` en vez de `<hash>#retry` |
| ¿Elimina «neutralizada sin reintento»? | Sí, por construcción | Sí en el pre-check, **no** si el choque ocurre después (el `insert` sigue siendo el último paso y el `raise` revierte todo, así que en la práctica también) | Sí |
| ¿Identifica al ganador? | Sí (`payload`) | Sí (`payload`) | Sí (la clave contiene el uuid) |
| Coste en 021 | Medio: reordena 408-491 y añade un `begin/exception` con savepoint | Bajo: dos comparaciones | Medio-alto: rompe paridad con `SECURITY_COMMAND_RETRY_SUFFIX` (recovery:23), `countRetryDepth` (recovery:222) y las claves de los fixtures |
| Compatibilidad con filas existentes | Las de antes de P-1 no tienen `requeuedFrom` | Ídem | Las existentes siguen con `#retry`; conviven dos formatos |
| Rotura de contrato TS | Nueva razón en el conjunto cerrado | Ídem | Ídem + cambio de formato |
| Veredicto | **Recomendada** | Aceptable si se quiere el mínimo cambio | No ahora: paga migración de datos y paridad sin resolver nada que P-1 no resuelva |

**Recomendación: P-1**, con un matiz de compatibilidad (§3.6) y dejando H-R1
explícitamente fuera de alcance (es un cambio de semántica de producto, no de
atomicidad).

### 3.5 P-1 en detalle (propuesta, sin implementar)

Cambios dentro de `zeus_requeue_security_command`:

1. **Eliminar el pre-check bloqueante** (021:368-380). Se sustituye por una
   lectura **sin** `for update` (o por nada: el `insert` ya es la comprobación).
   Elimina el lock sobre filas ajenas.
2. **Insertar el reintento primero**, con procedencia explícita:

   ```
   -- BORRADOR de diseño (no es una migración; no aplicar)
   insert into public.security_commands (group_id, action, target_user_id,
                                         target_message_id, payload, status,
                                         operation_key, result_state)
   values (v_row.group_id, v_row.action, v_row.target_user_id,
           v_row.target_message_id,
           coalesce(v_row.payload, '{}'::jsonb)
             || jsonb_build_object('requeuedFrom', v_row.id,
                                   'requeuedAt', now(),
                                   'requeueDepth', v_depth + 1),
           'pending', v_retry_key, 'queued')
   returning id into v_retry_id;
   ```

   `payload` es `jsonb` y el ejecutor de CERBERO sólo lee claves concretas por
   acción (`CERBERO/Cerbero-Security-Bot/src/moderation/executor.ts:44,63,71-79`,
   `:109-110`, `:156-159`), así que una clave extra `requeuedFrom` es inerte para
   la ejecución. **No** se añaden columnas a `security_commands`: es tabla de
   CERBERO y 021 declara explícitamente que no la altera (021:33).

3. **Envolver inserción + neutralización en un bloque con savepoint** para poder
   distinguir «colisión del índice» de «cambio concurrente» sin abortar la
   función entera:

   ```
   -- BORRADOR de diseño (no es una migración; no aplicar)
   begin
     insert … returning id into v_retry_id;          -- paso 2
     update public.security_commands                  -- neutralización
        set result_state = 'unknown', …
      where id = v_row.id
        and status = 'processing'
        and result_state = v_row.result_state;
     get diagnostics v_updated = row_count;
     if v_updated <> 1 then
       raise exception using errcode = 'Z0001';       -- revierte el savepoint
     end if;
   exception
     when unique_violation then
       get stacked diagnostics v_constraint_name = constraint_name;
       -- clasificar: índice de idempotencia + procedencia
     when sqlstate 'Z0001' then
       v_outcome := 'concurrent_change';
   end;
   ```

   Con el `update` dentro del mismo bloque, un `concurrent_change` **también**
   revierte la inserción: nunca queda un reintento huérfano.

4. **Clasificación de la colisión** (reemplaza 021:462-493):

   | Condición | Resultado |
   | --- | --- |
   | `constraint_name IS DISTINCT FROM 'security_commands_operation_key_idx'` | `raise` (transacción completa; nunca se afirma un reintento) |
   | Índice correcto **y** ganador con `payload->>'requeuedFrom' = v_row.id::text` | `already_retried` con el id del ganador |
   | Índice correcto **y** ganador con procedencia probada por auditoría (§3.7) | `already_retried` |
   | Índice correcto **y** ganador sin procedencia verificable o con otra procedencia | **`retry_key_conflict`**, `detail = <id del ganador>`, `requiresHumanReview = true`. La original **no** se neutraliza (el savepoint ya revirtió el `update`) |

**Nota sobre `NULL`:** `constraint_name <> 'idx'` no basta. En SQL, `NULL <> 'idx'`
evalúa a `NULL` (no a `true`), de modo que un `constraint_name` nulo quedaría
**fuera** de la rama «otra restricción» y se clasificaría como si el índice fuera
el correcto. Por eso la condición usa `IS DISTINCT FROM`, que trata `NULL` como un
valor y sólo devuelve `false` cuando ambos lados son el **mismo** nombre; con ello,
un `constraint_name` nulo cae en `raise` (fail-closed) y **nunca** en
`already_retried`. Se mantiene, además, la exigencia de verificar la **existencia**
del ganador antes de admitir `already_retried`.

5. **Auditoría del conflicto**: escribir en `security_events` un evento
   `security_command_requeue_conflict` con `details = { originalCommandId,
   conflictingCommandId, retryOperationKey }`, para que el operador pueda
   resolverlo sin SQL adivinado. Debe ser **obligatorio** (misma transacción),
   igual que el de éxito (021:501-523).

6. **Auditoría de éxito**: añadir `retryProvenance` y `retryDepth` a `details`,
   y **rellenar `security_events.command_id = v_retry_id`** — así el reintento
   queda protegido de la purga por el mismo mecanismo E2 que ya usa
   `zeus_purge_security_commands` (020:342-351). Es la corrección del agujero
   descrito en §3.1.

7. **Formato canónico de `requeuedFrom` (R-17).** La comparación
   `payload->>'requeuedFrom' = v_row.id::text` depende del formato de
   serialización del UUID. Alternativas a evaluar: (a) normalizar a UUID canónico
   (minúsculas) al escribir `payload.requeuedFrom`; (b) comparar convirtiendo a
   tipo `uuid` en SQL (`(payload->>'requeuedFrom')::uuid = v_row.id`); (c)
   validar estrictamente antes de comparar. La solución debe evitar comparaciones
   ambiguas y manejar un valor malformado de forma segura: un `requeuedFrom` no
   UUID no debe «raise» en medio de la clasificación ni confundirse con el
   original.

8. **Auditoría del camino `concurrent_change` (R-15).** La neutralización que no
   afecta 1 fila (o el `raise` por otra restricción) revierte el intento. Debe
   documentarse qué información conservar para reconstruir por qué **no** se creó
   el reintento: `originalCommandId`, `retryOperationKey`, motivo y actor. Esto
   no modifica la atomicidad del intento; es un requisito de trazabilidad que la
   RPC debe satisfacer (o declarar explícitamente que no lo hace).

### 3.6 Diagrama de secuencia (antes / después)

```
HOY  (neutraliza → inserta)
  lock original ──► pre-check (lock ajeno) ──► NEUTRALIZA ──► INSERT
                                                   │             │
                                    si INSERT choca └──► original queda
                                                         unknown SIN reintento
                                                         (o con un ganador ajeno)

P-1  (inserta → neutraliza)
  lock original ──► INSERT (payload.requeuedFrom) ──► NEUTRALIZA ──► auditoría
                        │                                  │
          si choca ─────┘                                  └── si no actualiza 1 fila:
          · mismo origen → already_retried                     el savepoint revierte el INSERT
          · otro origen  → retry_key_conflict
          · otra restricción → raise (rollback total)
  En ningún camino existe «neutralizada sin reintento».
```

### 3.7 Contrato que cambia (TS + SQL)

| Elemento | Hoy | Con P-1 |
| --- | --- | --- |
| `outcome` nuevos | — | `retry_key_conflict` |
| `SecurityCommandRequeueRefusalReason` (`recovery:78-98`) | conjunto cerrado sin el nuevo valor | añadir `retry_key_conflict` |
| `REQUEUE_REFUSAL_REASONS` (`recovery:107-128`) | ídem | añadir el valor (si no, la RPC devolvería `unexpected_rpc_outcome`) |
| `requiresHumanReview` (`security-commands.ts:1555-1560`) | lista de 5 outcomes | añadir `retry_key_conflict` |
| Fallback `23505` del cliente (`security-commands.ts:1483-1496`) | acepta cualquier fila con la clave | comprobar `payload->>requeuedFrom`; si no coincide → `retry_key_conflict` |

**Sincronización obligatoria (R-18).** Todo outcome nuevo debe incorporarse a la
vez en tres puntos, o degrada a `unexpected_rpc_outcome` y pierde su severidad:
(1) el conjunto cerrado `REQUEUE_REFUSAL_REASONS` (`security-command-recovery.ts:107-128`),
(2) la lista `requiresHumanReview` (`security-commands.ts:1555-1560`) y (3) la
clasificación SQL de la RPC.

**Regla de compatibilidad (necesaria):** tras aplicar P-1, las filas creadas
antes **no** tienen `requeuedFrom`. Para no convertir un `already_retried`
legítimo en un conflicto, el camino de colisión puede aceptar como prueba una
fila de `security_events` con `event_type = 'security_command_requeued'`,
`details->>'originalCommandId' = v_row.id` y `details->>'retryCommandId'`
= ganador. Coste: una consulta extra **sólo** en el camino de colisión. Límite:
`security_events` se retiene 90 días (020:504), así que un reintento más antiguo
cae en `retry_key_conflict`; es un resultado seguro (exige revisión humana), no
una pérdida de datos. Es un límite deliberado: un reintento histórico **legítimo**
(hecho antes de P-1) cuya auditoría ya expiró aparecerá como
`retry_key_conflict`. Esos casos deben resolverse con revisión humana y **no**
deben resolverse automáticamente (R-16).

### 3.8 H-R1 fuera de alcance (pero debe quedar escrito)

Arreglar V8 exige una decisión de producto (¿se permite un segundo reintento con
una clave nueva?), un cambio de esquema o de convención de claves, y redefinir
qué significa `already_retried`. No forma parte de P-1 y no se implementa aquí.
Se documenta en `MIGRATIONS.md` §7.3 como hallazgo abierto con su análisis, para
que nadie lo confunda con una regresión de P-1.

---

## 4. Matriz de riesgos

Probabilidad (P) e impacto (I): A=alto, M=medio, B=bajo. «Hoy» = riesgo vigente
sin cambios; «propuesto» = riesgo introducido o residual tras la opción
recomendada.

| ID | Decisión | Riesgo | P | I | Cómo se detecta | Mitigación |
| --- | --- | --- | --- | --- | --- | --- |
| R-01 | P2-2 | La baja lógica se revierte en el siguiente encolado (`upsert … active: true`, `security-commands.ts:255-258`) | A | M | comparar `groups.active` antes/después de una orden | corregir el `upsert` (§2.6.2); prueba que encola tras la baja y verifica que sigue inactivo |
| R-02 | P2-2 | `DELETE` manual de `groups` destruye 9 tablas de evidencia | M | A | recuento previo por tabla; auditoría del espejo queda sin grupo | fase 2 con manifiesto; runbook; consulta de control periódica |
| R-03 | P2-2 | Archivar con órdenes `pending`/`processing` rompe el fence de CERBERO | B | A | precondición de la RPC | la RPC **aborta**; nunca «archiva lo que pueda» |
| R-04 | P2-2 | Tras el borrado quedan huérfanos en tablas de ZEUS sin FK | A | B-M | consulta de huérfanos por `chat_id`/`group_id` | borrado explícito en fase 2 + inventario en el manifiesto |
| R-05 | P2-2 | Archivo incompleto o vínculo perdido por `SET NULL` en `security_audit_log` | M | A | `counts` del manifiesto vs filas archivadas | copiar `security_audit_log` primero; verificación post-transacción |
| R-06 | P2-2 | `chat_id` reutilizado por un grupo nuevo mezcla historias | B | M | búsqueda en el manifiesto al registrar el grupo | el manifiesto marca `archived_at`; el grupo nuevo no hereda nada |
| R-07 | P2-2 | Tablas nuevas sin `revoke/grant`/RLS (patrón ya usado en 020/021) | M | A | `tests/migrations-permissions.test.ts` | replicar el patrón `revoke all … from public, anon, authenticated` + `grant … to service_role` |
| R-08 | P2-2 | Crecimiento del archivo sin política | M | B | tamaño por tabla | retención propia del archivo, documentada en `RETENTION_POLICY.md` |
| R-09 | P2-3 | Original neutralizada sin reintento cuando el ganador no es de la misma intención | B (hoy) / A (con datos no conformes) | A | `already_retried` con id cuyo `payload` no casa | P-1: insertar antes de neutralizar |
| R-10 | P2-3 | El cliente afirma `already_retried` sin procedencia tras `23505` | M | M | comparación manual del `payload` del ganador | comprobar procedencia en `security-commands.ts:1483-1496` |
| R-11 | P2-3 | El cambio de orden deja una ventana en la que CERBERO reclama el reintento antes de neutralizar la original | B | A | dos ejecuciones de la misma intención en Telegram | **no ocurre** en la RPC: la fila no es visible antes del `commit` (MVCC). Los tests 1041/1095 prueban `claim` frente a `requeue` en el contrato actual, no la seguridad del nuevo orden; hace falta una prueba que ejercite la inversión directamente |
| R-12 | P2-3 | Un `retry_key_conflict` no reconocido por una versión antigua del bot degrada a `unexpected_rpc_outcome` | M | B | log `outcome no reconocido` | desplegar RPC y cliente en el mismo cambio; el conjunto cerrado ya falla en cerrado |
| R-13 | P2-3 | H-R1: reintento terminal bloquea la original para siempre | A | M | operador recibe `already_retried` de una orden `completed` | documentado; requiere decisión de producto (§3.8) |
| R-14 | Ambas | Divergencia TS/SQL en el nuevo outcome | M | A | `retry_key_conflict` emitido por SQL no reconocido por el cliente | `retry_key_conflict` no pertenece a la matriz D de políticas puras (es un outcome de colisión, como `already_retried`/`group_not_eligible`); se cubre con pruebas de contrato propias (§5.1 T12) |
| R-15 | P2-3 | El camino `concurrent_change` (o el `raise` por otra restricción) no deja rastro de auditoría | M | M | sin evento en `security_events` tras un reintento no creado | documentar la trazabilidad a conservar (§3.5.8); no altera la atomicidad |
| R-16 | P2-3 | `security_events` retiene 90 días; un reintento histórico legítimo sin auditoría se presenta como `retry_key_conflict` | M | M | conflicto de procedencia en datos antiguos | revisión humana explícita; nunca resolución automática (§3.7) |
| R-17 | P2-3 | Comparar `payload->>'requeuedFrom'` contra `id::text` depende del formato del UUID | M | M | UUID con mayúsculas o malformado | formato canónico normalizado o `::uuid`; rechazo seguro de malformados (§3.5.7) |
| R-18 | Ambas | `requiresHumanReview` diverge entre SQL y TypeScript | M | A | outcome nuevo añadido en un lado y no en el otro | inventario único de ubicaciones de `requiresHumanReview` (§3.7); todo outcome nuevo se incorpora a SQL y TS a la vez |

Riesgos **no** cubiertos por este informe: ausencia de bloqueo distribuido en
`tests/.artifacts/bindings-journal.json`, vacuidad parcial del preflight y
ausencia de interfaz de revisión (P2-4). Siguen en `MIGRATIONS.md` §7.3.

---

## 5. Casos de prueba y resultado esperado

Ninguno está implementado. Los cuatro primeros son los exigidos por la fase; los
demás cubren huecos detectados en §3.3 y en §2.

Leyenda de ubicación: **U** = unitaria con cliente Supabase simulado
(`tests/security-command-requeue.test.ts`); **I** = inspección estática (lee SQL
o documentación, sin ejecutar PostgreSQL); **B** = integración contra PostgreSQL
real (`tests/security-command-requeue-postgres.test.ts`); **C** = concurrencia
real (dos conexiones simultáneas en PostgreSQL); **F** = fixture nueva en
`tests/fixtures/`. Ninguna entrada de esta tabla está implementada ni ejecutada;
`B`/`C` exigen un proyecto PostgreSQL desechable.

### 5.1 P2-3

| # | Escenario | Montaje | Hoy | Con P-1 | Ubic. |
| --- | --- | --- | --- | --- | --- |
| T1 | Dos órdenes distintas con la misma `operation_key` | (a) misma `(group, action)`: **imposible** por el índice único (021 preflight lo exige; CERBERO 009:51-53). (b) forma real: sembrar por SQL una fila con `operation_key = <K>#retry` y `payload` sin `requeuedFrom`, después reencolar A (`operation_key = K`) | `already_retried` con el id de la fila sembrada; si el choque ocurre en el `insert`, A queda `unknown` y sin reintento | `retry_key_conflict` con `detail = <id sembrado>`; A **intacta** (mismo `result_state`, lease y token); ninguna fila nueva | B + F |
| T2 | Dos reintentos concurrentes de la misma orden | Dos conexiones; llamada A y B simultáneas a la RPC sobre la misma orden stale | 1 `requeued` + 1 `already_retried` con el id real (el `for update` de 021:279 serializa) | idéntico, con la diferencia de que la prueba pasa a demostrar la procedencia: el ganador tiene `payload.requeuedFrom = A` | B (dos conexiones) |
| T3 | Colisión con una orden de **otro** grupo | Sembrar una fila con la misma `operation_key` pero `group_id` distinto; reencolar A | Sin colisión: el índice incluye `group_id` (CERBERO 009:51-53) → `requeued` normal | idéntico; la prueba protege que nadie «arregle» el índice quitando `group_id` | B + F |
| T4 | Reintento cuyo ganador no corresponde a la orden original | Sembrar `<K>#retry` con `payload.requeuedFrom = <uuid de otra orden>`; reencolar A | `already_retried` con el id ajeno | `retry_key_conflict`, A intacta, evento `security_command_requeue_conflict` | B + F |
| T5 | Reintento legítimo ya existente (misma original) | Reencolar A dos veces seguidas | `already_retried` con el id del reintento | idéntico (`payload.requeuedFrom` casa) — **no** debe convertirse en conflicto | U + B |
| T6 | Reintento anterior a P-1 (sin `requeuedFrom`, con auditoría) | Fila `<K>#retry` + `security_events` de reencolado apuntando a A | `already_retried` | `already_retried` por la regla de compatibilidad (§3.7) | B + F |
| T7 | Reintento anterior a P-1 **sin** rastro de auditoría | Igual que T6 sin el evento | `already_retried` | `retry_key_conflict` (fail-safe, revisión humana) | B + F |
| T8 | Auditoría obligatoria falla tras insertar | Fixture `security-command-requeue-audit-failure.sql` ya existente | rollback completo | rollback completo: **ni** reintento **ni** neutralización (la inversión no debe cambiar esto) | B (test 842) |
| T9 | Espejo `security_audit_log` falla | `D4` degradado a warning | reintento + `security_events` sobreviven | idéntico, y el reintento queda protegido por `security_events.command_id` (§3.5.6) | B (test 876) |
| T10 | Reintento terminal existente | Reintento en `completed`; reencolar A | `already_retried` para siempre (V8) | idéntico: **H-R1 no se corrige**; la prueba documenta el límite | B |
| T11 | `concurrent_change` no deja reintento huérfano | Forzar que la neutralización no afecte 1 fila (trigger de prueba) | `concurrent_change`, sin insert | `concurrent_change` y el savepoint revierte el insert | B |
| T12 | Contrato de outcomes para `retry_key_conflict` | `retry_key_conflict` **no** pertenece a la matriz D de políticas puras (es un outcome de colisión, como `already_retried`/`group_not_eligible`) | no existe | contrato en 5 partes: (1) SQL puede emitirlo; (2) TS lo reconoce; (3) figura en `REQUEUE_REFUSAL_REASONS`; (4) activa `requiresHumanReview`; (5) pruebas de contrato propias | U + B (no matriz D) |
| T13 | Fallback `23505` del cliente con ganador de procedencia **ajena** | cliente recibe `23505`; el lookup devuelve un ganador cuyo `payload.requeuedFrom` no casa con la original | `already_retried` sin procedencia | `retry_key_conflict` con revisión humana | U + B |
| T14 | `requeuedFrom` malformado | ganador con `payload.requeuedFrom` no UUID (p. ej. texto libre) | `already_retried` | `retry_key_conflict` o rechazo seguro, sin `raise` durante la clasificación | U + B |

### 5.2 P2-2

| # | Escenario | Montaje | Esperado |
| --- | --- | --- | --- |
| G1 | Baja lógica y encolado posterior | Grupo con `deleted_at`; `enqueueSecurityCommand` | rechazo tipado `group_archived`; `groups.active` sigue `false` (no resurrección) → cubre R-01 |
| G2 | Pausa reversible | `active = false` sin `deleted_at`; encolar; reactivar | rechazo `group_disabled`; tras reactivar, encolado normal |
| G3 | Claim bloqueado | `active = false` con una orden `pending` preexistente | `claim_security_command` no la devuelve (CERBERO 011:68) |
| G4 | Reencolado bloqueado | `active = false` | `group_not_eligible` (021:383-398), sin escrituras |
| G5 | Fase 2 con `pending` | `deleted_at` antiguo + 1 orden `pending` | la RPC aborta con detalle `pending_orders`; nada archivado |
| G6 | Fase 2 con `processing` | ídem con lease vivo | aborta con `processing_orders`; nada archivado |
| G7 | Fase 2 completa | ídem sin `pending`/`processing`, con eventos, advertencias, espejo y tablas de ZEUS | manifiesto con `counts` == filas copiadas; 0 huérfanos; `security_audit_log` copiado **antes** del `DELETE` |
| G8 | Conteo de evidencia | Comparar `counts` del manifiesto con el archivo | igualdad exacta; si no, `raise` y rollback |
| G9 | Permisos | `tests/migrations-permissions.test.ts` | tablas nuevas con RLS, `revoke all` a `public/anon/authenticated`, `grant` a `service_role` |
| G10 | Documentación | `RETENTION_POLICY.md` §3 y `MIGRATIONS.md` §7 | la política describe el `DELETE` físico como acción destructiva (no como principio «sin CASCADE»); el documento de decisiones y la política deben describir el mismo comportamiento |
| G11 | Escritura concurrente en tabla huérfana durante el archivado | fase 2 en curso; un escritor inserta en `security_user_activity` (sin FK a `groups`) entre copia y borrado | `counts` de esa tabla == filas copiadas; la escritura o acaba en el manifiesto, o se rechaza; nunca pérdida silenciosa | B + C |
| G12 | Baja y reactivación durante la ventana de archivado | grupo con `deleted_at`/`archive_requested_at`; intento de `zeus_reactivate_security_group` | rechazo explícito; el grupo no vuelve a activo sin transición validada | B |

T1–T4 son los cuatro casos pedidos. T1 y T3 incluyen una comprobación negativa
explícita («esto no puede ocurrir por el índice») para que la prueba no simule
un riesgo inexistente y deje el real sin cubrir. Nota sobre los tests existentes:
en `security-command-requeue-postgres.test.ts` los tests 1041 y 1095 prueban
`claim` frente a `requeue` en el contrato actual; **no** demuestran por sí solos
la seguridad del nuevo orden (invertir insertar→neutralizar). Para eso hace falta
una prueba que ejercite la inversión directamente (p. ej. T11 bajo P-1, dos
conexiones).

---

## 6. Archivos que cambiarían en una fase futura

Nada de esto se ha tocado. Se enumeran para que la aprobación sea sobre algo
concreto.

### 6.1 P2-2 fase 1 (baja lógica)

| Archivo | Cambio |
| --- | --- |
| `ZEUS/supabase/migrations/0NN_zeus_group_lifecycle.sql` (nueva) | `zeus_group_lifecycle`, RLS, `revoke`/`grant`, RPC `zeus_deactivate_security_group` y `zeus_reactivate_security_group` |
| `ZEUS/src/services/security-commands.ts` | `ensureCerberoBinding` (255-258): no sobrescribir `active`; `enqueueSecurityCommand` (268-272): rechazo tipado si el grupo está pausado/archivado |
| `ZEUS/src/services/security-commands.ts` | `getConnectedSecurityGroups` (615-630): exponer el estado de ciclo de vida, no sólo `active` |
| `ZEUS/src/types.ts` | unión de motivos de rechazo del encolado, si se tipa |
| `ZEUS/supabase/MIGRATIONS.md` | nueva sección con el contrato de la tabla y la RPC |
| `ZEUS/supabase/RETENTION_POLICY.md` | §1.2 y §5: qué se conserva de un grupo dado de baja |
| `ZEUS/RUNBOOK.md` | procedimiento de baja/reactivación y prohibición de `DELETE` |
| `ZEUS/tests/migrations-permissions.test.ts` | cubrir la migración nueva |
| `ZEUS/tests/*.test.ts` | G1–G4, G9 |

### 6.2 P2-2 fase 2 (archivo)

| Archivo | Cambio |
| --- | --- |
| `ZEUS/supabase/migrations/0NN_zeus_group_archive.sql` (nueva) | manifiesto + tablas `zeus_archive_*` + RPC `zeus_archive_security_group` con precondiciones y `for update` |
| `ZEUS/supabase/migrations/0NN_...` | (si se decide) purga propia del archivo |
| `ZEUS/supabase/RETENTION_POLICY.md` | política del archivo |
| `ZEUS/RUNBOOK.md`, `ZEUS/PRODUCTION_READINESS.md` | procedimiento y estado |
| `ZEUS/tests/*` | G5–G8, G11, G12 |

### 6.3 P2-3 (P-1)

| Archivo | Cambio |
| --- | --- |
| `ZEUS/supabase/migrations/0NN_zeus_requeue_provenance.sql` (nueva; **no** editar 021 si ya está aplicada) | `create or replace function zeus_requeue_security_command` con el orden invertido, procedencia y `retry_key_conflict` |
| `ZEUS/src/services/security-command-recovery.ts` | `SecurityCommandRequeueRefusalReason` (78-98) y `REQUEUE_REFUSAL_REASONS` (107-128) |
| `ZEUS/src/services/security-commands.ts` | `requiresHumanReview` (1555-1560) y fallback `23505` (1483-1496) |
| `ZEUS/tests/security-command-requeue.test.ts` | T5, T12, T13, T14 (unitarias / contrato de outcomes) |
| `ZEUS/tests/security-command-requeue-postgres.test.ts` | T1–T11, T13, T14 (los que exigen PostgreSQL o concurrencia) |
| `ZEUS/tests/fixtures/security-command-requeue-foreign-key.sql` (nueva) | siembra de filas no conformes para T1/T4/T7 |
| `ZEUS/tests/fixtures/security-command-requeue-audit-failure.sql` | sin cambios de sentencias; sólo el comentario que ya se corrigió |
| `ZEUS/supabase/MIGRATIONS.md` | §7.2 reescrita con P-1 aprobada y la corrección de la premisa (§3.2) |
| `ZEUS/supabase/RETENTION_POLICY.md` | §4: protección del reintento vía `security_events.command_id` |
| `ZEUS/RUNBOOK.md` | qué hacer ante `retry_key_conflict` |

**Nota sobre numeración:** la próxima migración libre es `022`. Si se aprueban
ambas decisiones en la misma fase, hacen falta al menos dos (una por decisión) y
no deben mezclarse: P2-3 es una función, P2-2 son tablas y RPC nuevas.

---

## 7. Dependencias entre decisiones

```
P2-2 fase 1 ──► P2-2 fase 2 ──► archivo debe copiar payload (incl. requeuedFrom)
      │                                   ▲
      └──► enqueue rechaza grupos         │
           pausados/archivados ───────────┘  (una orden no debe nacer en un grupo
                                             que se va a archivar)

P2-3 (P-1) ──► añade payload.requeuedFrom ──► P2-2 fase 2 lo conserva
      │
      └──► nuevo outcome ──► debe existir también en el cliente antes del deploy

Ambas ──► RETENTION_POLICY.md y MIGRATIONS.md §7 deben describir el mismo estado
```

Dependencias duras:

1. **P-1 antes de la fase 2 de P2-2.** Si se archiva primero, las filas
   archivadas no tendrán `requeuedFrom` y la regla de compatibilidad (§3.7)
   dependerá de `security_events`, que la fase 2 mueve al archivo.
2. **La fase 1 antes que la fase 2**, sin excepción: la fase 2 exige
   `deleted_at` y `active = false`.
3. **El rechazo del encolado (P2-2 fase 1) antes del archivo**, para que no
   aparezcan órdenes nuevas entre la copia y el `DELETE`.
4. **RPC y cliente en el mismo despliegue** (R-12). El conjunto cerrado de
   motivos ya falla en cerrado, pero un `retry_key_conflict` sin tipar se
   reportaría como `unexpected_rpc_outcome` y perdería el detalle.
5. **Nada de esto depende de CERBERO** salvo la opción B de §2.9, que queda
   descartada por eso mismo.
6. **La fase 2 exige cerrar la carrera de tablas huérfanas** (§2.8): ninguna
   escritura concurrente debe quedar fuera del manifiesto.
7. **P2-3 es independiente de P2-2.** P2-2 fase 1 precede a fase 2; y P2-3 debe
   estar implementada antes de P2-2 fase 2 si ésta conserva la procedencia
   `requeuedFrom` de los reintentos.
8. **Autorizaciones externas:** cualquier DDL sobre tablas de CERBERO requiere a
   su propietario; AFRODITA permanece pausado hasta una autorización
   independiente. Ninguna recomendación de este documento es una decisión
   aprobada.

---

## 8. Criterios para autorizar una implementación posterior

La implementación **no** debe empezar hasta que se cumplan, por escrito:

1. **Aprobación explícita y separada** para P2-2 fase 1, P2-2 fase 2 y P2-3. No
   se acepta una aprobación conjunta que cubra «lo que haga falta».
2. **Aceptación de la corrección de §3.2**: la justificación de P2-3 cambia; si
   el revisor mantiene la premisa del hash, la prueba T1 seguiría siendo válida
   sólo como defensa ante datos no conformes.
3. **Decisión sobre `RETENTION_POLICY.md` §3**: confirmar que el borrado físico
   de un grupo se describe como acción destructiva (no como contradicción con la
   política) y que ninguna tabla nueva introduce borrado automático de evidencia.
4. **Entorno**: sólo un proyecto desechable, verificado por el preflight
   existente. Nada de producción. Sin credenciales en el repositorio.
5. **Alcance de archivos cerrado**: exactamente los de §6, sin cambios en
   `020`, `021` (se sustituye la función con una migración nueva), CERBERO o
   AFRODITA.
6. **Matriz de pruebas verde**: T1–T14 y G1–G12 donde aplique, más las 46
   unitarias y los 20 casos del suite PostgreSQL actuales sin regresión.
7. **Rollback escrito**: para P2-3, `create or replace` de la versión anterior
   de la función; para P2-2, `drop` de tablas/RPC nuevas (nunca `drop` de las de
   CERBERO).
8. **Ninguna decisión se implementa «de paso»**: H-R1, P2-1, P2-4, P3-1…P3-8, D4
   y el bloqueo distribuido siguen fuera de alcance.

---

## 9. Anexo — referencias verificadas y estado final

### 9.1 Índice de referencias usadas

| Tema | Referencia |
| --- | --- |
| `groups` sin `deleted_at` | `CERBERO/supabase/migrations/001_initial_schema.sql:14-19` |
| FK `CASCADE` de seguridad | 001:22, 001:33, 001:56; 002:2, 002:47, 002:60; 004:3; 006:3; 012:7 |
| FK `SET NULL` | 003:2, 003:6-7; 004:8; 007:6-7 |
| `active` en la reclamación | `CERBERO/.../011_safe_command_lease_recovery.sql:68` |
| `active` en AFRODITA | `CERBERO/.../012_afrodita_verified_catalog_read.sql:42`; `013:46` |
| Resurrección del grupo | `ZEUS/src/services/security-commands.ts:255-258`, `:272` |
| `active` en el panel | `ZEUS/src/services/security-commands.ts:615-630` |
| Principios de retención | `ZEUS/supabase/RETENTION_POLICY.md:12-24` |
| Purga de órdenes | `ZEUS/supabase/migrations/020_zeus_security_retention_and_rpcs.sql:289-371` |
| Protección E2 por referencia | 020:334-351, 020:496-503 |
| Retención de eventos | 020:504 |
| RPC de reencolado | `ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql:165-600` |
| Pre-check sin procedencia | 021:368-380 |
| Neutralización | 021:411-437 |
| `unique_violation` | 021:462-493 |
| Auditoría y espejo | 021:501-523, 021:525-571 |
| Hash de `operation_key` | `ZEUS/src/services/security-commands.ts:142-172` |
| Sufijo y profundidad | `ZEUS/src/services/security-command-recovery.ts:22-32`, `:222-234` |
| Conjunto cerrado de motivos | `recovery:78-128` |
| Clasificación `23505` en el cliente | `security-commands.ts:1471-1505` |
| `requiresHumanReview` | `security-commands.ts:1555-1560` |
| Claves de `payload` en CERBERO | `CERBERO/Cerbero-Security-Bot/src/moderation/executor.ts:44,63,71-79,109-110,156-159` |
| Suite unitaria / PostgreSQL | `tests/security-command-requeue.test.ts` (46 casos), `tests/security-command-requeue-postgres.test.ts` (20, la mayoría omitidos sin entorno) |

### 9.2 Lo que este documento **no** hace

- No implementa P2-2 ni P2-3, ni en SQL ni en TypeScript.
- No crea migraciones; los bloques marcados `BORRADOR` son bocetos de diseño
  dentro de este informe, no archivos aplicables.
- No modifica `020`, `021`, fixtures con sentencias, CERBERO ni AFRODITA.
- No ejecuta SQL, no usa la CLI de Supabase, no se conecta a PostgreSQL ni a
  ningún servicio remoto, y no lee credenciales.
- No hace `commit`, `push` ni `deploy`.
- No inicia FASE 4D-POSTGRES ni valida comportamiento dependiente de PostgreSQL.

### 9.3 Estado de Git y cambios ajenos a esta sesión

- `HEAD` = `d3658dc5a1010d6d98fd664722dd5aa7aed3b725`, rama `main`. **Ninguna
  entrada fue eliminada ni revertida** (`git status --porcelain` no tiene
  entradas `D`).
- Entradas en `git status --porcelain` al abrir la sesión: **46**. Al cerrarla:
  **48**. El delta son dos archivos nuevos, ninguno de ellos código de
  producción: este informe (`FASE4D_DECISIONS.md`) y
  `tests/cerbero-contract-guard.test.ts` (creado a las 13:17 por otro proceso que
  trabaja en FASE 4D-REVIEW-3; no pertenece a esta fase).
- Este informe también editó `supabase/MIGRATIONS.md` (§7 índice, §7.2 corrección
  de premisa, §7.3 fila H-R1). Ese archivo ya estaba sin seguimiento, así que no
  añade entrada nueva.
- **Cambio ajeno detectado durante la sesión:** a las 13:16 otro proceso editó
  `supabase/migrations/021_zeus_security_command_requeue.sql`, sólo en
  comentarios (atribución de `markCommandExecutionStarted`, `completeCommand` y
  `renewCommandLease` a helpers TypeScript de CERBERO). Eso desplazó **+3** las
  líneas desde la 17. Las referencias a 021 de este informe están tomadas del
  archivo tal como quedó a las 13:20; si vuelve a cambiar, localícelas por el
  texto citado («pre-check del reintento», `v_existing_retry`, «neutralización
  atómica») y no por el número. No se alteró ninguna sentencia ejecutable.
- Ningún archivo **con seguimiento** fue modificado por esta sesión: los `M` del
  árbol tienen fecha anterior al 18/11/2026 13:00.
- Auditoría independiente posterior (FASE 4D-DECISIONS-REVIEW): **50** entradas al
  abrir la sesión y **51** al cerrarla (durante la auditoría apareció
  `tests/automatic-message-normalization.test.ts`, ajeno a ella). Ambos recuentos
  son **fotografías históricas**: el estado actual del repositorio cambia con el
  trabajo concurrente y sólo debe leerse con `git status --short` en el momento de
  la consulta.

### 9.4 Decisión pendiente

| Decisión | Recomendación | Estado |
| --- | --- | --- |
| P2-2 | C en dos fases (§2.6, §2.8) | Pendiente de aprobación humana |
| P2-3 | P-1 con inversión de orden y procedencia (§3.5) | Pendiente de aprobación humana |
| H-R1 | Documentar y no corregir en esta fase (§3.8) | Pendiente de decisión de producto |
| `RETENTION_POLICY.md` §3 | Confirmar que el borrado físico se documenta como acción destructiva | Pendiente (revisión documental) |

Sin aprobación explícita, el estado real del sistema sigue siendo el descrito en
la columna «Hoy» de §5 y en §2.9 opción A.
