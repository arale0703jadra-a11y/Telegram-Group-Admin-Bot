# Zeus — Production Readiness

## PASS

- Separación Zeus/Cerbero conservada.
- System Owner separado de la autorización real de Telegram.
- No existe Activation Key funcional.
- Recovery Key usa scrypt local, salt aleatorio y challenge efímero.
- El consumo de Recovery Key es de un solo uso y usa bloqueo transaccional.
- Los RPC sensibles están diseñados para `service_role`.
- La limpieza de challenges se ejecuta desde el ciclo de vida de Zeus y evita intervalos duplicados.
- El panel tiene rutas para Usuarios, Centro de Protección, Seguridad Cerbero, Filtros, Bienvenida, Actividad, Inactividad, Verificadas, Configuración, Mensajes automáticos, Limpieza y Ayuda.
- El Centro de Protección activa el modo de emergencia por 60 minutos por defecto, con duración seleccionable; miembros con entrada registrada hace menos de 48 horas reciben restricciones temporales de enlaces, invitaciones, stickers, GIFs y multimedia.
- La cuarentena elimina silenciosamente URLs, dominios y menciones de miembros durante las primeras 48 horas desde su ingreso; el guardián de administradores avisa al propietario por privado ante elevaciones no autorizadas o concesiones sospechosas de permisos.
- El reto de bienvenida honeypot es visible y personal: pausa la escritura hasta completarse o un máximo de 3 minutos; no auto-banea por silencio para evitar expulsiones erróneas. Telegram no ofrece una señal fiable para determinar si una cuenta de usuario está automatizada.
- Los saludos automáticos genéricos al unirse están desactivados y su configuración heredada se fuerza a `enabled: false`. Para eliminar un saludo antiguo que siga visible, un administrador puede buscarlo en el grupo y responder a ese mensaje con `/borrar`; la Bot API no permite recorrer el historial del chat y Telegram limita la eliminación de mensajes ordinarios a menos de 48 horas.
- El sanitizador normaliza controles, caracteres invisibles y envolturas HTML/Markdown antes del análisis textual en ZEUS y AFRODITA; el contenido no se ejecuta como HTML ni script.
- La depuración de inactividad es opt-in por grupo y evalúa candidatos con más de 21 días desde la última actividad observada; limita cada ciclo a 50 candidatos. La actividad disponible no demuestra cobertura continua, por lo que las rutas manual y automática dejan los candidatos pendientes de revisión y no expulsan miembros.
- La actividad observada se registra en `security_user_activity`; administradores, propietario y verificadas se excluyen, y los accesos de Data API quedan restringidos a `service_role`. Si Supabase falla, la limpieza automática se omite y no usa datos locales como alternativa.
- `/ayuda` ya no muestra una sección “Próximamente” ni comandos inexistentes.
- Existe checklist funcional en `TESTING_CHECKLIST.md`.
- No se modificó Supabase remoto.
- No se modificó `.env`.
- No se modificó Cerbero.
- La migración local `013_security_user_activity.sql` debe aplicarse y validarse en Supabase para registrar actividad; ZEUS no conserva metadatos de cobertura continua ni recibe de la Bot API un estado autoritativo de cuenta eliminada. El nombre visible `Deleted Account` solo genera un registro pendiente de revisión y nunca se usa para marcar o expulsar una cuenta.
- La persistencia de sesiones de usuario está implementada y probada localmente (lectura/escritura con CAS, validación de claves y tamaño de payload, cifrado AES-256-GCM de tokens de confirmación); las alertas de fallo se agrupan por incidente con un solo aviso y un aviso de recuperación. Los mensajes editados se reciben porque `allowed_updates` incluye `edited_message` y pasan por la misma detección que los mensajes nuevos.

## WARN

### Persistencia de sesiones pendiente de migración

La migración local `019_zeus_user_sessions.sql` está revisada y **no aplicada**. Hasta aplicarla y desplegar el código compatible, ZEUS no persiste sesiones: cada operación falla en modo fail-closed (PGRST202) y se emite como máximo un aviso agrupado por incidente. No declarar la persistencia operativa en producción hasta verificar en producción la desaparición de PGRST202 y la restauración de sesiones después de un reinicio.

### Pruebas end-to-end pendientes

El repositorio no contiene una prueba completa contra Telegram y Supabase que cubra bootstrap, generación, recuperación, replay, expiración y rate limit. Debe ejecutarse el checklist en un entorno de pruebas aislado.

### Pruebas PostgreSQL pendientes

No hay una instancia PostgreSQL local disponible en el entorno revisado. No se validaron con ejecución real:

- `FOR UPDATE`;
- concurrencia;
- expiración;
- invalidación de challenges;
- grants/revokes;
- RLS;
- auditoría transaccional;
- rollback.

### Auditoría de errores

Hay `catch` intencionales que convierten algunos errores en valores de fallback o continúan la operación:

- `src/menus/index.ts`: `getGroupTitle()` devuelve `undefined` si falla `getChat`.
- `src/menus/render.ts`: informa fallo de edición, pero el callback puede haber sido respondido previamente.
- `src/bot.ts`: fallos al obtener administradores se ignoran para no bloquear el evento `my_chat_member`.
- `src/commands/menu.ts`: fallo al enviar el panel privado deriva a un mensaje de ayuda en el grupo.
- `src/moderation/actions.ts`: varios fallos de permisos o de Telegram se convierten en `false`/mensajes genéricos.
- `src/menus/actions.ts`: errores de algunas operaciones Cerbero muestran mensaje al usuario; otras operaciones de Telegram tienen catch locales.

Estos catches no se modificaron en esta fase. Deben probarse con permisos insuficientes, Telegram API caída y Cerbero no disponible.

### Cobertura del panel

Los callbacks están cableados, pero la suite automatizada no recorre todos los botones con un contexto de Telegram real. La prueba de cada botón y de su persistencia depende todavía del checklist manual.

### Comandos de emergencia

Los comandos independientes implementados incluyen `/menu` y `/borrar`. Mute, unmute, ban, unban, kick y warn están disponibles desde el panel, no como comandos independientes. No deben documentarse como comandos slash hasta que exista una implementación explícita.

### Modo de emergencia

El modo se puede activar manualmente desde `/admin` → **Centro de Protección** o automáticamente al detectar una oleada de entradas. La duración usa `antiRaid.emergencyMinutes` (60 minutos por defecto y seleccionable desde el panel); Telegram restaura las restricciones temporales al vencer su `until_date`. Solo se aplican restricciones nativas a miembros con fecha de entrada observada por ZEUS; las fechas desconocidas no se interpretan como recientes. Para la aplicación completa, ZEUS necesita `can_restrict_members` y `can_delete_messages`.

## Inventario de grupos administrables

ZEUS registra únicamente chats `group` y `supergroup` donde el estado actual
del bot sea `administrator`. El registro local `data/groups.json` se carga al
arranque; los cambios de membresía del bot actualizan el inventario y los
cambios de título de grupo actualizan el nombre mostrado. El selector vuelve a
consultar el estado de ZEUS, el estado del usuario y el tipo/nombre del chat en
Telegram antes de mostrarlo. Los permisos individuales de ZEUS se conservan
como capacidades y las operaciones de moderación vuelven a verificarlos antes
de ejecutarse.

La Bot API no ofrece una operación para enumerar retrospectivamente todos los
grupos del bot. Un grupo anterior ausente del archivo solo se podrá recuperar
cuando ZEUS reciba una actualización de membresía válida o mediante un
procedimiento manual controlado: confirmar el ID del grupo y comprobar con la
Bot API que ZEUS sea administrador antes de registrarlo. `/menu` puede efectuar
esa comprobación para una identidad globalmente autorizada que también sea
administradora del grupo. No se admiten canales ni chats privados.

Las migraciones a supergrupo trasladan el registro y mueven el archivo de datos
si el destino no existe. Si ya hay datos en el destino, se conservan ambos
archivos en lugar de sobrescribirlos. Un `data/groups.json` ilegible se
mantiene intacto y no se sobrescribe automáticamente; requiere recuperación
manual. La durabilidad de `data/` depende del almacenamiento persistente del
entorno donde se ejecute ZEUS.

## BLOCK

- Aplicar la migración 008 en producción sin haberla ejecutado primero en una base de pruebas aislada.
- Probar Recovery Key real en producción antes de confirmar el flujo de recuperación y el consumo único.
- Considerar Zeus listo para producción si falla cualquiera de las pruebas de rate limit, challenge expirado, replay o concurrencia.
- Considerar el panel listo si un administrador pierde permisos y todavía puede ejecutar callbacks de grupo.
- Habilitar Cerbero en producción sin comprobar que el bot tenga los permisos Telegram requeridos.
- Liberar el bot si las operaciones con errores de Telegram o Cerbero no muestran una respuesta comprensible al administrador.

## Criterio final

Zeus puede pasar a pruebas funcionales reales en un entorno aislado. No debe declararse listo para producción hasta completar `TESTING_CHECKLIST.md`, validar la migración 008 en una base PostgreSQL de pruebas y resolver cualquier incidencia reproducible de autorización, recuperación, rate limit, concurrencia o persistencia.
