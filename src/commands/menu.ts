import { Composer, InlineKeyboard } from "grammy";
import { isGroupChat, isUserAdmin } from "../utils/permissions.js";
import { buildMainPanel } from "../menus/panels.js";
import {
  markUserAsAdmin,
  registerGroup,
} from "../services/group-registry.js";
import { scheduleMessageDeletion } from "../utils/cleanup.js";
import { openPrivatePanel } from "../utils/private-panel.js";
import type { MyContext } from "../types.js";

export const menuCommand = new Composer<MyContext>();

menuCommand.command("menu", async (ctx) => {
  const from = ctx.from;
  const chat = ctx.chat;
  const username = ctx.me.username;

  if (!isGroupChat(ctx)) {
    // En privado, el panel se abre directamente (igual que /start).
    await openPrivatePanel(ctx);
    return;
  }

  if (!from) {
    const denial = await ctx.reply(
      "⛔ Lo siento, no tienes permisos para usar este comando.\n" +
        "Esta acción solo está disponible para administradores del grupo.",
    );
    scheduleMessageDeletion(ctx, chat.id, denial.message_id);
    if (ctx.message) {
      scheduleMessageDeletion(ctx, chat.id, ctx.message.message_id);
    }
    return;
  }

  const groupId = chat.id;
  const groupTitle = chat.title ?? "";
  const botLink = `https://t.me/${username}`;

  // El administrador gestiona ahora este grupo en su chat privado.
  ctx.session.user = {
    selectedGroupId: groupId,
    selectedGroupTitle: groupTitle,
  };

  const panel = buildMainPanel(groupTitle);
  const openButton = new InlineKeyboard().url("🔐 Abrir bot", botLink);
  const authorization = isUserAdmin(ctx);
  const delivery = ctx.api.sendMessage(from.id, panel.text, {
    reply_markup: panel.keyboard,
    parse_mode: "Markdown",
  }).then((message) => ({ message, error: undefined }))
    .catch((error: unknown) => ({ message: undefined, error }));
  const sent = await delivery;

  if (!sent.message) {
    console.warn(
      `[MENU] No se pudo enviar el panel privado userId=${from.id} groupId=${groupId} errorType=${sent.error instanceof Error ? sent.error.name : typeof sent.error}`,
    );
  }

  if (ctx.message) {
    scheduleMessageDeletion(ctx, groupId, ctx.message.message_id);
  }

  void authorization.then((isAdmin) => {
    if (isAdmin) {
      registerGroup(groupId, groupTitle);
      markUserAsAdmin(groupId, from.id);
      if (!sent.message) {
        void sendEphemeralGroupMessage(
          ctx,
          groupId,
          "🔐 Abre el bot en privado para continuar.",
          openButton,
        ).catch((error: unknown) => {
          console.error(
            `[MENU] no se pudo enviar el aviso privado groupId=${groupId} userId=${from.id} error=${error instanceof Error ? error.name : "unknown"}`,
          );
        });
      }
      return;
    }
    if (sent.message) {
      void ctx.api.deleteMessage(from.id, sent.message.message_id).catch((error: unknown) => {
        console.error(
          `[MENU] No se pudo retirar el panel de un usuario no administrador groupId=${groupId} userId=${from.id} error=${error instanceof Error ? error.name : "unknown"}`,
        );
      });
    }
    console.warn(`[MENU] acceso denegado groupId=${groupId} userId=${from.id}`);
  }).catch((error: unknown) => {
    console.error(
      `[MENU] falló la autorización en segundo plano groupId=${groupId} userId=${from.id} error=${error instanceof Error ? error.name : "unknown"}`,
    );
    if (sent.message) {
      void ctx.api.deleteMessage(from.id, sent.message.message_id).catch((deleteError: unknown) => {
        console.error(
          `[MENU] no se pudo retirar el panel tras fallar autorización groupId=${groupId} userId=${from.id} error=${deleteError instanceof Error ? deleteError.name : "unknown"}`,
        );
      });
    }
  });

  // Elimina también el mensaje "/menu" para mantener el grupo limpio.
});

/**
 * Envía un mensaje breve al grupo y lo elimina tras unos segundos,
 * manteniendo el grupo limpio.
 */
async function sendEphemeralGroupMessage(
  ctx: MyContext,
  chatId: number,
  text: string,
  keyboard?: InlineKeyboard,
  parseMode?: "Markdown",
): Promise<void> {
  const reply = await ctx.reply(text, {
    reply_markup: keyboard,
    parse_mode: parseMode,
  });
  scheduleMessageDeletion(ctx, chatId, reply.message_id);
}