import { Composer } from "grammy";
import { isGroupChat, isUserAdmin } from "../utils/permissions.js";
import {
  deleteMessageById,
  getBotRights,
} from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { scheduleMessageDeletion } from "../utils/cleanup.js";
import { buildUserCardPanel } from "../menus/panels.js";
import { getUserCard } from "../utils/users.js";
import type { MyContext } from "../types.js";

/**
 * Comandos de moderación ejecutados DENTRO del grupo.
 * Se aplican respondiendo (reply) al mensaje objetivo y se
 * auto-eliminan para mantener el grupo limpio.
 */
export const moderationCommand = new Composer<MyContext>();

moderationCommand.command("borrar", async (ctx) => {
  if (!isGroupChat(ctx)) {
    await ctx.reply("🗑️ Usa /borrar dentro del grupo, respondiendo al mensaje a borrar.");
    return;
  }

  const chatId = ctx.chat.id;
  const command = ctx.message;
  if (!command) {
    return;
  }

  if (!(await isUserAdmin(ctx))) {
    await sendEphemeral(ctx, "⛔ Solo los administradores del grupo pueden borrar mensajes.");
    return;
  }

  const target = command.reply_to_message;
  if (!target) {
    await sendEphemeral(ctx, "💬 Responde al mensaje que quieres borrar y vuelve a escribir /borrar.");
    return;
  }

  const { canDelete } = await getBotRights(ctx, chatId);
  if (!canDelete) {
    await deleteMessageById(ctx, chatId, command.message_id);
    await sendEphemeral(ctx, "⛔ El bot no tiene permisos para borrar mensajes en este grupo.");
    return;
  }

  const result = await deleteMessageById(ctx, chatId, target.message_id);
  // El comando del administrador también se elimina del grupo.
  await deleteMessageById(ctx, chatId, command.message_id);

  await logEvent(ctx, chatId, "DELETE", {
    targetId: target.from?.id,
    targetName: target.from?.first_name,
    result: result.ok ? "ok" : "error",
    detail: result.ok ? `Mensaje ${target.message_id}` : result.error,
  });

  if (result.ok) {
    await sendEphemeral(ctx, "🗑️ Mensaje borrado.");
  } else {
    await sendEphemeral(ctx, `⚠️ ${result.error ?? "No se pudo borrar el mensaje."}`);
  }
});

moderationCommand.command("buscar", async (ctx) => {
  if (!isGroupChat(ctx)) {
    await ctx.reply("🔎 Usa /buscar dentro del grupo, respondiendo al mensaje del usuario.");
    return;
  }

  const chatId = ctx.chat.id;
  const command = ctx.message;
  if (!command) {
    return;
  }

  if (!(await isUserAdmin(ctx))) {
    await sendEphemeral(ctx, "⛔ Solo los administradores del grupo pueden buscar usuarios.");
    return;
  }

  const target = command.reply_to_message;
  if (!target?.from) {
    await sendEphemeral(ctx, "💬 Responde al mensaje del usuario y escribe /buscar.");
    return;
  }

  scheduleMessageDeletion(ctx, chatId, command.message_id, 1);

  const panel = buildUserCardPanel(
    await getUserCard(ctx, chatId, target.from.id, ctx.chat.title),
  );

  try {
    await ctx.api.sendMessage(ctx.from.id, panel.text, {
      reply_markup: panel.keyboard,
      parse_mode: "Markdown",
    });
  } catch {
    await sendEphemeral(
      ctx,
      "ℹ️ Abre el bot en privado (pulsa /start) y repite la búsqueda para ver la ficha del usuario.",
    );
  }
});

/**
 * Mensaje breve en el grupo que se auto-elimina pasados unos segundos.
 */
async function sendEphemeral(ctx: MyContext, text: string): Promise<void> {
  const chatId = ctx.chat?.id;
  const reply = await ctx.reply(text);
  if (chatId) {
    scheduleMessageDeletion(ctx, chatId, reply.message_id);
  }
}