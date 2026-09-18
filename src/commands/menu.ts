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
import { ensureCerberoBinding } from "../services/security-commands.js";

export const menuCommand = new Composer<MyContext>();

export function isMenuTrigger(text: string, botUsername?: string): boolean {
  const normalized = text.trim();
  if (/^menu$/i.test(normalized)) {
    return true;
  }
  const commandMatch = normalized.match(/^\/menu(?:@([A-Za-z0-9_]+))?$/i);
  if (!commandMatch) {
    return false;
  }
  return (
    !commandMatch[1] ||
    (botUsername !== undefined &&
      commandMatch[1].toLowerCase() === botUsername.toLowerCase())
  );
}

menuCommand.on("message:text", async (ctx, next) => {
  if (!isMenuTrigger(ctx.message.text, ctx.me.username)) {
    await next();
    return;
  }

  const from = ctx.from;
  const chat = ctx.chat;
  const username = ctx.me.username;

  if (ctx.chat?.type === "private") {
    // La autorización privada se resuelve por ctx.from.id y los grupos registrados.
    await openPrivatePanel(ctx);
    return;
  }

  if (!isGroupChat(ctx)) {
    await ctx.reply("🔐 El panel administrativo solo está disponible en el chat privado del bot.");
    return;
  }

  // El comando solo puede usarlo un administrador del grupo.
  if (!from || !(await isUserAdmin(ctx))) {
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

  registerGroup(groupId, groupTitle);
  await ensureCerberoBinding(groupId);
  markUserAsAdmin(groupId, from.id);

  // El administrador gestiona ahora este grupo en su chat privado.
  ctx.session.user = {
    selectedGroupId: groupId,
    selectedGroupTitle: groupTitle,
  };

  const panel = buildMainPanel(groupTitle);
  const openButton = new InlineKeyboard().url("🔐 Abrir bot", botLink);

  let sentToPrivate = false;
  try {
    await ctx.api.sendMessage(from.id, panel.text, {
      reply_markup: panel.keyboard,
      parse_mode: "Markdown",
    });
    sentToPrivate = true;
  } catch {
    sentToPrivate = false;
  }

  if (!sentToPrivate) {
    await sendEphemeralGroupMessage(
      ctx,
      groupId,
      "🔐 Abre el bot en privado para continuar.",
      openButton,
    );
  }

  // Elimina también el mensaje "/menu" para mantener el grupo limpio.
  if (ctx.message) {
    scheduleMessageDeletion(ctx, groupId, ctx.message.message_id);
  }
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