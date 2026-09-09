import type { MyContext } from "../types.js";
import type { Panel } from "./panels.js";

/**
 * Edita el mensaje del panel si es posible; si no, responde de nuevo.
 */
export async function renderPanel(
  ctx: MyContext,
  panel: Panel,
): Promise<void> {
  const callbackQuery = ctx.callbackQuery;
  const message = callbackQuery?.message;
  const chatId = ctx.chat?.id;

  if (!message || !chatId) {
    await ctx.reply(panel.text, {
      reply_markup: panel.keyboard,
      parse_mode: "Markdown",
    });
    return;
  }

  try {
    await ctx.api.editMessageText(chatId, message.message_id, panel.text, {
      reply_markup: panel.keyboard,
      parse_mode: "Markdown",
    });
  } catch (error) {
    const err = error as { message?: string };
    if (err?.message?.includes("message is not modified")) {
      await ctx.answerCallbackQuery("Ya estás en esta sección.");
      return;
    }
    console.error("[PANEL] No se pudo editar el mensaje:", err?.message);
    await ctx.answerCallbackQuery("⚠️ No se pudo actualizar el panel.");
  }
}