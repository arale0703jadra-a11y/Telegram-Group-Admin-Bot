# Política de retención y trazabilidad — datos de seguridad

Estado: **PREPARADA, no aplicada**. Documento de política de la Fase 4D
(hallazgos E2/E3 de la auditoría de Fase 4C).

Nada de lo aquí descrito se ejecuta automáticamente. La migración `020` sólo
crea funciones; no programa `pg_cron` ni ningún job. Toda purga es una decisión
humana, auditada, invocada con `service_role` y por lotes.

---

## 1. Principios

1. **La evidencia pesa más que el espacio.** Ante la duda, no se borra.
2. **Nada automático.** Sin cron ni triggers de borrado ejecutados por ZEUS.
   Toda purga es humana, auditada, invocada con `service_role` y por lotes.
3. **Un `NULL` no es un archivo.** `ON DELETE SET NULL` conserva la fila hija
   pero destruye el vínculo con la orden: la auditoría deja de poder responder
   «¿a qué ejecución pertenece esto?». Por eso la protección se implementa
   **excluyendo** órdenes referenciadas, no confiando en el FK.
4. **Por lotes y sin bloquear.** `p_batch_limit` acotado y `FOR UPDATE SKIP
   LOCKED` para no bloquear a CERBERO.
5. **Registro obligatorio.** Cada ejecución se anota en `zeus_maintenance_runs`
   con `zeus_log_maintenance_run(job, filas, días, detalle)`.

## 2. Órdenes: `security_commands`

| `status` | `result_state` | ¿Se purga? | Motivo |
| --- | --- | --- | --- |
| `pending` | cualquiera | **Nunca** | Intención vigente; se recupera con reconciliación/reencolado. |
| `processing` | `processing` | **Nunca** | Ejecución en curso o lease vivo. |
| `processing` | `unknown` | **Nunca** | Resultado no confirmado: evidencia (ver §4). |
| `failed` | `unknown` | **Nunca** | Igual que el anterior. |
| `completed` / `failed` / `cancelled` | `processing` | **Nunca** | Contradicción estado/resultado: revisar antes. |
| `completed` / `failed` / `cancelled` | otros | Sí, tras la retención | Estados terminales limpios. |
| cualquiera | cualquiera | **Nunca** si otra tabla la referencia | Trazabilidad (§3). |

Retenciones por defecto:

- `completed`: 365 días.
- `failed`: 90 días.
- `cancelled`: 30 días.
- Mínimo que acepta la función: 30 días (`p_older_than_days >= 30`).
- Estados permitidos por la función: sólo `completed`, `failed`, `cancelled`
  (lista cerrada; cualquier otro valor aborta la llamada).

## 3. Referencias protegidas (hallazgo E2)

La purga de órdenes **excluye** cualquier orden referenciada por:

| Tabla | Columna | FK | Migración de origen |
| --- | --- | --- | --- |
| `security_warnings` | `command_id` | `ON DELETE SET NULL` | CERBERO 004 |
| `security_events` | `command_id` | `ON DELETE SET NULL` | CERBERO 003 |
| `security_audit_log` | `command_id` | `ON DELETE SET NULL` | CERBERO 003 / 007 |

Antes de la Fase 4D sólo se comprobaba `security_warnings`. Como los tres FK son
`ON DELETE SET NULL`, borrar una orden referenciada por un evento o por una
entrada de auditoría dejaba esas filas con `command_id = NULL`: la evidencia
sobrevivía sin poder atribuirse a ninguna ejecución.

**Estrategia: preservar por referencia (archivo natural).** La orden vive
mientras viva cualquiera de sus referencias. Como la auditoría se retiene más
tiempo (365 días) que las órdenes (30–365), el efecto práctico es que una orden
con auditoría se conserva al menos tanto como su auditoría. Ese es el archivo.

### Orden de operaciones recomendado

1. Purgar `security_events` (90 días) y `security_audit_log` (365 días) según
   esta política.
2. Purgar después `security_commands`; las órdenes que ya no estén referenciadas
   podrán borrarse si superan su propia retención.

Ejecutarlo al revés no rompe la integridad (la función simplemente no borra esas
órdenes), pero retrasa la purga hasta el siguiente ciclo.

### FKs sobre `groups`: borrado físico vs. purga

La política de purga (§2 y §3) **no** cubre el borrado físico de un grupo. Las
tablas de seguridad heredan de CERBERO FKs sobre `groups` que declararon `ON
DELETE CASCADE`:

| Tabla | Columna | FK | Efecto de `DELETE FROM groups` |
| --- | --- | --- | --- |
| `group_bot_bindings` | `group_id` | `ON DELETE CASCADE` (CERBERO 001) | Borra el vínculo grupo↔bot y sus `permissions` |
| `security_commands` | `group_id` | `ON DELETE CASCADE` (CERBERO 001) | Borra la orden, aun `unknown`, `processing` o referenciada |
| `security_events` | `group_id` | `ON DELETE CASCADE` (CERBERO 001) | Borra eventos, incluida la auditoría del reencolado |
| `security_group_configs` | `group_id` | `ON DELETE CASCADE` (CERBERO 002) | Borra la configuración de seguridad |
| `security_sanctions` | `group_id` | `ON DELETE CASCADE` (CERBERO 002) | Borra sanciones |
| `security_protected_users` | `group_id` | `ON DELETE CASCADE` (CERBERO 002) | Borra la lista de protegidos |
| `security_warnings` | `group_id` | `ON DELETE CASCADE` (CERBERO 004) | Borra avisos |
| `verified_users` | `group_id` | `ON DELETE CASCADE` (CERBERO 006) | Borra la lista de verificadas |
| `afrodita_verified_catalog_groups` | `group_id` | `ON DELETE CASCADE` (CERBERO 012) | Borra el permiso de publicación del catálogo |

`security_audit_log.group_id` es en cambio `ON DELETE SET NULL` (CERBERO 003/007):
la fila sobrevive, pero pierde el vínculo con el grupo y deja de poder atribuirse.

Distinción operativa:

1. **Purga automática:** no existe. `020` sólo crea funciones; nada se ejecuta sin
   decisión humana auditada.
2. **Purga por lotes (`zeus_purge_*`):** respeta `result_state` (`unknown` nunca),
   las referencias (§3) y la retención. No activa las FKs de `groups`.
3. **Eliminación física (`DELETE FROM groups`):** dispara los `ON DELETE CASCADE`
   de arriba y **destruye evidencia sin pasar por la política de retención**. No
   hay código de ZEUS que lo ejecute hoy; es una acción manual de operador o un
   proceso futuro.

### Baja lógica propuesta (no implementada como política): `groups.active = false`

Como alternativa a la eliminación física, se propone desactivar el grupo con
`groups.active = false`. CERBERO (`claim_security_command`) y la RPC de reencolado
de ZEUS ya excluyen los grupos inactivos, de modo que la baja lógica detiene la
operación sin borrar evidencia. Queda pendiente validar y documentar este
procedimiento como política obligatoria.

**Advertencia vigente:** hoy `ensureCerberoBinding`
(`ZEUS/src/services/security-commands.ts:255-258`) ejecuta
`upsert({ chat_id, active: true })` en **cada** encolado. Una baja lógica basada
sólo en `active = false` se revierte con la siguiente acción de seguridad del
grupo; una solución completa de ciclo de vida exige corregir primero ese `upsert`
(no reescribir `active` cuando la fila ya existe). `zeus_group_lifecycle` se
describe como propuesta en `FASE4D_DECISIONS.md`; **no está implementado**.

**Tablas de ZEUS sin FK a `groups`:** a diferencia de las anteriores,
`verified_member_tag_reviews`, `verified_member_tag_audit`,
`security_user_activity`, `verified_user_manual_audit`,
`verified_user_auto_revocation_outbox` y las tablas `afrodita_*` de ZEUS **no**
declaran `references groups`, de modo que un `DELETE FROM groups` las deja
**huérfanas** (no se borran, apuntan a un grupo inexistente). Un borrado físico
controlado debe recogerlas explícitamente.

## 4. Órdenes `unknown`: política explícita (hallazgo E3)

`result_state = 'unknown'` significa *«ZEUS no puede demostrar si la acción se
ejecutó»*. Es el estado que produce:

- la reconciliación de ZEUS (`reconcileStaleSecurityCommands`), y
- la recuperación de CERBERO 011 cuando no puede probar que la ejecución no
  empezó, y
- la neutralización de la orden original durante un reencolado.

Reglas:

1. **Nunca se purga automáticamente.** `zeus_purge_security_commands` la excluye
   por partida doble: `result_state NOT IN ('processing','unknown')` y, además,
   el estado no está en la lista de `status` permitidos (sigue en `processing`).
2. **Nunca se reescribe automáticamente** a `completed`/`failed`: eso inventaría
   un resultado del que no hay prueba.
3. **Salidas admitidas, ambas humanas y auditadas:**
   - **Reintento:** `zeus_requeue_security_command` (o el panel de operador) con
     motivo obligatorio y `p_acknowledged = true`. Neutraliza la original
     (`result_state='unknown'`, `last_error` anota la sustitución) y crea
     `<operation_key>#retry` en `pending`. La original **sigue** en `unknown`
     como evidencia.
   - **Neutralización definitiva sin reintento:** no está implementada. Si se
     necesita, requiere una RPC nueva, aprobación del propietario y auditoría;
     no se hace con un `UPDATE` manual.
4. **Visibilidad:** `listStaleSecurityCommands` **no** lista órdenes `unknown`
   ya neutralizadas (sin `lease_expires_at` ni `processing_at`: la política de
   staleness las descarta). La reconciliación usa `scope: "awaiting"` para no
   gastar el lote en filas ya reconciliadas (hallazgo E1). Una vista dedicada de
   órdenes `unknown` es la recomendación **P-1** del informe de la Fase 4D:
   todavía no existe.
5. **Crecimiento:** `unknown` sólo crece con ejecuciones no confirmadas. No hay
   purga automática, así que su control es operativo: revisar la lista,
   reintentar o neutralizar, y vigilar el volumen en el panel.
6. **Purga futura:** incluso cuando la original ya no ejecute nada, seguirá
   referenciada por sus eventos/auditoría; la §3 la conserva hasta que esos
   registros expiren según §5.

## 5. Eventos y auditoría

| Tabla | Retención | Mínimo | Notas |
| --- | --- | --- | --- |
| `security_events` | 90 días | 30 | Purga global (no por grupo). |
| `security_audit_log` | 365 días | 90 | Espejo heredado; contiene `command_id`, `group_id`, `target_user_id`. |

Purgar eventos **no** rompe la integridad de las órdenes: la relación es
orden → evento, y la orden no depende de sus eventos para ser válida. Lo que sí
ocurre es que, al desaparecer las últimas referencias, la orden pasa a ser
purgable (§3).

## 6. Otras tablas (sin función de purga en `020`)

| Tabla | Retención prevista |
| --- | --- |
| `verified_member_tag_audit` | 365 días |
| `verified_user_auto_revocation_outbox` | 30 días |
| `system_owner_recovery_challenges` | 7 días |
| `zeus_maintenance_runs` | sin purga: es el propio registro de mantenimiento |

## 7. Procedimiento de ejecución (manual)

1. Verificar que `020` está aplicada y que la sesión usa `service_role`.
2. Ejecutar **una** función, **un** lote, y comprobar el número devuelto:

   ```sql
   select public.zeus_purge_security_commands(array['cancelled'], 30, 500);
   select public.zeus_log_maintenance_run(
     'purge_security_commands', 0, 30, '{"batch":500,"statuses":["cancelled"]}'::jsonb
   );
   ```

3. Repetir en ciclos hasta que el lote devuelva `0`.
4. Nunca ejecutar dos purgas de órdenes en paralelo con una migración, ni
   durante una ventana de ejecución de CERBERO.
5. Registrar hora, operador, retención y filas en el acta de mantenimiento.

## 8. Estado de aplicación

- `020` y `021`: **preparadas y no aplicadas**.
- Los cambios de la Fase 4D están sólo en las copias locales y **no se han
  ejecutado** contra ninguna base de datos.
- Dependencias externas: CERBERO 001/003/004/009/011 (tablas, `command_id`,
  índice único de idempotencia, `execution_started_at`).

