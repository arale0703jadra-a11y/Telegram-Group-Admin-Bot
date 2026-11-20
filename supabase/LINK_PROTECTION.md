# Protección del enlace local del CLI de Supabase

Documento de la Fase 4D (bloque 5). **Es una propuesta: nada de lo aquí descrito
se ha ejecutado.** No se ha borrado, movido ni renombrado ningún archivo, y no
se ha invocado el CLI de Supabase.

## 1. Estado verificado (sólo lectura)

| Ruta | Contenido | ¿Versionado? |
| --- | --- | --- |
| `ZEUS/supabase/.temp/` | `linked-project.json`, `project-ref`, `pooler-url`, `cli-latest`, `rest-version`, `postgres-version`, `gotrue-version`, `storage-version`, `storage-migration` | **No** |
| `Telegram-Bots/supabase/.temp/` (raíz del workspace) | `linked-project.json`, `cli-latest` | **No aplica** |
| `ZEUS/supabase/config.toml` | Configuración del CLI de Supabase (referencia de proyecto y ajustes); revisar que **no** contenga claves | **Sí** |

Hechos comprobados:

1. `ZEUS/supabase/.temp/` contiene un **enlace activo a un proyecto real**. El
   CLI de Supabase resuelve el proyecto subiendo por el árbol de directorios, de
   modo que cualquier comando ejecutado desde `ZEUS/` o desde la raíz del
   workspace apunta a ese proyecto.
2. `ZEUS/supabase/.temp/linked-project.json` está ignorado por **dos** reglas
   independientes (redundancia deliberada):
   - `ZEUS/supabase/.gitignore` → `.temp`;
   - `ZEUS/.gitignore` → `supabase/.temp/` (con comentario).
   Verificación: `git check-ignore -v supabase/.temp/linked-project.json` imprime
   `supabase/.gitignore:3:.temp`.
3. `Telegram-Bots/supabase/.temp/` es un **huérfano**: la raíz del workspace no es
   un repositorio Git (`git rev-parse` falla), así que no hay `.gitignore` que lo
   cubra. No puede "colarse" en un commit de ZEUS, pero tampoco está protegido
   por reglas: su protección es puramente manual.
4. La referencia del proyecto está registrada en
   `tests/fixtures/protected-project-refs.json` y la suite PostgreSQL se niega a
   ejecutarse contra ella (ver `tests/README.md` y
   `tests/postgres-suite-guard.test.ts`).
5. `ZEUS/supabase/config.toml` está versionado (`git ls-files` lo incluye) y no
   forma parte de `.temp/`: su configuración viaja en el historial de Git, así
   que debe auditarse para que no contenga claves ni referencias protegidas.

## 2. Riesgo concreto

| Comando | Efecto sobre el proyecto real |
| --- | --- |
| `supabase db push` | Aplicaría las migraciones pendientes (`020`, `021`) sin revisión por lotes. |
| `supabase migration up` | Igual, pero contra la base enlazada. |
| `supabase db reset` | Destruiría datos del proyecto enlazado. |
| `supabase db pull` | Sobrescribiría migraciones locales con el esquema remoto. |
| `supabase functions deploy` / `secrets set` | Cambios en el proyecto real sin auditoría. |

El riesgo no es el archivo `.temp` en sí: es que **existe un enlace** y basta un
comando para usarlo. Por eso la mitigación es documental y operativa, no de
borrado.

## 3. Procedimiento de neutralización propuesto (a ejecutar por el propietario)

Requisitos previos, todos locales:

1. Confirmar que no hay ningún proceso del CLI en ejecución ni una terminal
   abierta en `ZEUS/` o en la raíz del workspace.
2. Confirmar que ningún flujo (CI, script, tarea programada) depende del enlace.
3. Anotar la referencia del proyecto fuera del repositorio si se quiere conservar
   la evidencia; el inventario de pruebas ya la guarda.

Tres opciones, de menor a mayor impacto. **Ninguna se ha ejecutado.**

### Opción A (recomendada): desactivar sin borrar

Renombrar sólo el archivo que define el enlace en ambas ubicaciones:

```powershell
Rename-Item -LiteralPath "C:\Users\cjus2\OneDrive\Documentos\Telegram-Bots\ZEUS\supabase\.temp\linked-project.json" -NewName "linked-project.json.disabled"
Rename-Item -LiteralPath "C:\Users\cjus2\OneDrive\Documentos\Telegram-Bots\supabase\.temp\linked-project.json" -NewName "linked-project.json.disabled"
```

- Reversible con un `Rename-Item` inverso.
- El CLI deja de reconocer el enlace; los demás artefactos (versiones) quedan
  como caché inocua.
- No usa `supabase unlink` (que también sería un comando del CLI y está fuera de
  lo autorizado en esta fase).

### Opción B (definitiva): eliminar los directorios `.temp`

```powershell
Remove-Item -LiteralPath "...\ZEUS\supabase\.temp" -Recurse -Force
Remove-Item -LiteralPath "...\supabase\.temp" -Recurse -Force
```

- No afecta al repositorio: ambos están ignorados / fuera de Git.
- Pierde el registro local de a qué proyecto se enlazó (el inventario lo conserva).
- Irreversible sin volver a ejecutar `supabase link` (prohibido aquí).

### Opción C (estado actual): no tocar nada

Mantener los archivos y confiar en la regla de §4. Es lo que hay hoy. Coste: el
enlace sigue existiendo y un comando accidental sigue siendo posible.

## 4. Protección del `.gitignore`

Reglas que deben sobrevivir a cualquier limpieza futura:

| Archivo | Regla | Motivo |
| --- | --- | --- |
| `ZEUS/supabase/.gitignore` | `.temp` | Ignora el directorio completo, incluidos archivos nuevos del CLI. |
| `ZEUS/.gitignore` | `supabase/.temp/` | Redundante a propósito: sobrevive si alguien borra `supabase/.gitignore`. |

Criterios de aceptación (comprobables sin red):

```powershell
# 1. La regla existe y gana:
git -C ZEUS check-ignore -v supabase/.temp/linked-project.json   # imprime una regla
# 2. Nada de .temp está versionado (debe imprimir 0 líneas):
git -C ZEUS ls-files supabase/.temp
# 3. El CLI no aparece en scripts del proyecto (debe imprimir 0 líneas):
Select-String -Path ZEUS/package.json -Pattern 'supabase'
```

Si algún día el directorio `.temp` desaparece, **no** hay que retirar la entrada
del `.gitignore`: su función es precisamente cubrir la recreación futura.

## 5. Regla operativa (la mitigación principal)

**No ejecutar el CLI de Supabase desde `ZEUS/` ni desde la raíz del workspace.**

- Las migraciones se aplican a mano, revisadas, según `MIGRATIONS.md` y
  `DEPLOY.md`.
- Las pruebas de integración usan un proyecto **exclusivo y desechable**,
  operado con SQL Editor o `psql` y con credenciales `ZEUS_TEST_*`
  (`tests/README.md`). Nunca con el enlace de este workspace.
- Si una herramienta o un agente propone `supabase link`, `db push`,
  `migration up` o `db reset`: se detiene y se escala al propietario.

## 6. Qué NO se ha hecho en la Fase 4D

- No se ha borrado, movido ni renombrado ningún archivo de `.temp`.
- No se ha ejecutado ningún comando del CLI de Supabase.
- No se ha abierto ninguna conexión (ni de base de datos, ni HTTP, ni de API).
- No se ha modificado `.gitignore` (las reglas actuales ya eran correctas).

