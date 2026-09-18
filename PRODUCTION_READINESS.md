# Zeus — Production Readiness

## PASS

- Separación Zeus/Cerbero conservada.
- System Owner separado de la autorización real de Telegram.
- No existe Activation Key funcional.
- Recovery Key usa scrypt local, salt aleatorio y challenge efímero.
- El consumo de Recovery Key es de un solo uso y usa bloqueo transaccional.
- Los RPC sensibles están diseñados para `service_role`.
- La limpieza de challenges se ejecuta desde el ciclo de vida de Zeus y evita intervalos duplicados.
- El panel tiene rutas para Usuarios, Seguridad Cerbero, Filtros, Bienvenida, Actividad, Inactividad, Verificadas, Configuración, Mensajes automáticos, Limpieza y Ayuda.
- `/ayuda` ya no muestra una sección “Próximamente” ni comandos inexistentes.
- Existe checklist funcional en `TESTING_CHECKLIST.md`.
- No se modificó Supabase remoto.
- No se modificó `.env`.
- No se modificó Cerbero.

## WARN

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

## BLOCK

- Aplicar la migración 008 en producción sin haberla ejecutado primero en una base de pruebas aislada.
- Probar Recovery Key real en producción antes de confirmar el flujo de recuperación y el consumo único.
- Considerar Zeus listo para producción si falla cualquiera de las pruebas de rate limit, challenge expirado, replay o concurrencia.
- Considerar el panel listo si un administrador pierde permisos y todavía puede ejecutar callbacks de grupo.
- Habilitar Cerbero en producción sin comprobar que el bot tenga los permisos Telegram requeridos.
- Liberar el bot si las operaciones con errores de Telegram o Cerbero no muestran una respuesta comprensible al administrador.

## Criterio final

Zeus puede pasar a pruebas funcionales reales en un entorno aislado. No debe declararse listo para producción hasta completar `TESTING_CHECKLIST.md`, validar la migración 008 en una base PostgreSQL de pruebas y resolver cualquier incidencia reproducible de autorización, recuperación, rate limit, concurrencia o persistencia.
