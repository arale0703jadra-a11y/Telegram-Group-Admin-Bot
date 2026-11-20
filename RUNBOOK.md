# RUNBOOK — ZEUS · CERBERO · Supabase

Procedimientos operativos de ZEUS. **No contiene secretos** y no incluye
comandos que modifiquen producción por sí solos: todo lo destructivo figura como
paso a ejecutar con autorización explícita y evidencia previa.

Documentos relacionados: `supabase/MIGRATIONS.md` (inventario y rollback),
`PRODUCTION_READINESS.md` (estado y bloqueos), `DEPLOY.md`, `TESTING.md`.

## 1. Arquitectura

```
Telegram  ──►  ZEUS (panel, detección, configuración)
                    │
                    │ inserta security_commands (status=pending)
                    ▼
             Supabase / PostgreSQL
                    │  claim_security_command()  ← única vía de reclamación
                    ▼
              CERBERO (ejecutor independiente)
                    │  mark_command_execution_started → acción → complete_command
                    ▼
             security_commands / security_events / security_audit_log
```

Reglas que no deben romperse:

- ZEUS **no** ejecuta sanciones por sí mismo cuando `SECURITY_EXECUTION_MODE`
  delega en CERBERO: encola y consulta el resultado.
- ZEUS y CERBERO **no** se comunican por Telegram ni por ficheros JSON
  compartidos. El único canal es PostgreSQL.
- La reclamación es atómica (`FOR UPDATE SKIP LOCKED`) y sólo CERBERO la hace.
- La garantía real de no duplicar es el índice único parcial
  `security_commands_operation_key_idx (group_id, action, operation_key)`.

## 2. Variables necesarias (sin valores)

| Variable | Obligatoria | Uso |
| --- | --- | --- |
| `BOT_TOKEN` | Sí | Token de ZEUS en BotFather |
| `SUPABASE_URL` | Sí (funciones con BD) | URL del proyecto |
| `SUPABASE_SERVICE_ROLE_KEY` | Sí (funciones con BD) | Clave administrativa; **sólo backend** |
| `OWNER_ID` | Sí | Identidad administrativa global |
| `ALEXIITA_TELEGRAM_ID` | Recomendada | Segunda identidad administrativa |
| `SYSTEM_OWNER_BOOTSTRAP_ID` | Recomendada | Bootstrap y recuperación |
| `CERBERO_TELEGRAM_BOT_ID` | **Sí para proteger grupos** | ID numérico verificado de CERBERO |
| `SECURITY_EXTRA_BOT_IDS` | Opcional | Otros bots autorizados (IDs numéricos) |
| `CERBERO_INSTANCE_ID` | Opcional | Identidad de instancia de CERBERO (no es su bot ID) |
| `SECURITY_EXECUTION_MODE` | Opcional | `cerbero` delega la ejecución |
| `LINK_WHITELIST`, `LINK_FILTER_BLOCK_MENTIONS` | Opcional | Filtro de enlaces |
| `PROFILE_BLOCKED_TERMS` | Opcional | Filtro de perfiles |
| `SUPABASE_RESTRICTED_URL` / `SUPABASE_RESTRICTED_KEY` | Opcional | Cliente restringido; si falta, no se usa |

Comprobación sin revelar valores: que la variable exista y que su longitud sea la
esperada. Nunca imprimir el contenido ni volcarlo a logs.

## 3. Verificar los bots autorizados

1. `CERBERO_TELEGRAM_BOT_ID` debe contener el **ID numérico** verificado de
   CERBERO. El valor comprobado manualmente es `8884801307`.
2. No debe coincidir con ninguna identidad administrativa
   (`OWNER_ID`, `ALEXIITA_TELEGRAM_ID`, `SYSTEM_OWNER_BOOTSTRAP_ID`): ZEUS lo
   detecta y emite un aviso; un ID de usuario ahí es un error de configuración.
3. `GET /menu` en privado muestra el diagnóstico del guardián de bots: con
   CERBERO pendiente, la protección figura **DESACTIVADA** y ZEUS no expulsa
   bots no autorizados (no puede garantizar que uno de ellos no sea CERBERO).
4. `SECURITY_EXTRA_BOT_IDS` no sustituye a `CERBERO_TELEGRAM_BOT_ID`.

## 4. Salud de Supabase

Comprobaciones de sólo lectura desde el editor SQL:

```sql
-- Conectividad y permisos del rol que consulta
select current_user, now();

-- Funciones de sesión (019) y de actividad (020, si está aplicada)
select p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname like 'zeus_%'
 order by 1;

-- Tablas con RLS activo en el esquema público
select relname, relrowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
 order by 1;
```

En logs de ZEUS, las señales de salud son:

- `[USER SESSION]` → persistencia de sesión (un aviso agrupado por incidente y
  un aviso de recuperación, nunca uno por petición).
- `[SECURITY_RECONCILE]` → sólo aparece cuando reconcilia algo (`reconciled>0`).
- `PGRST202` / `42883` repetidos → una RPC no está aplicada; la ruta degradada
  está funcionando, pero conviene aplicar la migración.


## 5. Estado de las órdenes

```sql
-- Resumen por estado
select status, result_state, count(*) as total,
       min(created_at) as oldest, max(created_at) as newest
  from public.security_commands
 group by status, result_state
 order by status, result_state;

-- Órdenes en ejecución: si una lleva mucho tiempo con lease vencido, es
-- candidata a reconciliación (nunca se borra).
select id, group_id, action, target_user_id, attempts,
       processing_instance_id, processing_at, lease_expires_at,
       execution_started_at, last_error
  from public.security_commands
 where status = 'processing'
 order by processing_at nulls last;

-- Pendientes más antiguas (una orden pendiente es intención vigente, no basura)
select id, group_id, action, target_user_id, created_at, attempts, operation_key
  from public.security_commands
 where status = 'pending'
 order by created_at
 limit 50;
```

## 6. Recuperar órdenes abandonadas

Dos mecanismos, con propósitos distintos:

1. **Reconciliación (automática, segura).** ZEUS ejecuta
   `reconcileStaleSecurityCommands()` al arrancar y cada 60 s si Supabase está
   configurado. Marca `result_state='unknown'` y escribe en `last_error`
   `Stale processing detected by ZEUS reconciliation; order available for
   re-enqueue.` Sólo actúa si el lease venció o, sin lease, tras 5 minutos
   (`STALE_PROCESSING_GRACE_MS`), y **nunca** toca una orden con
   `execution_started_at` ni con evidencia previa. No repite nada.
2. **Reencolado (manual, con confirmación).** `requeueSecurityCommand()`
   neutraliza la original y crea `<operation_key>#retry` en una sola transacción
   mediante la RPC de la migración 021. Requiere:
   - acción repetible (`MUTE_USER`, `UNMUTE_USER`, `BAN_USER`, `UNBAN_USER`,
     `UPDATE_SECURITY_CONFIG`, `UPDATE_PROTECTED_USER`);
   - `attempts < 5`, sin marca de inicio, profundidad de reintento < 3;
   - mute con al menos 30 s de ventana restante;
   - confirmación explícita del operador (puede revertir una decisión humana
     posterior).

Si la 021 no está aplicada, el reencolado responde `requeue_rpc_unavailable` y
**no** escribe nada. Es un rechazo seguro, no un fallo silencioso.

Órdenes que **no** deben borrarse nunca: `pending`, `processing`,
`result_state='unknown'` y las referenciadas por `security_warnings`.

## 7. Identificar órdenes duplicadas

```sql
-- Duplicados por clave de idempotencia (no debería devolver filas: hay índice único)
select group_id, action, operation_key, count(*) as copias
  from public.security_commands
 where operation_key is not null
 group by 1, 2, 3
having count(*) > 1;

-- Cadenas de reintento y su profundidad
select operation_key, count(*) as copias
  from public.security_commands
 where operation_key like '%#retry%'
 group by 1
 order by 1;

-- ¿Existe el índice que sostiene la garantía?
select indexname, indexdef
  from pg_indexes
 where schemaname = 'public'
   and tablename = 'security_commands'
   and indexname = 'security_commands_operation_key_idx';
```

Si el índice no existe, **no usar** el reencolado: dos operadores podrían crear
dos reintentos de la misma orden. Es un bloqueo, no una advertencia.

Un duplicado real en Telegram (misma sanción aplicada dos veces) se investiga
con `security_events` y `security_audit_log` por `command_id`; **no** se corrige
borrando filas de auditoría.

## 8. Errores en Railway

Sin acceso autorizado no se puede inspeccionar el proyecto: esta sección
describe **dónde** mirar, no afirma nada sobre su estado actual.

1. Servicio de ZEUS → *Deployments* → último despliegue: estado, comando de
   arranque y hora.
2. *Logs* del despliegue activo. Buscar por prefijo:
   `[SECURITY_RECONCILE]`, `[USER SESSION]`, `[USER_ACTIVITY]`,
   `[VERIFIED_MARKER]`, `[VERIFIED_AUTO_REVOCATION]`, `[INACTIVITY_CLEANER]`.
3. Errores típicos:
   - `409 Conflict` en `getUpdates` → **dos instancias** con el mismo token.
     ZEUS detecta el caso y añade el aviso `409 Conflict: otra instancia está
     haciendo polling…` (sección 13).
   - `PGRST202` / `42883` → RPC no aplicada; el código degrada, pero la
     migración falta.
   - `ETIMEDOUT` / `fetch failed` → Supabase inalcanzable; las escrituras
     fallan de forma cerrada y se reintentan en el siguiente ciclo.
4. *Metrics*: memoria y CPU sostenidas al alza indican fuga o bucle; un reinicio
   en bucle suele ser una excepción al arrancar (configuración incompleta).
5. No reiniciar ni redesplegar para "ver si se arregla": primero leer el log y
   anotar la causa.

## 9. Despliegue controlado

Requisitos previos, todos locales y verificables sin producción:

1. `npm run typecheck` sin errores.
2. `npm test` completo (las pruebas de integración PostgreSQL se omiten si no
   hay entorno desechable; eso es lo esperado, no un fallo).
3. `npm run build` sin errores.
4. `git diff --check` limpio.

Procedimiento:

1. Confirmar que la rama desplegada es la revisada y que el directorio raíz del
   servicio es el que contiene `package.json` de ZEUS.
2. Verificar que el servicio tiene **una sola réplica** (sección 13).
3. Revisar que las variables de la sección 2 existen en el entorno de despliegue
   (sin imprimir valores), incluido `CERBERO_TELEGRAM_BOT_ID=8884801307`.
4. Desplegar en ventana de baja actividad.
5. Observar los logs del arranque: `init` del bot, ausencia de `409`, ausencia de
   excepciones de configuración.
6. Comprobar `/menu` en privado con una identidad autorizada y una operación de
   lectura (por ejemplo, listar verificadas) antes de usar acciones de
   moderación.
7. Si algo falla: rollback al despliegue anterior en Railway (no `git revert`
   apresurado) y conservar los logs.

## 10. Preparar una migración

1. Numeración consecutiva en `supabase/migrations/`; nunca reutilizar un número.
2. Preflight explícito: si falta una dependencia, `raise exception`. No crear
   modos degradados inseguros.
3. Toda función `SECURITY DEFINER` debe llevar `set search_path = pg_catalog,
   public`, `revoke ... from public, anon, authenticated` y `grant execute ... to
   service_role`. El test `tests/migrations-permissions.test.ts` lo exige.
4. Operaciones de datos: por lotes, con `FOR UPDATE SKIP LOCKED`, límite máximo y
   retención mínima; nunca tocar `pending` ni `processing`.
5. Añadir las aserciones correspondientes al test de migraciones.
6. Probar en un proyecto/entorno desechable **autorizado** antes de producción.
7. Actualizar `supabase/MIGRATIONS.md` con objetos, dependencias y estado
   (**Preparada** hasta que se aplique de verdad).
8. Aplicar sólo con autorización específica y registrar la evidencia.

## 11. Rollback

Detalle completo en `supabase/MIGRATIONS.md`, sección 6. Reglas:

- 020 y 021 sólo añaden objetos, así que su rollback es `drop function` / `drop
  table` de lo añadido.
- Nunca editar a mano `supabase_migrations` para "simular" un rollback: lo que
  importa son los efectos en el esquema.
- Si el rollback elimina las RPC de actividad, ZEUS vuelve solo a la ruta REST
  compatible: no se pierde el registro de actividad.
- El rollback no debe borrar auditoría ni órdenes.

## 12. Rotar `SUPABASE_SERVICE_ROLE_KEY`

Consideraciones reales:

- Con el **JWT legacy**, la `service_role` deriva del secreto JWT del proyecto:
  rotarlo invalida también `anon` y todas las claves a la vez. No es una rotación
  parcial.
- Con las **claves nuevas** (secret key), es posible crear una nueva, mantener la
  anterior durante la transición y revocar después.
- ZEUS resuelve el cliente por huella URL+clave en cada llamada, pero **lee la
  variable al arrancar**: un cambio de variable exige redespliegue.
- CERBERO y (cuando se reactive) AFRODITA usan la misma clave: coordinar la
  ventana con ambos. **No** se modifica CERBERO desde aquí.

Procedimiento:

1. Anunciar ventana y congelar despliegues ajenos.
2. Crear la clave nueva en Supabase.
3. Actualizar la variable en Railway de cada servicio.
4. Redesplegar (una instancia, ordenada). Durante el hueco las escrituras fallan
   de forma cerrada y las sesiones se degradan; no se corrompe nada.
5. Verificar con una operación de lectura y una de escritura controlada.
6. Revocar la clave anterior.
7. Registrar fecha, alcance y verificaciones.

## 13. Verificar que no hay dos instancias del mismo bot

1. Railway → servicio de ZEUS → *Settings* → réplicas: debe ser **1**.
2. Logs: `409 Conflict` en `getUpdates` significa que dos procesos hacen polling
   con el mismo `BOT_TOKEN`. Uno de ellos debe detenerse.
3. **Nunca** ejecutar `npm run dev` en local con el token de producción mientras
   el servicio está activo: se convierte en la segunda instancia y roba
   actualizaciones.
4. Tareas periódicas (`inactivityTimer`, `verifiedMarkerRescanTimer`,
   `verifiedAutoRevocationTimer`, `securityReconcileTimer`) también se duplican
   con dos instancias. Las tres últimas son idempotentes; la limpieza de
   inactividad no debe correr dos veces por grupo.
5. No existe guard de instancia única en el código: la garantía es
   operativa (una réplica). Si en el futuro se necesitan varias, hace falta
   exclusión distribuida real, no un fichero local.

## 14. Filtración de credenciales

1. **Contener**: pausar el servicio comprometido si hay señales de uso activo
   (no reiniciar en bucle, no borrar logs).
2. **Rotar** en este orden: `BOT_TOKEN` (BotFather → *Revoke current token*),
   `SUPABASE_SERVICE_ROLE_KEY` (sección 12), y cualquier clave de terceros.
   Asumir que `OWNER_ID`/IDs no son secretos, pero sí verificables.
3. **Actualizar** las variables en Railway y redesplegar una sola instancia.
4. **Investigar** sin destruir evidencia:
   - `security_audit_log` y `security_events` por rango de fechas y `executor`;
   - `security_commands` creadas en la ventana (acción, grupo, objetivo);
   - logs de API de Supabase y de Railway;
   - cambios de administradores o de configuración de grupos.
5. **Documentar** el incidente y las decisiones (qué se rotó, cuándo, por quién).
6. Revisar si la clave apareció en logs, capturas o repositorios; si estuvo en
   Git, considerarla comprometida aunque se borre el commit.
