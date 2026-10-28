import { Composer } from "grammy";
import type { User } from "@grammyjs/types";
import { isGroupChat, isUserAdmin } from "../utils/permissions.js";
import {
  banUser,
  deleteMessageById,
  getBotRights,
  getMemberSafely,
  isProtectedModerationTarget,
  muteUser,
  unbanUser,
  unmuteUser,
} from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { scheduleMessageDeletion } from "../utils/cleanup.js";
import { buildUserCardPanel } from "../menus/panels.js";
import { getUserCard } from "../utils/users.js";
import type { MyContext } from "../types.js";
import { getGroupData } from "../storage/index.js";
import { isAuthorizedPanelUser } from "../security/panel-authorization.js";
import { COMMANDS } from "./definitions.js";
import { invalidateSecurityCaches } from "../utils/member-cache.js";
import type { IndexedUser } from "../storage/types.js";

/**
 * Comandos de moderación ejecutados DENTRO del grupo.
 * Se aplican respondiendo (reply) al mensaje objetivo y se
 * auto-eliminan para mantener el grupo limpio.
 */
export const moderationCommand = new Composer<MyContext>();

const MAX_MUTE_MINUTES = 527040;

export function parseMuteDuration(value: string): number | undefined {
  const match = /^([1-9]\d*)(m|h|d)?$/iu.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const multiplier = match[2]?.toLocaleLowerCase() === "h"
    ? 60
    : match[2]?.toLocaleLowerCase() === "d"
      ? 1440
      : 1;
  const minutes = amount * multiplier;
  return Number.isSafeInteger(minutes) && minutes <= MAX_MUTE_MINUTES
    ? minutes
    : undefined;
}

export function cleanModerationReason(value: string): string | undefined {
  const reason = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/gu, "[redactado]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/gu, "[redactado]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
  return reason || undefined;
}

async function authorizeGroupModerator(ctx: MyContext): Promise<number | undefined> {
  if (!isGroupChat(ctx) || !ctx.chat || !ctx.from) return undefined;
  invalidateSecurityCaches(ctx.chat.id);
  if (!(await isAuthorizedPanelUser(ctx.from.id))) return undefined;
  return (await isUserAdmin(ctx)) ? ctx.chat.id : undefined;
}

async function notifyActor(ctx: MyContext, text: string): Promise<void> {
  if (!ctx.from) return;
  try {
    await ctx.api.sendMessage(ctx.from.id, text);
  } catch (error) {
    console.warn(
      `[MODERATION_COMMAND] No se pudo enviar respuesta privada userId=${ctx.from.id} ` +
        `error=${error instanceof Error ? error.name : "unknown"}`,
    );
  }
}

interface CommandTarget {
  id: number;
  name: string;
}

export function findExactObservedUsername(
  users: IndexedUser[],
  targetInput: string,
): number | undefined {
  if (!/^@[A-Za-z0-9_]{1,32}$/u.test(targetInput)) return undefined;
  const username = targetInput.slice(1).toLocaleLowerCase();
  const matches = users.filter(
    (user) => user.username?.toLocaleLowerCase() === username,
  );
  return matches.length === 1 ? matches[0]?.id : undefined;
}

async function resolveCommandTarget(
  ctx: MyContext,
  groupId: number,
  targetInput: string | undefined,
  replyUser: User | undefined,
): Promise<CommandTarget | undefined> {
  if (replyUser) {
    if (!Number.isSafeInteger(replyUser.id) || replyUser.id <= 0 || replyUser.is_bot) {
      return undefined;
    }
    return {
      id: replyUser.id,
      name: [replyUser.first_name, replyUser.last_name].filter(Boolean).join(" ") ||
        replyUser.username ||
        String(replyUser.id),
    };
  }
  if (!targetInput) return undefined;
  if (/^\d+$/u.test(targetInput)) {
    const id = Number(targetInput);
    if (!Number.isSafeInteger(id) || id <= 0) return undefined;
    const member = await getMemberSafely(ctx, groupId, id);
    return member
      ? {
          id,
          name: [member.user.first_name, member.user.last_name].filter(Boolean).join(" ") ||
            member.user.username ||
            String(id),
        }
      : { id, name: String(id) };
  }
  if (!/^@[A-Za-z0-9_]{1,32}$/u.test(targetInput)) return undefined;
  const username = targetInput.slice(1).toLocaleLowerCase();
  const data = await getGroupData(groupId);
  const userId = findExactObservedUsername(
    Object.values(data.indexedUsers),
    targetInput,
  );
  if (userId === undefined) return undefined;
  const member = await getMemberSafely(ctx, groupId, userId);
  if (
    !member ||
    member.user.username?.toLocaleLowerCase() !== username
  ) {
    return undefined;
  }
  return {
    id: member.user.id,
    name: [member.user.first_name, member.user.last_name].filter(Boolean).join(" ") ||
      member.user.username ||
      String(member.user.id),
  };
}

function splitCommandTarget(match: string): { target?: string; rest: string[] } {
  const parts = match.trim().split(/\s+/u).filter(Boolean);
  return { target: parts[0], rest: parts.slice(1) };
}

async function runBan(ctx: MyContext): Promise<void> {
  const groupId = await authorizeGroupModerator(ctx);
  if (groupId === undefined || !ctx.message || !ctx.chat) return;
  if (!ctx.from) return;
  const match = typeof ctx.match === "string" ? ctx.match : "";
  const { target: targetInput, rest } = splitCommandTarget(match);
  const replied = ctx.message.reply_to_message?.from;
  const target = await resolveCommandTarget(ctx, groupId, replied ? undefined : targetInput, replied);
  const reason = cleanModerationReason((replied ? match : rest.join(" ")).trim());
  if (!target || (!replied && targetInput && !/^\d+$/u.test(targetInput) && !/^@[A-Za-z0-9_]{1,32}$/u.test(targetInput))) {
    await notifyActor(ctx, "Uso: /ban <ID|@usuario> [motivo] o responde al usuario con /ban [motivo].");
    return;
  }
  if (await isProtectedModerationTarget(ctx, groupId, target.id)) {
    await notifyActor(ctx, "⛔ No se puede banear a esta persona.");
    return;
  }
  const result = await banUser(ctx, groupId, target.id, target.name, reason);
  await notifyActor(
    ctx,
    result.ok
      ? `✅ Ban aplicado a ${target.name}${reason ? ` (motivo: ${reason})` : ""}.`
      : `⛔ ${result.error ?? "No se pudo completar el ban."}`,
  );
}

async function runMute(ctx: MyContext): Promise<void> {
  const groupId = await authorizeGroupModerator(ctx);
  if (groupId === undefined || !ctx.message || !ctx.chat) return;
  if (!ctx.from) return;
  const { target: targetInput, rest } = splitCommandTarget(
    typeof ctx.match === "string" ? ctx.match : "",
  );
  const replied = ctx.message.reply_to_message?.from;
  const durationText = replied ? targetInput : rest[0];
  const minutes = durationText ? parseMuteDuration(durationText) : undefined;
  if (minutes === undefined) {
    await notifyActor(ctx, "Uso: /mute <ID|@usuario> <duración> [motivo] o responde con /mute <duración> [motivo]. Duración: 1m, 2h, 3d o minutos; máximo 527040 minutos.");
    return;
  }
  const target = await resolveCommandTarget(ctx, groupId, replied ? undefined : targetInput, replied);
  if (!target) {
    await notifyActor(ctx, "No se pudo resolver el objetivo. Usa un ID o un @username exacto observado por ZEUS.");
    return;
  }
  if (await isProtectedModerationTarget(ctx, groupId, target.id)) {
    await notifyActor(ctx, "⛔ No se puede silenciar a esta persona.");
    return;
  }
  const reason = cleanModerationReason(
    (replied ? rest.join(" ") : rest.slice(1).join(" ")).trim(),
  );
  const result = await muteUser(ctx, groupId, target.id, minutes, target.name, reason);
  await notifyActor(
    ctx,
    result.ok
      ? `✅ Silencio aplicado a ${target.name} durante ${minutes} minutos${reason ? ` (motivo: ${reason})` : ""}.`
      : `⛔ ${result.error ?? "No se pudo completar el silencio."}`,
  );
}

async function runUnmute(ctx: MyContext): Promise<void> {
  const groupId = await authorizeGroupModerator(ctx);
  if (groupId === undefined || !ctx.message) return;
  if (!ctx.from) return;
  const { target: targetInput, rest } = splitCommandTarget(
    typeof ctx.match === "string" ? ctx.match : "",
  );
  if (rest.length || (ctx.message.reply_to_message && targetInput)) {
    await notifyActor(ctx, "Uso: /desmute <ID|@usuario> o responde al usuario. /unmute es un alias.");
    return;
  }
  const target = await resolveCommandTarget(
    ctx,
    groupId,
    ctx.message.reply_to_message ? undefined : targetInput,
    ctx.message.reply_to_message?.from,
  );
  if (!target) {
    await notifyActor(ctx, "No se pudo resolver el objetivo.");
    return;
  }
  const result = await unmuteUser(ctx, groupId, target.id, target.name);
  await notifyActor(
    ctx,
    result.ok ? `✅ Silencio retirado a ${target.name}.` : `⛔ ${result.error ?? "No se pudo retirar el silencio."}`,
  );
}

async function runUnban(ctx: MyContext): Promise<void> {
  const groupId = await authorizeGroupModerator(ctx);
  if (groupId === undefined || !ctx.message) return;
  if (!ctx.from) return;
  const { target: targetInput, rest } = splitCommandTarget(
    typeof ctx.match === "string" ? ctx.match : "",
  );
  if (rest.length || (ctx.message.reply_to_message && targetInput)) {
    await notifyActor(ctx, "Uso: /unban <ID|@usuario> o responde a un mensaje del usuario baneado.");
    return;
  }
  const target = await resolveCommandTarget(
    ctx,
    groupId,
    ctx.message.reply_to_message ? undefined : targetInput,
    ctx.message.reply_to_message?.from,
  );
  if (!target) {
    await notifyActor(ctx, "No se pudo resolver el objetivo. Para usernames, usa uno observado previamente por ZEUS.");
    return;
  }
  const result = await unbanUser(ctx, groupId, target.id, target.name);
  await notifyActor(
    ctx,
    result.ok
      ? `✅ Ban retirado a ${target.name}; no se le añadió al grupo.`
      : `ℹ️ ${result.error ?? "No se pudo retirar el ban."}`,
  );
}

moderationCommand.command(COMMANDS.ban, runBan);
moderationCommand.command(COMMANDS.mute, runMute);
moderationCommand.command(COMMANDS.desmute, runUnmute);
moderationCommand.command(COMMANDS.unmute, runUnmute);
moderationCommand.command(COMMANDS.unban, runUnban);

moderationCommand.command(COMMANDS.borrar, async (ctx) => {
  if (!isGroupChat(ctx)) {
    await ctx.reply(
      "🗑️ Usa /borrar dentro del grupo, respondiendo al mensaje que quieras eliminar. " +
        "Para retirar una bienvenida antigua de ZEUS, responde a esa bienvenida con /borrar.",
    );
    return;
  }

  const chatId = ctx.chat.id;
  const command = ctx.message;
  if (!command) {
    return;
  }

  if (!(await authorizeGroupModerator(ctx))) {
    return;
    return;
  }

  const target = command.reply_to_message;
  if (!target) {
    await notifyActor(
      ctx,
      "💬 Responde al mensaje que quieres borrar y vuelve a escribir /borrar. " +
        "También puedes usarlo para eliminar una bienvenida antigua de ZEUS.",
    );
    return;
  }

  const { canDelete } = await getBotRights(ctx, chatId);
  if (!canDelete) {
    await notifyActor(ctx, "⛔ El bot no tiene permisos para borrar mensajes en este grupo.");
    return;
  }

  const result = await deleteMessageById(ctx, chatId, target.message_id);

  await logEvent(ctx, chatId, "DELETE", {
    targetId: target.from?.id,
    targetName: target.from?.first_name,
    result: result.ok ? "ok" : "error",
    detail: result.ok ? `Mensaje ${target.message_id}` : result.error,
  });

  if (result.ok) {
    await notifyActor(ctx, "🗑️ Mensaje borrado.");
  } else {
    await notifyActor(ctx, `⚠️ ${result.error ?? "No se pudo borrar el mensaje."}`);
  }
});

moderationCommand.command(COMMANDS.buscar, async (ctx) => {
  if (!isGroupChat(ctx)) {
    await ctx.reply("🔎 Usa /buscar dentro del grupo, respondiendo al mensaje del usuario.");
    return;
  }

  const chatId = ctx.chat.id;
  const command = ctx.message;
  if (!command) {
    return;
  }

  if (!(await authorizeGroupModerator(ctx))) {
    await sendEphemeral(ctx, "⛔ Solo los administradores del grupo pueden buscar usuarios.");
    return;
  }

  const target = command.reply_to_message;
  if (!target?.from) {
    await sendEphemeral(ctx, "💬 Responde al mensaje del usuario y escribe /buscar.");
    return;
  }

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