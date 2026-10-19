import { Composer } from "grammy";
import { getGroupData, saveGroupData } from "../storage/index.js";
import {
  deleteMessageById,
  getBotRights,
  getMemberSafely,
  isVerifiableMember,
} from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { isGroupChat } from "../utils/permissions.js";
import {
  AntiRaidEngine,
  activateEmergency,
  expireEmergencyIfNeeded,
} from "./anti-raid-engine.js";
import { isExemptFromAutomaticSanction } from "./exemptions.js";
import type { MyContext } from "../types.js";

const engine = new AntiRaidEngine();

export const antiRaid = new Composer<MyContext>();

function getText(ctx: MyContext): string {
  return ctx.message?.text ?? ctx.message?.caption ?? "";
}

/**
 * Detección de oleadas de entradas (raids).
 *
 * Cuando varias cuentas entran al grupo en muy poco tiempo, se considera una
 * oleada y, si está configurado, se activa el modo de emergencia durante una
 * ventana para endurecer los límites. No se sanciona a nadie por el simple
 * hecho de haber entrado; solo se restringe la actividad sospechosa.
 */
antiRaid.on("message:new_chat_members", async (ctx, next) => {
  if (!isGroupChat(ctx) || !ctx.from || !ctx.message) {
    await next();
    return;
  }
  const data = await getGroupData(ctx.chat.id);
  if (!data.antiRaid.enabled) {
    await next();
    return;
  }
  const now = Date.now();
  data.emergency = expireEmergencyIfNeeded(data.emergency, now);

  const joined = (ctx.message.new_chat_members ?? []).filter(
    (member) => !member.is_bot,
  );
  if (joined.length === 0) {
    await next();
    return;
  }

  let raid = false;
  let joinsInWindow = 0;
  for (const _person of joined) {
    const result = engine.recordJoin(ctx.chat.id, now, data.antiRaid);
    joinsInWindow = result.joinsInWindow;
    raid = raid || result.raid;
  }

  if (raid && data.antiRaid.emergencyOnRaid && !data.emergency.active) {
    data.emergency = activateEmergency(
      data.emergency,
      "oleada-de-entradas",
      now,
      data.antiRaid.emergencyMinutes,
    );
    await saveGroupData(ctx.chat.id, data);
    await logEvent(ctx, ctx.chat.id, "ANTIRAID", {
      result: "ok",
      detail: `Oleada de entradas detectada (${joinsInWindow} en ${data.antiRaid.joinWindowSeconds}s). Modo de emergencia activado.`,
    });
    await next();
    return;
  }

  await saveGroupData(ctx.chat.id, data);
  await next();
});

/**
 * Detección de actividad coordinada: el mismo mensaje enviado por varios
 * usuarios distintos en poco tiempo (típico de raids de spam). Se elimina el
 * mensaje coordinado cuando el bot puede borrar; los administradores y
 * cuentas de confianza quedan exentos.
 */
antiRaid.on("message", async (ctx, next) => {
  if (
    !isGroupChat(ctx) ||
    !ctx.from ||
    ctx.from.is_bot ||
    ctx.from.id === ctx.me.id ||
    !ctx.message ||
    "new_chat_members" in ctx.message
  ) {
    await next();
    return;
  }
  const text = getText(ctx);
  if (!text || text.startsWith("/")) {
    await next();
    return;
  }

  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const data = await getGroupData(chatId);
  if (!data.antiRaid.enabled) {
    await next();
    return;
  }
  const now = Date.now();
  data.emergency = expireEmergencyIfNeeded(data.emergency, now);

  const member = await getMemberSafely(ctx, chatId, userId);
  const exempt =
    !member ||
    member.user.is_bot ||
    !isVerifiableMember(member) ||
    isExemptFromAutomaticSanction(data, userId, member);
  if (exempt) {
    await saveGroupData(chatId, data);
    await next();
    return;
  }

  const result = engine.recordCoordinatedMessage(
    chatId,
    userId,
    text,
    now,
    data.antiRaid,
  );
  if (!result.coordinated) {
    await saveGroupData(chatId, data);
    await next();
    return;
  }

  const rights = await getBotRights(ctx, chatId);
  const deletion = rights.canDelete
    ? await deleteMessageById(ctx, chatId, ctx.message.message_id)
    : { ok: false };
  await logEvent(ctx, chatId, "ANTIRAID", {
    targetId: userId,
    result: deletion.ok ? "ok" : "error",
    detail: `Actividad coordinada: mensaje idéntico de ${result.distinctUsers} usuarios; delete=${deletion.ok}.`,
  });
  await saveGroupData(chatId, data);
  await next();
});
