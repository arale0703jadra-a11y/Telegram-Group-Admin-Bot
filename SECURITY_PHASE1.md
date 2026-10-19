# ZEUS — Fase 1: integración de protecciones y resistencia a errores de API

Documento de la Fase 1 de la auditoría de seguridad. Registra el estado real
de los módulos, las correcciones aplicadas y las decisiones que quedan
pendientes de coordinación. No contiene secretos ni credenciales.

## 1. Orden real de middleware en `src/bot.ts` (verificado)

1. `sessionMiddleware`
2. `bot.catch` (registro de errores)
3. `cleanServiceMessages` (`src/commands/clean-service-messages.ts`) — borra
   mensajes de servicio de incorporación en grupos (`new_chat_members` y
   `community_chat_joined`). Es mejor esfuerzo: si el bot no tiene
   `can_delete_messages` o Telegram devuelve un error (incluido 429), se
   registra el código de error una sola vez y **no se reintenta**. Siempre
   llama a `next()`, por lo que no interfiere con la bienvenida
   (`commands/welcome.ts`), el indexado de miembros (`bot.on("message")`) ni
   el anti-raid (`filters/anti-raid.ts`), que reciben la misma actualización
   aunque el mensaje se borre.
4. Indexado de usuarios y mensajes recientes (`bot.on("message")`)
5. `antiRaid`
6. `antiSpam`
7. `illegalModeration`
8. `promotionModeration`
9. `registerCommands` (start, ayuda, menu, moderación, entrada privada,
   bienvenida, zeus)
10. `menuNavigation` y `moderationActions` (callbacks del panel)

## 2. Resistencia a errores de la API (riesgo H1 corregido)

**Problema confirmado en la auditoría:** cada filtro llamaba a `getChatMember`
varias veces por mensaje; con errores 429 los filtros se omitían
(fallo en abierto) justo durante oleadas de spam.

**Corrección aplicada** en `src/utils/member-cache.ts` (módulo puro, sin
dependencias de grammY/config/almacenamiento), integrado en:

- `moderation/actions.ts` → `getMemberSafely` (caché 10 s) y `getBotRights`
  (caché 60 s). Firmas exportadas sin cambios.
- `utils/permissions.ts` → `checkUserAdminOf` (caché 10 s).

Comportamiento:

- Caché con caducidad (TTL) y cota de entradas (evictión FIFO). Solo se
  cachean respuestas correctas; los errores nunca se cachean.
- Ante un 429 se pausan las consultas del chat durante `retry_after`
  (tope 30 s) sin dormir hilos ni reintentar en bucle; se registra una
  advertencia por pausa.
- Política de errores explícita: la **autorización deniega** ante cualquier
  fallo (nunca se concede permiso por defecto); las **sanciones automáticas
  omiten** la acción si no hay respuesta verificable (no se sanciona a quien
  no se pudo verificar). Los filtros que omiten ante fallo de membresía:
  `filters/moderation.ts` (promoción), `filters/anti-spam.ts`,
  `filters/illegal-moderation.ts` (excepto el tramo crítico, que aún así
  necesita derechos verificados), `services/inactivity.ts`.
- `invalidateSecurityCaches(chatId, userId?)` queda disponible para futuras
  invalidaciones desde `my_chat_member` (pendiente de coordinación con
  `bot.ts`, ver §5).

## 3. Módulos verificados y decisiones pendientes (no conectados a ciegas)

| Módulo | Estado real | Acción |
| --- | --- | --- |
| `filters/verified-permissions.ts` | No registrado en `bot.ts`; requeriría Supabase por mensaje y duplicaría el borrado de mensajes ya cubierto por otros filtros. | Pendiente de decisión explícita. |
| `services/automatic-messages.ts` | No registrado; su scheduler no se arranca. | Pendiente de decisión. |
| `services/group-registration.ts` | No registrado; el activo es `group-registry.ts`. | Candidato a eliminación (decisión pendiente). |
| `AntiRaidEngine.isRecentMember` | Definido pero nunca invocado; `newAccountRestrictionMinutes` no tiene efecto. | Pendiente de decisión (usar o retirar la opción). |
| Delegación CERBERO (`SECURITY_EXECUTION_MODE=cerbero`) | `delegateSecurityCommand` solo se invoca desde `verified-permissions.ts` (no registrado); el modo no tiene efecto hoy. | Pendiente de decisión. |
| `middleware/error-handler.ts` (`errorBoundary`) | Definido pero no usado. | Candidato a eliminación. |

Los módulos anti-raid (`anti-raid.ts`, `anti-raid-engine.ts`, `exemptions.ts`)
sí están registrados y compilados en `dist/`.

## 4. Medios y salidas de miembros

Capacidad real de inspección (Bot API), documentada en
`src/utils/message-signals.ts`: texto y entidades, leyendas de medios
(`caption` + `caption_entities`) y `file_id` de fotos, vídeos, animaciones,
documentos, audio, voz, video_notas y stickers. El anti-spam cubre: rate
límite, enlaces, invitaciones, menciones, medios repetidos (misma clave de
archivo) y textos repetidos (umbral: ≥3 palabras comunes y ≥80 % de
solapamiento).

**No se afirma detección de lo que no se puede inspeccionar**: contenido
embebido en imágenes/documentos (OCR), contenido de enlaces y el interior de
archivos no son analizables con la API de bots. Los álbumes llegan como
mensajes individuales con `media_group_id` y se cubren por las señales de
repetición y rate límite. El bot no interfiere con las funciones de denuncia
de Telegram; solo retira mensajes propios del grupo según su configuración.

**Salida de miembros (`left_chat_member`)**: sin handler hoy. Propuesta
lista, pendiente de coordinar el registro en `bot.ts`: registrar la baja en
`indexedUsers`/eventos del grupo sin sanciones ni juicios, reutilizando el
índice existente.

## 5. Permisos del bot

Necesarios: `can_delete_messages` (retirada de contenido y limpieza de
servicio) y `can_restrict_members` (warn/mute/ban e inactividad). Se derivan
con `getBotRights` (ahora con caché 60 s) y se degradan a denegado si no se
pueden verificar. No se requieren permisos adicionales.

## 6. Pruebas añadidas en esta fase

- `tests/member-cache.test.ts`: TTL, cota, borrado exacto, cooldown 429 con
  `retry_after`, no cachear errores, recuperación, derechos del bot,
  invalidación.
- `tests/clean-service-messages-isolated.test.ts`: solo borra mensajes de
  servicio de incorporación en grupos; no toca mensajes normales ni privados;
  `next()` siempre se ejecuta; errores 403/429 reportados una vez sin
  reintentos.
- `tests/message-signals.test.ts`: claves de medios por tipo, foto de mayor
  tamaño, ausencia en texto, coincidencia de medios repetidos y umbral de
  similitud de textos.

Todas son aisladas: usan APIs falsas inyectadas, no leen `.env`, no contactan
con Telegram ni escriben en `data/`.
