import { Composer, InlineKeyboard } from "grammy";
import {
  buildVerifiedRecordsPanel,
  buildQuickVerifiedActivationConfirmPanel,
  buildQuickVerifiedRevokeConfirmPanel,
} from "../menus/panels.js";
import { isAuthorizedPanelUser } from "../security/panel-authorization.js";
import { isActiveVerifiedRecord } from "../services/verified-user-policy.js";
import { createVerifiedConfirmation } from "../services/verified-confirmations.js";
import {
  getVerifiedUserRecord,
  getVerifiedUsersListingPage,
} from "../services/verified-users.js";
import {
  isActiveVerifiedGroupMember,
  resolveVerifiedUserInput,
  VerifiedUserRegistrationError,
} from "../services/verified-user-registration.js";
import { getGroupData } from "../storage/index.js";
import { isUserAdminOf } from "../utils/permissions.js";
import type { MyContext } from "../types.js";
import { COMMANDS } from "./definitions.js";

export type QuickVerifiedAction = "activate" | "free" | "revoke";

export interface ParsedQuickVerifiedCommand {
  target: string;
  action?: QuickVerifiedAction;
}

export function parseQuickVerifiedCommand(
  input: string,
): ParsedQuickVerifiedCommand | undefined {
  const parts = input.trim().split(/\s+/u).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return undefined;
  const target = parts[0];
  if (!target || (!/^\d+$/u.test(target) && !/^@[A-Za-z0-9_]{1,32}$/u.test(target))) {
    return undefined;
  }
  if (parts.length === 1) return { target };

  const action = parts[1]?.toLocaleLowerCase();
  if (action === "activar") return { target, action: "activate" };
  if (action === "free") return { target, action: "free" };
  if (action === "revocar") return { target, action: "revoke" };
  return undefined;
}

/**
 * Identidad objetivo al responder a un mensaje con /verificada: solo cuentas
 * de personas reales (nunca bots, canales ni mensajes de grupo anónimos).
 */
export function resolveVerificadaReplyTarget(
  reply:
    | { from?: { id?: number; is_bot?: boolean } | undefined; sender_chat?: unknown }
    | undefined,
): number | undefined {
  const from = reply?.from;
  if (!from || reply?.sender_chat) return undefined;
  if (from.is_bot) return undefined;
  if (typeof from.id !== "number" || !Number.isSafeInteger(from.id) || from.id <= 0) {
    return undefined;
  }
  return from.id;
}

async function replyVerifiedCommandPrivately(
  ctx: MyContext,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  if (ctx.chat?.type === "private") {
    await ctx.reply(text, keyboard
      ? { reply_markup: keyboard, parse_mode: "Markdown" }
      : undefined);
    return;
  }
  if (!ctx.from) return;

  let sentPrivately = false;
  try {
    await ctx.api.sendMessage(ctx.from.id, text, {
      ...(keyboard ? { reply_markup: keyboard } : {}),
      parse_mode: "Markdown",
    });
    sentPrivately = true;
  } catch (error) {
    console.error(
      `[VERIFIED_COMMAND] No se pudo enviar respuesta privada error=${error instanceof Error ? error.name : "unknown"}`,
    );
  }
  if (sentPrivately) {
    try {
      await ctx.reply("📩 La información se envió al chat privado con ZEUS.");
    } catch (error) {
      console.error(
        `[VERIFIED_COMMAND] No se pudo enviar aviso grupal error=${error instanceof Error ? error.name : "unknown"}`,
      );
    }
    return;
  }

  let username = ctx.me?.username;
  if (!username) {
    try {
      username = (await ctx.api.getMe()).username;
    } catch (error) {
      console.error(
        `[VERIFIED_COMMAND] No se pudo obtener el enlace privado error=${error instanceof Error ? error.name : "unknown"}`,
      );
    }
  }
  const startLink = username && /^[A-Za-z0-9_]{5,32}$/u.test(username)
    ? ` https://t.me/${username}?start=menu`
    : "";
  await ctx.reply(
    `🔒 Para proteger la información, la respuesta no se publica en el grupo. ` +
      `Abre el chat privado de ZEUS${startLink} y pulsa Start (Iniciar); después repite /verificada.`,
  );
}

export const verifiedCommand = new Composer<MyContext>();

verifiedCommand.command(COMMANDS.verificadas, async (ctx) => {
  if (ctx.chat?.type !== "private" || !ctx.from) return;
  if (!(await isAuthorizedPanelUser(ctx.from.id))) {
    await ctx.reply("⛔ No autorizado para consultar verificadas.");
    return;
  }
  const groupId = ctx.session.user.selectedGroupId;
  if (typeof groupId !== "number" || !Number.isSafeInteger(groupId)) {
    await ctx.reply("Selecciona primero el grupo con /menu.");
    return;
  }
  if (!(await isUserAdminOf(ctx, groupId))) {
    await ctx.reply("⛔ Ya no eres administrador de ese grupo.");
    return;
  }
  try {
    const searchTerm = ctx.match.trim();
    if (searchTerm.length > 64) {
      await ctx.reply("La búsqueda admite hasta 64 caracteres.");
      return;
    }
    ctx.session.user.selectedVerifiedSearch = searchTerm || undefined;
    const records = await getVerifiedUsersListingPage(
      groupId,
      0,
      ctx.session.user.selectedVerifiedSearch,
    );
    const panel = buildVerifiedRecordsPanel(
      records.users,
      0,
      ctx.session.user.selectedGroupTitle,
      new Date(),
      ctx.session.user.selectedVerifiedSearch,
      records.totalCount,
      true,
    );
    await ctx.reply(panel.text, {
      reply_markup: panel.keyboard,
      parse_mode: "Markdown",
    });
  } catch (error) {
    console.error(
      `[VERIFIED_LIST] No se pudo cargar groupId=${groupId} error=${error instanceof Error ? error.name : "unknown"}`,
    );
    await ctx.reply("⚠️ No se pudo cargar la lista; no se modificó ningún registro.");
  }
});

verifiedCommand.command(COMMANDS.verificada, async (ctx) => {
  const isPrivate = ctx.chat?.type === "private";
  const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  if ((!isPrivate && !isGroup) || !ctx.from) {
    return;
  }
  if (!(await isAuthorizedPanelUser(ctx.from.id))) {
    await ctx.reply("⛔ No autorizado para administrar verificadas.");
    return;
  }

  const replyTarget = resolveVerificadaReplyTarget(ctx.message?.reply_to_message);
  const input = ctx.match.trim() || (replyTarget !== undefined ? String(replyTarget) : "");
  const groupId = isPrivate ? ctx.session.user.selectedGroupId : ctx.chat.id;
  if (typeof groupId !== "number" || !Number.isSafeInteger(groupId)) {
    await replyVerifiedCommandPrivately(
      ctx,
      "Selecciona primero el grupo con /menu; la operación no se ejecutó.",
    );
    return;
  }
  if (!(await isUserAdminOf(ctx, groupId))) {
    await replyVerifiedCommandPrivately(ctx, "⛔ Ya no eres administrador de ese grupo.");
    return;
  }

  if (isGroup) {
    ctx.session.user.selectedGroupId = groupId;
    ctx.session.user.selectedGroupTitle = "title" in ctx.chat
      ? ctx.chat.title
      : undefined;
    ctx.session.user.selectedVerifiedSearch = undefined;
  }
  const parsed = parseQuickVerifiedCommand(input);
  if (!parsed) {
    await replyVerifiedCommandPrivately(
      ctx,
      "Uso: /verificada @usuario [activar|free|revocar] o /verificada <Telegram ID> [activar|free|revocar]. " +
      "Primero selecciona el grupo con /menu.",
    );
    return;
  }

  try {
    const data = await getGroupData(groupId);
    const member = await resolveVerifiedUserInput(
      ctx.api,
      groupId,
      parsed.target,
      Object.values(data.indexedUsers),
    );
    if (member.user.is_bot || !isActiveVerifiedGroupMember(member)) {
      await ctx.reply("⛔ El objetivo no es una persona que permanezca en el grupo.");
      return;
    }

    const record = await getVerifiedUserRecord(groupId, member.user.id);
    const active = isActiveVerifiedRecord(record);
    const displayName = [
      member.user.first_name,
      "last_name" in member.user ? member.user.last_name : undefined,
    ].filter(Boolean).join(" ") || `ID ${member.user.id}`;
    const groupTitle = ctx.session.user.selectedGroupTitle;

    if (!parsed.action) {
      const currentStatus = active
        ? "verificada activa"
        : record?.revoked_at
          ? "revocada"
          : record?.verified && record.valid_until &&
              Date.parse(record.valid_until) <= Date.now()
            ? "vencida"
            : record
              ? "inactiva"
              : "free";
      await replyVerifiedCommandPrivately(
        ctx,
        `Grupo: ${groupTitle ?? groupId}\nUsuaria: ${displayName}` +
          `${member.user.username ? ` (@${member.user.username})` : ""}\n` +
          `ID: ${member.user.id}\nEstado: ${currentStatus}\n\n` +
          "Usa /verificada @usuario activar para preparar un alta/renovación, " +
          "o /verificada @usuario free para preparar una revocación.",
      );
      return;
    }

    if (parsed.action === "activate") {
      if (active) {
        await replyVerifiedCommandPrivately(ctx, "ℹ️ La usuaria ya está verificada y vigente; no se modificó su vigencia.");
        return;
      }
      const reactivate = Boolean(record);
      const confirmationToken = createVerifiedConfirmation(
        ctx,
        groupId,
        member.user.id,
        reactivate ? "reactivate" : "activate",
      );
      const panel = buildQuickVerifiedActivationConfirmPanel({
        groupId,
        userId: member.user.id,
        displayName,
        username: member.user.username,
        reactivate,
        groupTitle,
        confirmationToken,
      });

      await replyVerifiedCommandPrivately(ctx, panel.text, panel.keyboard);
      return;
    }

    if (!record?.verified || record.revoked_at !== null) {
      await replyVerifiedCommandPrivately(ctx, "ℹ️ No hay un registro de verificación que convertir a free.");
      return;
    }
    const confirmationToken = createVerifiedConfirmation(
      ctx,
      groupId,
      member.user.id,
      "revoke",
    );
    const panel = buildQuickVerifiedRevokeConfirmPanel({
      groupId,
      userId: member.user.id,
      displayName,
      username: member.user.username,
      groupTitle,
      confirmationToken,
    });
    await replyVerifiedCommandPrivately(ctx, panel.text, panel.keyboard);
  } catch (error) {
    if (error instanceof VerifiedUserRegistrationError) {
      await replyVerifiedCommandPrivately(ctx, `⛔ ${error.message}`);
      return;
    }
    console.error(
      `[VERIFIED_COMMAND] Falló userId=${ctx.from.id} groupId=${groupId} error=${error instanceof Error ? error.name : "unknown"}`,
    );
    await replyVerifiedCommandPrivately(ctx, "⚠️ No se pudo comprobar el objetivo; no se realizó ningún cambio.");
  }
});
