import { Composer, InlineKeyboard } from "grammy";
import { getGroupData, saveGroupData } from "../storage/index.js";
import {
  deleteMessageById,
  getMemberSafely,
  isVerifiableMember,
  muteUser,
  warnUser,
} from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { OWNER_ID } from "../config.js";
import { isGroupChat } from "../utils/permissions.js";
import { buildPromotionMessage } from "./messages.js";
import { detectPromotion } from "./detector.js";
import {
  scheduleMessageDeletion,
  WARNING_AUTO_DELETE_SECONDS,
} from "../utils/cleanup.js";
import type { MyContext } from "../types.js";

export const promotionModeration = new Composer<MyContext>();

promotionModeration.on("message", async (ctx, next) => {
  if (
    !isGroupChat(ctx) ||
    !ctx.from ||
    ctx.from.is_bot ||
    ctx.from.id === ctx.me.id ||
    !ctx.message
  ) {
    await next();
    return;
  }
  const text = ctx.message.text ?? ctx.message.caption ?? "";
  if (!text || text.startsWith("/")) {
    await next();
    return;
  }

  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const data = await getGroupData(chatId);
  if (!data.promotion.enabled) {
    await next();
    return;
  }

  const member = await getMemberSafely(ctx, chatId, userId);
  if (
    !member ||
    member.user.is_bot ||
    !isVerifiableMember(member) ||
    OWNER_ID === userId
  ) {
    await logEvent(ctx, chatId, "DELETE", {
      targetId: userId,
      targetName: ctx.from.first_name,
      result: "error",
      detail: "Moderación automática omitida: miembro no verificable o protegido.",
    });
    await next();
    return;
  }

  const verified = data.promotion.verifiedUsers[String(userId)] === true;
  const detection = detectPromotion(text, data.promotion.dictionary, { verified });
  data.promotion.statistics.analyzed += 1;
  switch (detection.intent) {
    case "BUYING":
      data.promotion.statistics.buying += 1;
      break;
    case "SELLING":
      data.promotion.statistics.selling += 1;
      if (verified) data.promotion.statistics.allowedVerified += 1;
      break;
    case "NEUTRAL":
      data.promotion.statistics.neutral += 1;
      break;
    case "AMBIGUOUS":
      data.promotion.statistics.ambiguous += 1;
      break;
  }
  await saveGroupData(chatId, data);
  if (!detection.shouldModerate) {
    await next();
    return;
  }

  const key = String(userId);
  const infraction = (data.promotion.infractions[key] ?? 0) + 1;
  data.promotion.infractions[key] = infraction;
  await saveGroupData(chatId, data);
  const muteMinutes =
    data.promotion.recurrenceMuteMinutes[
      Math.min(infraction - 2, data.promotion.recurrenceMuteMinutes.length - 1)
    ] ?? 0;

  const warning = await warnUser(
    ctx,
    chatId,
    userId,
    ctx.from.first_name,
    `Promoción detectada: ${detection.sellingSignals.join(", ") || detection.reason}`,
  );
  const deletion = await deleteMessageById(ctx, chatId, ctx.message.message_id);
  if (deletion.ok) {
    data.promotion.statistics.blocked += 1;
    await saveGroupData(chatId, data);
  }
  let muted = false;
  if (infraction >= 2 && muteMinutes > 0) {
    muted = (await muteUser(ctx, chatId, userId, muteMinutes, ctx.from.first_name)).ok;
  }

  await logEvent(ctx, chatId, "DELETE", {
    targetId: userId,
    targetName: ctx.from.first_name,
    result: deletion.ok ? "ok" : "error",
    detail: `Promoción detectada (${detection.matches.join(", ") || "enlace"})`,
  });

  if (deletion.ok) {
    const warningMessage = await ctx.reply(
      buildPromotionMessage(data.promotion, muted ? "muted" : "removed"),
      {
        reply_markup: new InlineKeyboard().url(
          "🔐 Verifícate",
          `https://t.me/${ctx.me.username}`,
        ),
      },
    );
    scheduleMessageDeletion(
      ctx,
      chatId,
      warningMessage.message_id,
      WARNING_AUTO_DELETE_SECONDS,
    );
  }
  if (!warning.ok) {
    console.error(`[PROMOTION] No se pudo registrar advertencia userId=${userId}`);
  }
  await next();
});
