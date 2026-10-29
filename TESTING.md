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
OWNER_ID=
ALEXIITA_TELEGRAM_ID=
```

`SYSTEM_OWNER_BOOTSTRAP_ID` debe ser el ID numérico de la cuenta que hará el primer bootstrap.
`ALEXIITA_TELEGRAM_ID` debe ser el ID numérico verificado de la cuenta secundaria.
No se debe inferir ni aceptar este ID únicamente a partir de un username: confírmalo
con Alexiita por un canal independiente y contrasta el ID que Telegram entrega en
una interacción privada con el bot.

Política de permisos vigente: las tres identidades configuradas
(`OWNER_ID`, `ALEXIITA_TELEGRAM_ID` y `SYSTEM_OWNER_BOOTSTRAP_ID`) tienen
exactamente la misma jerarquía y los mismos permisos administrativos dentro de
ZEUS (paneles, comandos, callbacks y funciones administrativas cubiertas por la
política de autorización, incluidas la generación/revocación de Recovery Key y
`/zeus-bootstrap`). La autorización se comprueba siempre por ID numérico de
Telegram, no por el nombre de usuario ni por ser administrador de un grupo.
La igualdad de permisos de la aplicación no implica que Telegram ni Supabase
otorguen privilegios técnicos que no estén configurados. La propiedad técnica
persistida en la base de datos (`system_owner`) es un registro de transferencia
distinto de la autorización administrativa y no introduce jerarquías entre las
tres cuentas. Las transferencias de propiedad técnica solo pueden recaer en una
identidad ya autorizada y nunca convierten a una cuenta externa en una cuarta
identidad autorizada; recuperar una cuenta cuya identidad de Telegram cambió o
fue eliminada puede requerir volver a configurar una identidad autorizada en el
entorno. Las pruebas locales con mocks no demuestran que Telegram o Supabase
funcionen en producción.

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

1. Añadir Zeus al grupo de pruebas y concederle permisos suficientes.
2. Desde cualquiera de las tres cuentas autorizadas, enviar `/menu`.
3. Confirmar que el actor está autorizado por numeric ID y sigue siendo
   administrador del grupo objetivo.
4. Repetir con un administrador de Telegram no incluido en la lista autorizada.
5. Confirmar que recibe rechazo y no obtiene el panel ni mediante callbacks.
6. Repetir con un usuario normal y confirmar el mismo rechazo.
7. Quitar al actor autorizado del grupo o quitar al bot sus permisos y repetir.
8. Confirmar que la operación del grupo se rechaza aunque el actor global siga
   autorizado para ZEUS.

## 4.1. Comando rápido de verificadas

Selecciona el grupo con `/menu` y luego, desde el chat privado:

```text
/verificada @usuario
/verificada @usuario activar
/verificada @usuario free
/verificada <Telegram ID> revocar
```

El objetivo se resuelve con el username observado por ZEUS o con el numeric ID
que Telegram confirma en el grupo. El comando sin acción solo consulta el estado;
`activar` prepara una confirmación explícita de alta/renovación, y `free` o
`revocar` prepara una confirmación explícita de baja.

## 4.2. Moderación rápida y Lista de comandos

Los comandos de moderación se ejecutan en el grupo objetivo y requieren una
identidad autorizada por ZEUS, permisos actuales de administrador de Telegram y
los permisos de bot requeridos por cada operación:

```text
/ban <ID|@usuario> [motivo]
/mute <ID|@usuario> <duración> [motivo]
/desmute <ID|@usuario>
/unmute <ID|@usuario>
/unban <ID|@usuario>
```

También se puede responder al mensaje del objetivo para `/ban`, `/mute`,
`/desmute`, `/unmute` y `/unban`; en ese caso `/mute` recibe primero la duración. Las
duraciones de mute son minutos o sufijos `m`, `h`, `d`, de 1 a 527040 minutos.
No existe mute permanente. Los usernames solo se aceptan si coinciden
exactamente con uno observado por ZEUS; no se resuelven usernames arbitrarios.
Los resultados de moderación se envían en privado cuando Telegram lo permite.

Los comandos de ZEUS enviados en grupos se intentan borrar antes de continuar
con los handlers; el borrado no está garantizado por los límites y permisos de
Telegram. Los comandos privados no se eliminan por esta política. En `/menu`,
abre `📚 Lista de comandos` para ver sintaxis, permisos, aliases y limitaciones.
`/verificadas` es una consulta privada y paginada de solo lectura para el grupo
seleccionado.

## 5. Bootstrap de Zeus

1. Desde una de las tres cuentas autorizadas, abrir el chat privado.
2. Ejecutar:

```text
/zeus-bootstrap
```

3. Confirmar el mensaje de System Owner establecido.
4. Ejecutar el comando una segunda vez.
5. Confirmar que no reemplaza al propietario.
6. Intentar el comando desde una cuenta no autorizada.
7. Confirmar que se rechaza.
8. Intentar el comando dentro de un grupo.
9. Confirmar que se rechaza.

## 6. Recovery Key

1. Desde cualquiera de las tres cuentas autorizadas, ejecutar:

```text
/zeus-generar-recuperacion
```

2. Guardar la clave fuera de Telegram para la prueba.
3. Confirmar que Zeus solo la muestra una vez.
4. Desde otra de las tres cuentas autorizadas (o la misma, para transferirse la
   propiedad técnica), abrir el chat privado.
5. Ejecutar:

```text
/zeus-recuperar
```

También se puede iniciar desde:

```text
/menu → Ayuda → Recovery Key → Recuperar System Owner
```

6. Introducir la Recovery Key correcta.
7. Confirmar que la propiedad técnica (System Owner persistido) pasa a la cuenta indicada.
8. Confirmar que la propiedad técnica anterior queda reemplazada y que ninguna cuenta externa queda autorizada.
9. Repetir con la misma clave y confirmar el rechazo.
10. Probar una clave incorrecta y confirmar el rechazo.
11. Probar una clave revocada y confirmar el rechazo.
12. Probar un challenge expirado y confirmar el rechazo.
13. Repetir intentos fallidos hasta activar el rate limit.
14. Confirmar que un usuario bloqueado no puede iniciar otra recuperación.
15. Intentar la recuperación hacia una cuenta no autorizada y confirmar el rechazo
    auditado; recuperar una cuenta eliminada puede requerir volver a configurar
    una identidad autorizada en el entorno.

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
- La categoría Limpieza no aparece en el menú principal.
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
