# Zeus — Prueba local

## 1. Preparar el entorno

Requisitos:

- Node.js instalado.
- Un bot de pruebas creado con `@BotFather`.
- Un grupo de pruebas.
- Una cuenta de Telegram para bootstrap y otra cuenta para probar Recovery Key.
- Un proyecto Supabase de pruebas con la migración 008 aplicada solo en ese entorno.
- Cerbero disponible si se van a probar órdenes delegadas.

Instalar dependencias:

```powershell
npm.cmd install
```

Crear `.env` a partir de `.env.example` y completar:

```text
BOT_TOKEN=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SYSTEM_OWNER_BOOTSTRAP_ID=
```

`SYSTEM_OWNER_BOOTSTRAP_ID` debe ser el ID numérico de la cuenta que hará el primer bootstrap.

No compartir ni registrar `BOT_TOKEN` ni `SUPABASE_SERVICE_ROLE_KEY`.

## 2. Comandos npm

El proyecto ya tiene los scripts necesarios:

```powershell
npm.cmd run dev        # desarrollo con recarga
npm.cmd run typecheck  # comprobación TypeScript
npm.cmd run build      # genera dist/
npm.cmd start          # ejecuta dist/bot.js
npm.cmd test           # tests automatizados
```

Antes de arrancar:

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
```

## 3. Arrancar Zeus

Para desarrollo:

```powershell
npm.cmd run dev
```

Para ejecutar la compilación:

```powershell
npm.cmd run build
npm.cmd start
```

Debe aparecer un mensaje similar a:

```text
🤖 Admin Bot iniciado correctamente como @nombre_del_bot
```

Si falta `BOT_TOKEN`, `SUPABASE_URL` o `SUPABASE_SERVICE_ROLE_KEY`, Zeus termina con un error explícito de configuración.

Para detenerlo en PowerShell:

```text
Ctrl+C
```

## 4. Prueba de `/menu` y permisos

1. Añadir Zeus al grupo de pruebas.
2. Concederle permisos suficientes para la prueba.
3. Desde la cuenta creator, enviar `/menu` en el grupo.
4. Confirmar que Zeus valida el estado Telegram `creator`.
5. Confirmar que abre el panel en el chat privado.
6. Repetir con una cuenta `administrator`.
7. Confirmar que también recibe el panel privado.
8. Repetir con un usuario normal.
9. Confirmar que recibe rechazo y no obtiene acceso al panel.
10. Quitar al bot permisos de administración y repetir.
11. Confirmar que el grupo deja de ser operable o que la acción se rechaza.

## 5. Bootstrap de Zeus

1. Desde la cuenta cuyo ID está en `SYSTEM_OWNER_BOOTSTRAP_ID`, abrir el chat privado.
2. Ejecutar:

```text
/zeus-bootstrap
```

3. Confirmar el mensaje de System Owner establecido.
4. Ejecutar el comando una segunda vez.
5. Confirmar que no reemplaza al propietario.
6. Intentar el comando desde otra cuenta.
7. Confirmar que se rechaza.
8. Intentar el comando dentro de un grupo.
9. Confirmar que se rechaza.

## 6. Recovery Key

1. Desde el System Owner actual, ejecutar:

```text
/zeus-generar-recuperacion
```

2. Guardar la clave fuera de Telegram para la prueba.
3. Confirmar que Zeus solo la muestra una vez.
4. Desde la cuenta nueva, abrir el chat privado.
5. Ejecutar:

```text
/zeus-recuperar
```

También se puede iniciar desde:

```text
/menu → Ayuda → Recovery Key → Recuperar System Owner
```

6. Introducir la Recovery Key correcta.
7. Confirmar que la cuenta nueva pasa a ser System Owner.
8. Confirmar que la cuenta anterior deja de ser System Owner.
9. Repetir con la misma clave y confirmar el rechazo.
10. Probar una clave incorrecta y confirmar el rechazo.
11. Probar una clave revocada y confirmar el rechazo.
12. Probar un challenge expirado y confirmar el rechazo.
13. Repetir intentos fallidos hasta activar el rate limit.
14. Confirmar que un usuario bloqueado no puede iniciar otra recuperación.

## 7. Panel privado

Desde `/menu` en el chat privado comprobar:

- Usuarios: listado, búsqueda y acciones de moderación.
- Seguridad Cerbero: estado, estadísticas y eventos.
- Filtros: ver, agregar, eliminar y activar/desactivar.
- Bienvenida: activar, editar, vista previa y prueba.
- Actividad: resumen por grupo.
- Inactividad: configuración, listado y limpieza.
- Verificadas: listado, alta y permisos.
- Configuración: consulta y cambios.
- Mensajes automáticos: crear, activar, frecuencia, enviar y eliminar.
- Limpieza: limpieza de mensajes recientes.
- Ayuda: Emergencias, Recovery Key y Volver.

Después de cada cambio:

1. cerrar y volver a abrir el panel;
2. confirmar que el valor persiste;
3. confirmar que el callback exige seguir siendo administrador Telegram.

## 8. Cerbero

1. Confirmar que Cerbero está disponible.
2. Activar filtros desde el panel.
4. Cambiar configuración anti-spam, enlaces o multimedia.
5. Ejecutar una moderación desde Usuarios:
   - warn;
   - mute;
   - unmute;
   - ban;
   - unban;
   - kick;
   - limpieza.
6. Confirmar que Zeus registra/delega la orden.
7. Confirmar que Cerbero ejecuta la acción.
8. Confirmar que el resultado o error se muestra en el panel.

## 9. Resultado de la prueba

Registrar para cada paso:

- fecha y hora;
- grupo;
- cuenta Telegram usada;
- resultado esperado;
- resultado real;
- evidencia;
- error o log relacionado.

No usar Recovery Keys ni tokens de producción durante esta prueba.
