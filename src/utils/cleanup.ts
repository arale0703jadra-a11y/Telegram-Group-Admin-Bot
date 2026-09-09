import type { MyContext } from "../types.js";

const AUTO_DELETE_SECONDS = 5;

/**
 * Elimina un mensaje del grupo pasados unos segundos, si el bot tiene
 * permisos y Telegram lo permite. Los errores se ignoran silenciosamente
 * (mensaje demasiado antiguo, chat sin permisos, etc.).
 */
export function scheduleMessageDeletion(
  ctx: MyContext,
  chatId: number,
  messageId: number,
  seconds: number = AUTO_DELETE_SECONDS,
): void {
  setTimeout(() => {
    ctx.api.deleteMessage(chatId, messageId).catch(() => {
      /* sin permisos o mensaje antiguo: se ignora */
    });
  }, seconds * 1000);
}