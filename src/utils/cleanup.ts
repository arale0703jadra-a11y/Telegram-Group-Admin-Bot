import type { MyContext } from "../types.js";

export const WARNING_AUTO_DELETE_SECONDS = 15;

/**
 * Elimina un mensaje del grupo pasados unos segundos, si el bot tiene
 * permisos y Telegram lo permite. Los errores se ignoran silenciosamente
 * (mensaje demasiado antiguo, chat sin permisos, etc.).
 */
export function scheduleMessageDeletion(
  ctx: MyContext,
  chatId: number,
  messageId: number,
  seconds: number = WARNING_AUTO_DELETE_SECONDS,
): void {
  setTimeout(() => {
    ctx.api.deleteMessage(chatId, messageId).catch(() => {
      /* sin permisos o mensaje antiguo: se ignora */
    });
  }, seconds * 1000);
}

export async function replyWithAutoDelete(
  ctx: MyContext,
  text: string,
  seconds = WARNING_AUTO_DELETE_SECONDS,
): Promise<void> {
  const chatId = ctx.chat?.id;
  const message = await ctx.reply(text);
  if (chatId !== undefined) {
    scheduleMessageDeletion(ctx, chatId, message.message_id, seconds);
  }
}