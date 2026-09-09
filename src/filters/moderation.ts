import { Composer, InlineKeyboard } from "grammy";
import { getGroupData, saveGroupData } from "../storage/index.js";
import {
  deleteMessageById,
  getMemberSafely,
  isProtectedMember,
  muteUser,
  warnUser,
} from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { OWNER_ID } from "../config.js";
import { isGroupChat } from "../utils/permissions.js";
import { scheduleMessageDeletion } from "../utils/cleanup.js";
import { buildPromotionMessage } from "./messages.js";
import { detectPromotion } from "./detector.js";
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
  if (!data.promotion.enabled || data.promotion.verifiedUsers[String(userId)]) {
    await next();
    return;
  }

  const member = await getMemberSafely(ctx, chatId, userId);
  if (OWNER_ID === userId || (member && isProtectedMember(member))) {
    await next();
    return;
  }

  const detection = detectPromotion(text, data.promotion.dictionary);
  if (detection.matches.length === 0 && !detection.hasLink) {
    await next();
    return;
  }

  const key = String(userId);
  const infraction = (data.promotion.infractions[key] ?? 0) + 1;
  data.promotion.infractions[key] = infraction;
  await saveGroupData(chatId, data);
  const shouldModerate =
    detection.hasLink || detection.clearlyPromotional || detection.matches.length >= 2;
  const muteMinutes =
    data.promotion.recurrenceMuteMinutes[
      Math.min(infraction - 1, data.promotion.recurrenceMuteMinutes.length - 1)
    ] ?? 0;

  const warning = await warnUser(
    ctx,
    chatId,
    userId,
    ctx.from.first_name,
    `Promoción detectada: ${detection.matches.join(", ") || "enlace"}`,
  );
  const deletion = shouldModerate
    ? await deleteMessageById(ctx, chatId, ctx.message.message_id)
    : { ok: false };
  let muted = false;
  if (shouldModerate && muteMinutes > 0) {
    muted = (await muteUser(ctx, chatId, userId, muteMinutes, ctx.from.first_name)).ok;
  }

  await logEvent(ctx, chatId, "DELETE", {
    targetId: userId,
    targetName: ctx.from.first_name,
    result: deletion.ok ? "ok" : "error",
    detail: `Promoción detectada (${detection.matches.join(", ") || "enlace"})`,
  });

  try {
    await ctx.api.sendMessage(
      userId,
      buildPromotionMessage(
        data.promotion,
        muted ? "muted" : detection.hasLink ? "link" : "warning",
      ),
    );
  } catch {
    const brief = muted
      ? buildPromotionMessage(data.promotion, "muted")
      : buildPromotionMessage(data.promotion, "removed");
    const reply = await ctx.reply(brief, {
      reply_markup: new InlineKeyboard().url(
        "🔐 Abrir bot",
        `https://t.me/${ctx.me.username}`,
      ),
    });
    scheduleMessageDeletion(ctx, chatId, reply.message_id);
  }
  if (!warning.ok) {
    console.error(`[PROMOTION] No se pudo registrar advertencia userId=${userId}`);
  }
  await next();
});
