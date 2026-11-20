# Carpeta `supabase/` — migraciones y artefactos locales

## 1. Contenido

| Ruta | Qué es | ¿Se versiona? |
| --- | --- | --- |
| `migrations/` | Migraciones SQL de ZEUS (ver `MIGRATIONS.md`) | Sí |
| `config.toml` | Configuración del CLI de Supabase para este proyecto | Sí |
| `MIGRATIONS.md` | Inventario y estado (local) de cada migración | Sí |
| `.gitignore` | Ignora `.branches` y `.temp` | Sí |
| `.temp/` | Artefactos del CLI (`linked-project.json`, etc.) | **No** (ignorado) |

## 2. `supabase/.temp/linked-project.json`

Ese archivo lo genera el CLI de Supabase cuando alguien ejecuta `supabase link`.
En este workspace contiene **la referencia del proyecto real compartido por ZEUS
y CERBERO** (`ref`, nombre del proyecto y organización).

Decisiones de la Fase 4C:

- **No se elimina**: es el único registro local de a qué proyecto quedó enlazado
  el CLI, y borrarlo ocultaría esa información sin aportar seguridad.
- **No se versiona**: está ignorado por `supabase/.gitignore` (y por una entrada
  explícita en el `.gitignore` raíz, redundante a propósito).
- **Su referencia está en el inventario de pruebas**:
  `tests/fixtures/protected-project-refs.json`. La suite PostgreSQL se niega a
  ejecutarse contra ese proyecto aunque exista el marcador de proyecto
  desechable, y `tests/postgres-suite-guard.test.ts` comprueba que la referencia
  de este archivo siga estando protegida.

Procedimiento completo (incluido el huérfano `Telegram-Bots/supabase/.temp/`, que
está fuera de Git) y qué **no** se debe ejecutar:
`supabase/LINK_PROTECTION.md`.

## 3. Regla: no usar el CLI de Supabase desde este workspace

**No ejecutar** `supabase link`, `supabase db push`, `supabase migration up`,
`supabase db reset` ni ningún comando remoto desde este repositorio.

Motivos:

1. El workspace está enlazado a un proyecto **real** con datos de producción.
2. `db push` / `migration up` aplican cambios de esquema sin revisión por lotes.
3. Las pruebas de integración de ZEUS exigen un proyecto **exclusivo y
   desechable** (`tests/README.md`), que se opera con SQL Editor o `psql` y con
   una clave `service_role` propia, nunca con el enlace de este workspace. El
   procedimiento completo (nueve pasos, verificaciones y recuperación) está en
   `tests/README.md` §3.

Las migraciones se aplican manualmente y de forma revisada, según
`DEPLOY.md` y `MIGRATIONS.md`.
