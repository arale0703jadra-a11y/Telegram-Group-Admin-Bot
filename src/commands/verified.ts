import { Composer } from "grammy";
import {
  buildVerifiedRecordsPanel,
  buildQuickVerifiedActivationConfirmPanel,
  buildQuickVerifiedRevokeConfirmPanel,
} from "../menus/panels.js";
import { isAuthorizedPanelUser } from "../security/panel-authorization.js";
import { isActiveVerifiedRecord } from "../services/verified-user-policy.js";
import {
  getVerifiedUserRecord,
  getVerifiedUsersForListing,
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
    const records = await getVerifiedUsersForListing(groupId);
    const panel = buildVerifiedRecordsPanel(
      records,
      0,
      ctx.session.user.selectedGroupTitle,
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
  if (ctx.chat?.type !== "private" || !ctx.from) {
    return;
  }
  if (!(await isAuthorizedPanelUser(ctx.from.id))) {
    await ctx.reply("⛔ No autorizado para administrar verificadas.");
    return;
  }

  const groupId = ctx.session.user.selectedGroupId;
  if (typeof groupId !== "number" || !Number.isSafeInteger(groupId)) {
    await ctx.reply("Selecciona primero el grupo con /menu; la operación no se ejecutó.");
    return;
  }
  if (!(await isUserAdminOf(ctx, groupId))) {
    await ctx.reply("⛔ Ya no eres administrador de ese grupo.");
    return;
  }

  const parsed = parseQuickVerifiedCommand(ctx.match);
  if (!parsed) {
    await ctx.reply(
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
      await ctx.reply(
        `Grupo: ${groupTitle ?? groupId}\nUsuaria: ${displayName}` +
          `${member.user.username ? ` (@${member.user.username})` : ""}\n` +
          `ID: ${member.user.id}\nEstado: ${active ? "verificada activa" : record ? "inactiva/free" : "free"}\n\n` +
          "Usa /verificada @usuario activar para preparar un alta/renovación, " +
          "o /verificada @usuario free para preparar una revocación.",
      );
      return;
    }

    if (parsed.action === "activate") {
      if (active) {
        await ctx.reply("ℹ️ La usuaria ya está verificada y vigente; no se modificó su vigencia.");
        return;
      }
      const panel = buildQuickVerifiedActivationConfirmPanel({
        groupId,
        userId: member.user.id,
        displayName,
        username: member.user.username,
        reactivate: Boolean(record),
        groupTitle,
      });

      await ctx.reply(panel.text, { reply_markup: panel.keyboard, parse_mode: "Markdown" });
      return;
    }

    if (!record?.verified || record.revoked_at !== null) {
      await ctx.reply("ℹ️ No hay un registro de verificación que convertir a free.");
      return;
    }
    const panel = buildQuickVerifiedRevokeConfirmPanel({
      groupId,
      userId: member.user.id,
      displayName,
      username: member.user.username,
      groupTitle,
    });
    await ctx.reply(panel.text, { reply_markup: panel.keyboard, parse_mode: "Markdown" });
  } catch (error) {
    if (error instanceof VerifiedUserRegistrationError) {
      await ctx.reply(`⛔ ${error.message}`);
      return;
    }
    console.error(
      `[VERIFIED_COMMAND] Falló userId=${ctx.from.id} groupId=${groupId} error=${error instanceof Error ? error.name : "unknown"}`,
    );
    await ctx.reply("⚠️ No se pudo comprobar el objetivo; no se realizó ningún cambio.");
  }
});
