# Pruebas de ZEUS

## 1. Pruebas locales (sin base de datos)

```powershell
npm.cmd test          # node --import tsx --test tests/*.test.ts
npm.cmd run typecheck # tsc --noEmit -p tsconfig.tests.json
npm.cmd run build     # tsc
```

Para ejecutar **un solo archivo**, hay que usar el mismo cargador que el script:
`node --test` sin `--import tsx` no resuelve los `.ts`.

```powershell
node --import tsx --test tests/postgres-suite-guard.test.ts
node --import tsx --test tests/security-command-requeue-postgres.test.ts
```

Las pruebas unitarias usan mocks y no abren conexiones. La única excepción es
`security-command-requeue-postgres.test.ts`, que **se omite** salvo que el
entorno declare un proyecto PostgreSQL desechable (ver §2).

## 2. Suite PostgreSQL de reencolado (`security-command-requeue-postgres.test.ts`)

### 2.1 Qué exige para ejecutarse

| Variable | Contenido |
| --- | --- |
| `ZEUS_TEST_SUPABASE_URL` | `https://<ref>.supabase.co` del proyecto desechable |
| `ZEUS_TEST_SUPABASE_SERVICE_ROLE_KEY` | clave `service_role` **legacy (JWT)** del mismo proyecto |
| `ZEUS_TEST_SUPABASE_DISPOSABLE` | `yes` |
| `ZEUS_TEST_GROUP_ID` | `chat_id` del grupo fixture |
| `ZEUS_TEST_OPERATOR_ID` | id numérico del operador de prueba |
| `ZEUS_TEST_SCENARIO` | opcional: `default` (por defecto) o `audit-log-rename` |

Nunca se usan `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` como respaldo. Si esas
dos variables están **exportadas al entorno del proceso** que ejecuta las pruebas
y coinciden con las de prueba, la suite se bloquea (hallazgo F-05).

> La comparación se hace sobre `process.env` del proceso de pruebas
> (`tests/support/project-refs.ts:278-279` lee las ambientales y `:342-357` las
> compara). **Ningún archivo de pruebas carga `.env`**: para que esa comprobación
> actúe hay que exportar las variables en la sesión (`$env:SUPABASE_URL = ...`) o
> pasar explícitamente las de prueba. Un `.env` en disco no se lee por este
> mecanismo, y su ausencia **no** debilita el resto del preflight: la coherencia
> URL ↔ clave ↔ `ref`, la exigencia de `role=service_role` y el rechazo de
> referencias protegidas son independientes de esas variables.

Además:

- la URL debe tener el formato `https://<ref>.supabase.co` (sin ruta, query ni
  pooler) y la clave debe declarar la **misma** referencia y
  `role=service_role`;
- la referencia no puede estar en `tests/fixtures/protected-project-refs.json`;
- debe existir la tabla marcador `zeus_test_disposable_marker` con ≥ 1 fila
  (`tests/fixtures/security-command-requeue-disposable-marker.sql`);
- las migraciones indicadas en §2.2.1 aplicadas **desde su ruta exacta** (el
  número por sí solo no identifica un archivo: ver la advertencia de §2.2.1);
- el **seed mínimo** de §2.2.2 presente y vigente.

### 2.2 Estado previo obligatorio de la base de datos desechable

Antes de ejecutar la suite, el proyecto debe cumplir dos cosas que **no** aporta
el marcador: el esquema correcto y unas pocas filas de contexto.

#### 2.2.1 Migraciones: siempre repositorio + ruta, nunca sólo el número

> **Regla permanente (hallazgo D7).** En este workspace los números de migración
> se repiten entre repositorios con contenidos **incompatibles**. Al citar,
> escribir o aplicar una migración hay que indicar **repositorio y ruta
> completa**, no el número. `008` no significa lo mismo en `ZEUS` que en
> `CERBERO`.

Orden mínimo verificado para un proyecto nuevo. Todas las rutas son relativas a
`Telegram-Bots/`:

| # | Ruta exacta | Qué aporta a la suite |
| --- | --- | --- |
| 1 | `CERBERO/supabase/migrations/001_initial_schema.sql` | `pgcrypto`; `bots`, `groups`, `group_bot_bindings`, `security_commands`, `security_events`, `security_audit_log`; `claim_security_command` v1 |
| 2 | `CERBERO/supabase/migrations/002_security_policies.sql` | `security_group_configs`, `security_sanctions`, `security_protected_users`; columnas de traza en `security_events` y `security_commands` |
| 3 | `CERBERO/supabase/migrations/003_command_traceability.sql` | `security_events.command_id`; `security_audit_log.command_id/group_id/target_user_id` |
| 4 | `CERBERO/supabase/migrations/004_security_warnings.sql` | `security_warnings` (no la usa la suite; la exige `ZEUS/supabase/migrations/020_zeus_security_retention_and_rpcs.sql`) |
| 5 | `CERBERO/supabase/migrations/005_command_execution_safety.sql` | `security_events.reason`, `security_audit_log.reason` |
| 6 | `CERBERO/supabase/migrations/006_verified_users.sql` | `verified_users` (indiferente para la suite) |
| 7 | `CERBERO/supabase/migrations/007_command_leases_audit.sql` | `processing_token`, `lease_expires_at` |
| 8 | `CERBERO/supabase/migrations/008_restrict_command_claim.sql` | permisos de `claim_security_command` |
| 9 | `CERBERO/supabase/migrations/009_command_idempotence.sql` | `operation_key`, `result_state` e índice único `security_commands_operation_key_idx` |
| 10 | `CERBERO/supabase/migrations/010_lock_down_security_data_api.sql` | RLS y `REVOKE`/`GRANT` |
| 11 | `CERBERO/supabase/migrations/011_safe_command_lease_recovery.sql` | `execution_started_at` (contrato que verifica la RPC de `ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql`) |
| 12 | `ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql` | la RPC bajo prueba |
| 13 | `ZEUS/tests/fixtures/security-command-requeue-disposable-marker.sql` | el marcador |
| 14 | `ZEUS/tests/fixtures/security-command-requeue-audit-failure.sql` | **opcional**: prueba de atomicidad de la auditoría |

`ZEUS/supabase/migrations/020_zeus_security_retention_and_rpcs.sql` **no** es
necesaria para esta suite (sólo lo es la de reencolado,
`ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql`). Si se aplica
por paridad con producción, va **antes** de la de reencolado y depende de
`ZEUS/supabase/migrations/013_security_user_activity.sql` y de CERBERO
`001/002/004/009/011`.

**Errores de ruta que rompen el proyecto (comprobados en FASE 4D-PRE):**

| Ruta | Problema |
| --- | --- |
| `CERBERO/Cerbero-Security-Bot/supabase/migrations/` | Sólo tiene 001–009 y `CERBERO/Cerbero-Security-Bot/supabase/migrations/APPLY_ALL_001_TO_007.sql`: **le falta `011`**, así que el esquema queda sin `execution_started_at` y `ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql` aborta en su preflight |
| `CERBERO/Telegram-Group-Admin-Bot/supabase/migrations/008…011` | Son copias **de ZEUS** (`system_owner`, `verified_users`, …), no de CERBERO: mismo número, contenido incompatible |
| `APPLY_ALL_001_TO_007.sql` aplicado al final (cualquiera de sus dos copias, ver abajo) | Termina con la `claim_security_command` de la era 007: **degrada en silencio** la función de 011 (pierde `result_state='processing'` y la protección por `execution_started_at`) |
| `ZEUS/supabase/migrations/012_lock_down_security_data_api.sql` + `CERBERO/supabase/migrations/010_lock_down_security_data_api.sql` | Son el mismo archivo byte a byte: aplicar los dos es redundante (idempotente, pero confuso). Elegir uno |

**`APPLY_ALL_001_TO_007.sql` existe dos veces y las copias no son iguales (hallazgo F-01)**

| Copia (ruta completa) | Tamaño y SHA-256 | Termina con |
| --- | --- | --- |
| `CERBERO/supabase/migrations/APPLY_ALL_001_TO_007.sql` | 480 líneas, 16 102 B, `d0da4a51e88579d059bfc4c413668e8a5970c1c45b19788d1792619cc50539d5` | bloque `begin; do $$ … $$; commit;` de endurecimiento (líneas 416-480): RLS, `revoke` a `public/anon/authenticated`, `grant` a `service_role`, políticas `*_service_role_access` y `revoke`/`grant` de `claim_security_command` |
| `CERBERO/Cerbero-Security-Bot/supabase/migrations/APPLY_ALL_001_TO_007.sql` | 414 líneas, 14 294 B, `78e6f088de8947f566f6e7e9ad3f9df447fc9d28f4733c776499fa06f2be828a` | la definición de `claim_security_command` (línea 414); **no** incluye el bloque de endurecimiento |

Consecuencias:

- **Durante la FASE 4D no debe ejecutarse
  `CERBERO/Cerbero-Security-Bot/supabase/migrations/APPLY_ALL_001_TO_007.sql`.**
  Es la copia del árbol heredado (el que no tiene `011`) y, además, no incluye el
  bloque final de endurecimiento: hasta que se aplique
  `CERBERO/supabase/migrations/010_lock_down_security_data_api.sql` (que lo repite)
  las tablas quedarían sin ese `revoke`/`grant`.
- La copia de `CERBERO/supabase/migrations/` **tampoco** se ejecuta en la FASE 4D:
  la cadena 001→011 de §2.2.1 aplica cada migración por separado y `010` hace el
  mismo endurecimiento. Ejecutarla **después** de `009`/`011` degrada la función.
- Ninguna de las dos copias se borra ni se renombra: son artefactos históricos de
  CERBERO y quedan fuera del alcance de ZEUS.

> **Contrato de ejecución (TypeScript).** El árbol canónico
> `CERBERO/src/database/repositories/commands-repository.ts` define
> `markCommandExecutionStarted` (el fence de inicio que la reconciliación y el
> reencolado de ZEUS asumen). El árbol heredado
> `CERBERO/Cerbero-Security-Bot/` **no** define ese helper ni dispone de la
> migración `011` (`execution_started_at`): **no** debe usarse como sustituto del
> árbol canónico sin una auditoría de compatibilidad (riesgo de doble ejecución
> de sanciones). No se afirma aquí qué árbol despliega Railway.

Ninguna de las migraciones de ZEUS distintas de
`ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql` participa en esta
suite.

#### 2.2.2 Seed mínimo obligatorio

El preflight **detiene** la suite —las pruebas se omiten con el motivo— si falta
cualquiera de estas tres filas. No hay SQL de seed en `tests/fixtures/`: se
prepara a mano, una sola vez, en el proyecto desechable.

| Tabla | Filas | Condiciones exactas |
| --- | --- | --- |
| `groups` | 1 | `chat_id = ZEUS_TEST_GROUP_ID`; **`active = true`** (lo exige `claim_security_command`, CERBERO `011:68`, que la suite invoca en tres puntos de `tests/security-command-requeue-postgres.test.ts`) |
| `bots` | 1 | `instance_id = 'zeus-integration-test'`, `name = 'Cerbero'`, `type = 'security'`, `status = 'offline'`, `last_heartbeat_at` nulo |
| `group_bot_bindings` | 1 | par (`group_id`, `bot_id`) con ese bot y **`enabled = true`** (0 bindings, o todos deshabilitados, bloquean) |

Relaciones y condiciones previas:

- `groups` debe existir **antes** de crear órdenes: `security_commands.group_id`
  es `references groups(chat_id)` (CERBERO `001`).
- `group_bot_bindings` tiene PK `(group_id, bot_id)`: no puede haber dos bindings
  del mismo par.
- `bots.name` y `bots.instance_id` son `unique`: si ya existe otro bot llamado
  `Cerbero` con distinto `instance_id`, el seed falla por `unique_violation` (y
  el preflight también bloquearía por "se esperaba exactamente un bot").
- Ningún otro bot puede estar `online`/`running` ni con heartbeat reciente
  (§2.4), y **ningún** binding del grupo puede apuntar a otro bot.
- El `chat_id` real de un supergrupo es negativo (`-100…`). Cualquier `bigint`
  sirve para la comparación, pero un id inventado evita confundirlo con datos
  reales.

```sql
-- 1) grupo fixture (debe coincidir con ZEUS_TEST_GROUP_ID)
insert into public.groups (chat_id, title, active)
values (<CHAT_ID>, 'ZEUS integration fixture', true)
on conflict (chat_id) do update set active = true;

-- 2) bot del entorno de pruebas
insert into public.bots (name, type, instance_id, status, last_heartbeat_at)
values ('Cerbero', 'security', 'zeus-integration-test', 'offline', null)
on conflict (instance_id) do update
  set name = excluded.name,
      type = excluded.type,
      status = 'offline',
      last_heartbeat_at = null;

-- 3) binding único y habilitado
insert into public.group_bot_bindings (group_id, bot_id, enabled)
select <CHAT_ID>, b.id, true
  from public.bots b
 where b.instance_id = 'zeus-integration-test'
on conflict (group_id, bot_id) do update set enabled = true;
```

Ejecutarlo como propietario del proyecto (SQL Editor) o con `service_role`: con
`anon`/`authenticated` las políticas RLS de CERBERO `010` lo impiden.

### 2.3 Inventario de referencias protegidas

`tests/fixtures/protected-project-refs.json` es la fuente de verdad de los
proyectos **prohibidos** (incluye el proyecto real compartido que aparece en
`supabase/.temp/linked-project.json`).

- Una referencia que **no** está en el inventario no se considera segura por
  omisión: sólo es *candidata*, y la autorización sigue dependiendo del marcador
  y del preflight de vaciedad.
- Si el inventario no se puede leer o no es válido, la suite **falla cerrado**.
- Para añadir un proyecto prohibido: agregar una entrada `{ ref, label, reason }`.

### 2.4 Preflight de aislamiento (antes de cualquier escritura)

La suite exige un proyecto **exclusivo para pruebas**. El preflight tiene **dos
órdenes distintos** que no hay que confundir (hallazgo D6): el orden en que se
**leen** los datos y el orden en que se **evalúan los bloqueos**.

**Orden de lecturas** (`observePreflight`, `tests/support/preflight.ts`). Son
sólo lecturas; ninguna escritura ocurre aquí:

1. `count` del marcador del proyecto desechable;
2. `count` de `security_commands`;
3. filas de `security_commands` con `operation_key like 'zeus-it-%'` (residuos);
4. todas las filas de `bots`;
5. los `group_bot_bindings` del grupo fixture;
6. el bot con `instance_id = zeus-integration-test`.

**Orden de bloqueos** (`decidePreflight`). Esas lecturas alimentan seis
comprobaciones, evaluadas en este orden:

1. el marcador del proyecto desechable;
2. vaciedad de `security_commands` (descontando los residuos recuperables);
3. residuos: de otro grupo, con lease vigente o no atribuibles con certeza;
4. ningún bot con heartbeat reciente ni estado `online`/`running`;
5. exactamente un bot con `instance_id = zeus-integration-test` (`name = Cerbero`,
   `type = security`);
6. **todos** los bindings del grupo fixture apuntan a ese bot y hay al menos uno
   habilitado.

El orden de lecturas no coincide con el de bloqueos (se leen los bindings antes
que el bot de pruebas, pero se evalúa el bot antes que los bindings). No cambia
el veredicto —los bloqueos se acumulan y se comprueban antes de escribir nada—
pero sí el mensaje: el primer bloqueo mostrado es el primero de la lista 1–6, no
el primero que se leyó.

Consecuencia de cada caso, que conviene distinguir:

| Situación | Efecto real |
| --- | --- |
| Una lectura falla o una condición del preflight no se cumple | **Omisión** de todas las pruebas de integración, con el motivo en la salida; el proceso termina en **éxito** con `skipped 19`. Una omisión no es evidencia de nada: hay que leer el motivo |
| Falla la recuperación de residuos (§2.5), la restauración de bindings (§2.6) o el estado del espejo (§2.7) | **Fallo** de la primera prueba ("the disposable environment is in a consistent state"), además de la omisión |

**El preflight de vaciedad es una defensa adicional, no una autorización para
usar proyectos compartidos.**

Orden interno del arranque: (1) preflight inicial; (2) si y sólo si pasó,
recuperación de residuos atribuibles; (3) restauración verificada de bindings;
(4) segundo preflight con `phase = "post-recovery"`, donde cualquier residuo
atribuible que quede ya es bloqueo; (5) escenario del espejo.

### 2.5 Recuperación de residuos (ejecuciones anteriores)

Toda fila que crea la suite usa `operation_key` con prefijo `zeus-it-`. Antes de
ejecutar, y sólo si el preflight pasó, la suite elimina:

- órdenes del grupo fixture con ese prefijo;
- eventos `security_command_requeued` del grupo cuyo `details.reason` contiene el
  prefijo;
- filas del espejo con `action='security_command_requeue'` y el prefijo en
  `result`.

Nunca borra filas de otros grupos, ni filas del grupo cuya propiedad sea ambigua
(lease vigente, clave sin prefijo): en ese caso **detiene la suite** y muestra un
diagnóstico sin datos sensibles.

### 2.6 Diario de bindings

Antes de deshabilitar un binding, la suite escribe su estado original
(`group_id`, `bot_id`, `enabled`, marca de tiempo) en
`tests/.artifacts/bindings-journal.json` (ignorado por Git), con `fsync` y
renombrado atómico.

- La restauración se considera completa sólo cuando un `update` afectó a 1 fila y
  una lectura posterior confirma el estado original; entonces se retira la
  entrada.
- Si el proceso muere (`kill -9`), la siguiente ejecución restaura desde el
  diario **antes** de correr ninguna prueba.
- Un error de restauración es un **bloqueo**, nunca una omisión.
- Nunca se deshabilitan bindings de bots ajenos: el preflight garantiza que todos
  los bindings del grupo son del bot de pruebas.

Si necesitas recuperar el estado a mano:

```powershell
Get-Content tests\.artifacts\bindings-journal.json
```

y vuelve a habilitar el binding indicado en `group_bot_bindings`
(`update ... set enabled = true where group_id = <group> and bot_id = '<uuid>';`)
antes de borrar el archivo.

El diario sólo registra bindings que estaban **habilitados** (`disarmTestBindings`
filtra `enabled = true`), así que `previous_enabled` siempre es `true` y restaurar
es siempre habilitar. Si el proceso murió **después** de escribir el diario pero
**antes** del `update`, la siguiente ejecución comprueba que la fila ya está en su
estado original y retira la entrada sin escribir nada.

### 2.7 Los dos escenarios del espejo (`security_audit_log`)

El espejo `security_audit_log` es **opcional** para la RPC: si no existe, la
auditoría obligatoria vive en `security_events`. Como PostgREST no ejecuta DDL, la
suite no puede renombrar la tabla: el renombrado lo prepara y lo restaura el
operador.

| Escenario | Estado esperado al arrancar | Qué se ejecuta |
| --- | --- | --- |
| `default` (o sin variable) | `security_audit_log` presente (o ausente y sin backup) | Todo, incluida la limpieza del espejo |
| `audit-log-rename` | `security_audit_log` **ausente** y `security_audit_log_zeus_test_backup` presente | Todo + la prueba que demuestra que el reintento y la auditoría sobreviven sin espejo |

**Escenario por defecto**

```powershell
npm.cmd test
```

Si aparece `security_audit_log_zeus_test_backup`, la suite **falla** (no se
omite) indicando la sentencia de restauración.

**Escenario `audit-log-rename`**

1. preparar el estado (SQL Editor o `psql` del proyecto desechable):

```sql
alter table public.security_audit_log rename to security_audit_log_zeus_test_backup;
```

2. ejecutar:

```powershell
$env:ZEUS_TEST_SCENARIO = "audit-log-rename"
npm.cmd test
```

3. restaurar **siempre** al terminar:

```sql
alter table public.security_audit_log_zeus_test_backup rename to security_audit_log;
Remove-Item Env:\ZEUS_TEST_SCENARIO
```

**Qué se ejecuta y qué no con el escenario activo (hallazgo D1)**

La prueba de higiene (`the run leaves no rows of its own behind`) **no se omite**:
se ejecuta igual que en `default` y cuenta como ejecutada. Lo que no ocurre es su
**comprobación del espejo**: al no existir `security_audit_log`, verifica que
tampoco exista un `security_audit_log_zeus_test_backup` inesperado y retorna
antes de consultar filas del espejo.

El archivo tiene **20 pruebas**: 1 de consistencia del entorno y 19 de
integración. La diferencia entre escenarios es exactamente ésta:

| Prueba | `default` | `audit-log-rename` |
| --- | --- | --- |
| `the run leaves no rows of its own behind` (higiene) | Ejecutada, con comprobación del espejo | Ejecutada, sin comprobación del espejo (retorno temprano) |
| `the mirror table state matches the selected scenario` | Ejecutada | Ejecutada (es la que exige el estado preparado) |
| `the optional security_audit_log mirror may fail …` (espejo ausente) | **Omitida**, con instrucciones | Ejecutada |
| **Total ejecutadas** | **19** (1 de consistencia + 18 de integración) | **20** (0 omitidas) |

La última prueba garantiza que el estado preparado no cambió durante la corrida,
así que las dos comprobaciones no se contradicen (hallazgo M3). Y el operador
restaura siempre al terminar, con la sentencia indicada.

**Límite de cobertura de `default` (hallazgo D4)**

`default` **no demuestra que el espejo se escriba**. La RPC inserta el registro en
`security_audit_log` dentro de un bloque `begin … exception … raise warning`
(`ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql:522-568`): si el
esquema del espejo no admite esa escritura, degrada a *warning* del motor y la
auditoría obligatoria sigue en `security_events`. Consecuencias:

- un espejo **permanentemente roto** (columna de otro tipo, `CHECK` que no encaja,
  `NOT NULL` extra) deja la corrida **verde**: la suite no lo detecta;
- la **ausencia** del espejo sólo se demuestra con `audit-log-rename`, que prueba
  que el reencolado y la auditoría **no dependen** de él;
- si se necesita evidencia de que el espejo escribe, hay que pedirla a mano
  después de una corrida:

```sql
select action, count(*) as filas
  from public.security_audit_log
 where action = 'security_command_requeue'
 group by action;
```

Es un límite de diseño (el espejo es secundario a propósito), no un fallo: la
suite no presenta como probado nada que no haya comprobado. El hallazgo D4 queda
registrado como abierto en `supabase/MIGRATIONS.md` §7.3, junto con el resto de
pendientes que no se implementan en la FASE 4D.

**Contrato del espejo cuando la tabla existe (hallazgo D3)**

`security_audit_log` es opcional, pero **si existe** tiene que cumplir un
contrato. La sonda de presencia hace sólo `select id … limit 1`
(`mirrorProbes`), así que "la tabla existe" **no** significa "la tabla sirve":

| Columna | Quién la usa | Si falta |
| --- | --- | --- |
| `id` | sonda de presencia del escenario | Error no clasificable como tabla ausente → **falla** la primera prueba |
| `command_id` | borrado del espejo en la limpieza (`cleanupFixtures`) | `42703` → **fallo** de la limpieza y de la higiene |
| `action` | filtro de limpieza (`action = 'security_command_requeue'`) | `42703` → **fallo** |
| `result` | filtro de limpieza e higiene (`result like '%<RUN_MARKER>%'`) | `42703` → **fallo** |
| `executed_by`, `group_id`, `target_user_id` | escritura de la RPC (`ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql:527-534`) | Degrada a *warning*: el reintento y `security_events` se mantienen |

Requisito práctico: en un proyecto nuevo, aplicar
`CERBERO/supabase/migrations/003_command_traceability.sql` y
`CERBERO/supabase/migrations/007_command_leases_audit.sql` (dejan estas columnas
nulables: el primero añade `command_id`, `group_id` y `target_user_id`; el segundo
añade `action`, `result` y `executed_by`) y no añadir restricciones que la
escritura de `ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql` no
pueda satisfacer.

### 2.8 Limpieza

Cada prueba borra sus propias filas por identificadores exactos, en este orden:
espejo → eventos → reintentos → orden original. Cada operación se **verifica**
(número de filas borradas) y los errores se clasifican:

| Situación | Tratamiento |
| --- | --- |
| Tabla espejo ausente (`42P01`, `PGRST205`) | Diagnóstico (tabla opcional) |
| Columna ausente (`42703`, `PGRST204`) | **Fallo** con la causa |
| Permisos (`42501`, 401/403) | **Fallo** |
| Conexión / error de borrado | **Fallo** |

Si algo queda sin borrar, la prueba de higiene y el hook final fallan indicando
las filas pendientes: la suite nunca termina en verde dejando residuos.

La tolerancia del espejo es **sólo** para la tabla ausente: si
`security_audit_log` existe pero le falta `command_id`, `action` o `result`, el
borrado falla con `42703` y la corrida termina en rojo (ver §2.7).

### 2.9 Pruebas de la propia infraestructura

`tests/postgres-suite-guard.test.ts` prueba sin PostgreSQL: inventario de
referencias, preflight, recuperación de residuos, limpieza verificada, diario de
bindings, escenarios del espejo y la paridad `until_date` TS/SQL. Ejecutarla es
parte de `npm test`.

`tests/migrations-permissions.test.ts` (6 pruebas, también incluidas en
`npm test`) audita las migraciones locales **como texto**, sin base de datos
(hallazgo F-03). No duplica a `postgres-suite-guard` y **no** sustituye a §3.3:
comprueba el contenido de los archivos, no el catálogo del proyecto remoto.

- Toda función declarada en `supabase/migrations/*.sql` se revoca de
  `public`/`anon`/`authenticated` y se concede explícitamente a `service_role`:
  una función `security definer` sin `revoke` queda invocable desde PostgREST con
  la clave `anon`.
- Cada `security definer` fija `search_path`.
- El entrecomillado `$$` de cada migración queda cerrado (detecta cuerpos de
  función abiertos, el defecto que se coló al escribir
  `ZEUS/supabase/migrations/020_zeus_security_retention_and_rpcs.sql` por partes).
- `ZEUS/supabase/migrations/020_zeus_security_retention_and_rpcs.sql` declara
  exactamente las seis RPC previstas, sin marcadores de edición por partes, con
  `begin`/`commit`, RLS y permisos explícitos en `zeus_maintenance_runs`, y sus
  purgas respetan estados terminales, retención mínima y lotes acotados.

Sus controles de permisos **no se relajan**: si una migración local nueva incumple
la regla, la prueba falla y `npm test` termina en rojo.

## 3. RUNBOOK de FASE 4D (validación real)

> Esta sección **no autoriza nada**. Describe cómo se ejecutará la validación
> cuando exista autorización escrita y separada. Nada de esto se ha ejecutado: la
> FASE 4D-PRE fue una auditoría local sin proyecto, sin conexión, sin SQL y sin
> CLI de Supabase.

### 3.1 Reglas de la corrida

- Una sola máquina, una sola persona y una sola ejecución: no hay bloqueo
  distribuido (el diario y el preflight son locales al proceso).
- Prohibido `supabase link`, `db push`, `migration up` o `db reset` desde este
  workspace (ver `supabase/README.md`).
- La clave `service_role` del proyecto desechable no se pega en el chat, en
  registros de la corrida ni en Git; se pasa sólo por variables de entorno.
- Toda la preparación se hace desde el SQL Editor del proyecto desechable.

### 3.2 Los nueve pasos

| # | Paso | Criterio de salida |
| --- | --- | --- |
| 1 | Crear el proyecto desechable (nombre con fecha, sin integraciones ni dominios) | El panel muestra un proyecto nuevo y vacío |
| 2 | Probar que **no** es producción: ref fuera de `tests/fixtures/protected-project-refs.json`, distinta de la de `supabase/.temp/linked-project.json`, URL `https://<ref>.supabase.co`, JWT con `role=service_role` y misma `ref`, clave distinta de la del `.env` | Los cinco chequeos documentados en §2.1 |
| 3 | Declarar y comprobar la exclusividad: nadie más tiene credenciales, no hay otros runners, no hay jobs programados (`select extname from pg_extension where extname in ('pg_cron','pg_net');` → vacío) | Declaración firmada en el registro de la corrida |
| 4 | Aplicar las migraciones de §2.2.1 en orden (001→011 de CERBERO, luego `ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql`, luego el marcador) y el seed de §2.2.2 | Ninguna sentencia produce error; la de reencolado no aborta |
| 5 | Verificar antes de ejecutar (§3.3) y archivar la salida | Todas las comprobaciones en el valor esperado |
| 6 | Ejecutar la suite con el entorno cargado (§3.4), escenario `default` | `fail 0`; en `security-command-requeue-postgres.test.ts`, 19 ejecutadas y 1 omitida (la del espejo ausente, por diseño: §2.7). Con `audit-log-rename`, 20 ejecutadas y 0 omitidas |
| 7 | Comprobar que no quedan residuos (§3.3 invertido) y que `tests/.artifacts/bindings-journal.json` no existe o está vacío | 0 filas propias, binding habilitado, sin backup del espejo |
| 8 | Si la ejecución se interrumpe, seguir §3.5 **antes** de reintentar | Estado original demostrado con una consulta, no supuesto |
| 9 | Destruir el proyecto sólo con la evidencia ya archivada | Evidencia en el expediente + proyecto inexistente en el panel |

Escenario opcional `audit-log-rename`: preparar el estado, ejecutar, **restaurar
siempre** y borrar la variable. Ver §2.7.

### 3.3 Verificación previa (sólo lectura)

```sql
-- vaciedad y marcador
select count(*) from public.security_commands;                       -- 0
select count(*) from public.zeus_test_disposable_marker;             -- >= 1

-- seed (§2.2.2)
select id, instance_id, name, type, status, last_heartbeat_at
  from public.bots;                                                  -- 1 fila, Cerbero/security/offline
select bot_id, enabled
  from public.group_bot_bindings
 where group_id = <CHAT_ID>;                                         -- 1 fila, true

-- ningún worker vivo
select count(*) from public.bots
 where status in ('online','running')
    or last_heartbeat_at > now() - interval '2 minutes';              -- 0

-- espejo y auditoría
select to_regclass('public.security_audit_log') as espejo,
       to_regclass('public.security_audit_log_zeus_test_backup') as backup;  -- presente / NULL
select count(*) from public.security_events
 where event_type = 'security_command_requeued';                     -- 0
select count(*) from public.security_audit_log
 where action = 'security_command_requeue';                          -- 0

-- contrato que exige
-- ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql
select indexdef from pg_indexes
 where schemaname = 'public'
   and indexname = 'security_commands_operation_key_idx';            -- UNIQUE (group_id, action, operation_key)
```

### 3.4 Ejecución

Variables de entorno de la sesión (valores nunca en el repositorio):

```powershell
$env:ZEUS_TEST_SUPABASE_URL             = "https://<ref>.supabase.co"
$env:ZEUS_TEST_SUPABASE_SERVICE_ROLE_KEY = "<service_role legacy del proyecto desechable>"
$env:ZEUS_TEST_SUPABASE_DISPOSABLE      = "yes"
$env:ZEUS_TEST_GROUP_ID                 = "<CHAT_ID>"
$env:ZEUS_TEST_OPERATOR_ID              = "<id numerico positivo>"
Remove-Item Env:\ZEUS_TEST_SCENARIO -ErrorAction SilentlyContinue

npm.cmd test
# evidencia aislada de la suite (mismo cargador que el script):
node --import tsx --test tests/security-command-requeue-postgres.test.ts
```

Al terminar, limpiar la sesión:

```powershell
Remove-Item Env:\ZEUS_TEST_SUPABASE_URL, Env:\ZEUS_TEST_SUPABASE_SERVICE_ROLE_KEY,
  Env:\ZEUS_TEST_SUPABASE_DISPOSABLE, Env:\ZEUS_TEST_GROUP_ID,
  Env:\ZEUS_TEST_OPERATOR_ID, Env:\ZEUS_TEST_SCENARIO -ErrorAction SilentlyContinue
```

`ZEUS_TEST_OPERATOR_ID` viaja como `p_actor_id`; la RPC de
`ZEUS/supabase/migrations/021_zeus_security_command_requeue.sql` rechaza valores
`<= 0`, así que debe ser un entero positivo.

### 3.5 Recuperación si la ejecución se interrumpe

| Interrupción | Qué queda | Qué hacer |
| --- | --- | --- |
| Durante el cambio de bindings | Diario escrito, `update` puede o no haber ocurrido | No hacer nada: la siguiente corrida restaura desde el diario y, si la fila ya estaba en su estado original, retira la entrada. Sólo borrar `bindings-journal.json.tmp` si quedó huérfano |
| Durante la limpieza | Filas `zeus-it-…` parcialmente borradas | Reintentar: el preflight inicial las reconoce y `recoverResiduals` las elimina. Sólo si decide bloquear, borrar por `id` lo demostrablemente propio |
| Después de renombrar el espejo | `security_audit_log` ausente y backup presente | El modo `default` **falla** con la sentencia exacta: `alter table public.security_audit_log_zeus_test_backup rename to security_audit_log;` |
| Diario ilegible | Nada se deshabilita y nada se restaura | Abrir el archivo, comprobar `group_bot_bindings` del grupo, dejar `enabled = true`, **borrar el diario** y volver a ejecutar. Nunca "reparar" el JSON a mano |
| Residuo ambiguo (otro grupo, sin prefijo, lease vigente) | Bloqueo sin borrar nada | Decisión humana: identificar el origen; si hay lease vigente, esperar a que expire o neutralizarla como hace CERBERO `011` |

Regla única: **no reintentar** mientras el diario no esté vacío o el espejo no esté
restaurado, y no tocar `supabase/.temp/linked-project.json` (sigue apuntando al
proyecto real).

### 3.6 Qué demuestra el marcador y qué no

El marcador `zeus_test_disposable_marker` es **autocertificado**: cualquier
proyecto puede tener esa tabla. Demuestra que alguien ejecutó el fixture ahí, no
que el proyecto sea exclusivo.

| Demostrable técnicamente (en el instante del preflight) | Declarativo (depende del operador) |
| --- | --- |
| Coherencia URL ↔ clave ↔ ref, `role=service_role` | Que el proyecto se creó para esto y no lo consume nadie más |
| Ref fuera del inventario de prohibidas | Que la clave no se ha compartido y no hay escritores externos (TOCTOU) |
| Marcador con ≥ 1 fila | Que no hay una segunda máquina ejecutando la suite |
| `security_commands` vacío (descontando residuos atribuibles) | Que no hay jobs programados ni integraciones que escriban |
| Ningún bot con heartbeat reciente ni `online`/`running` | Que las tablas distintas de `security_commands` no tienen datos reales |
| Bot de pruebas único y bindings exclusivos del grupo | Que el marcador se creó sólo aquí |
| Estado del espejo coherente con el escenario | Que la corrida es única y supervisada |
| Sin residuos propios al final | — |

Riesgos que siguen abiertos:

1. **Sin bloqueo distribuido**: el preflight es *check-then-act* y el diario es por
   máquina; dos máquinas pueden solaparse.
2. **Vaciedad limitada** a `security_commands`: `security_events`,
   `security_audit_log`, `verified_users` o `afrodita_*` pueden tener datos reales
   sin bloquear.
3. **Ventana del renombrado**: si el proceso muere entre renombrar y restaurar, se
   detecta (fallo con sentencia), pero exige SQL manual.
4. **Espejo roto invisible en `default`** (§2.7, hallazgo D4).
5. **Heartbeat de 2 minutos**: un worker con heartbeat más espaciado, o `offline`
   con proceso vivo, pasaría el filtro.
6. **RLS no probada**: la suite usa `service_role`, que omite RLS.

### 3.7 Autorizaciones necesarias antes de la FASE 4D

Requieren autorización expresa, separada y escrita: crear el proyecto desechable;
usar su `service_role`; aplicar cualquier migración; ejecutar los fixtures y el
seed; ejecutar la suite contra el proyecto remoto (escrituras reales); ejecutar
`audit-log-rename` (implica `ALTER TABLE … RENAME`); destruir el proyecto. El CLI
de Supabase sigue prohibido salvo autorización específica para él.

