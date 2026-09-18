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
import { isGroupChat } from "../utils/permissions.js";
import { buildPromotionMessage } from "./messages.js";
import { detectPromotion } from "./detector.js";
import type { MyContext } from "../types.js";
import {
  delegateSecurityCommand,
  isCerberoExecutionEnabled,
} from "../services/security-commands.js";
import { getVerifiedUserPermissions } from "../services/verified-users.js";

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
  const verifiedPermissions = await getVerifiedUserPermissions(chatId, userId);
  if (
    !data.promotion.enabled ||
    data.promotion.verifiedUsers[String(userId)] ||
    verifiedPermissions?.bypass_promotion_filter
  ) {
    await next();
    return;
  }

  const member = await getMemberSafely(ctx, chatId, userId);
  if (
    !member ||
    member.user.is_bot ||
    !isVerifiableMember(member) ||
    false
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
      Math.min(infraction - 2, data.promotion.recurrenceMuteMinutes.length - 1)
    ] ?? 0;

  const reason = `Promoción detectada: ${detection.matches.join(", ") || "enlace"}`;
  let warning = { ok: true };
  let deletion = { ok: false };
  if (isCerberoExecutionEnabled()) {
    const warningOrder = await delegateSecurityCommand({
      groupId: chatId,
      action: "WARN_USER",
      targetUserId: userId,
      payload: { reason, warn_limit: data.warnLimit, warn_action: data.warnAction },
    });
    warning = { ok: warningOrder.ok };
    if (shouldModerate) {
      const deleteOrder = await delegateSecurityCommand({
        groupId: chatId,
        action: "DELETE_MESSAGE",
        targetMessageId: ctx.message.message_id,
        payload: { reason },
      });
      deletion = { ok: deleteOrder.ok };
    }
  } else {
    warning = await warnUser(
      ctx,
      chatId,
      userId,
      ctx.from.first_name,
      reason,
    );
    deletion = shouldModerate
      ? await deleteMessageById(ctx, chatId, ctx.message.message_id)
      : { ok: false };
  }
  let muted = false;
  if (shouldModerate && infraction >= 2 && muteMinutes > 0) {
    if (isCerberoExecutionEnabled()) {
      const muteOrder = await delegateSecurityCommand({
        groupId: chatId,
        action: "MUTE_USER",
        targetUserId: userId,
        payload: { duration_minutes: muteMinutes, reason },
      });
      muted = muteOrder.ok;
    } else {
      muted = (await muteUser(ctx, chatId, userId, muteMinutes, ctx.from.first_name)).ok;
    }
  }

  await logEvent(ctx, chatId, "DELETE", {
    targetId: userId,
    targetName: ctx.from.first_name,
    result: deletion.ok ? "ok" : "error",
    detail: `Promoción detectada (${detection.matches.join(", ") || "enlace"})`,
  });

  await ctx.reply(
    buildPromotionMessage(
      data.promotion,
      muted ? "muted" : detection.hasLink ? "link" : "removed",
    ),
    {
      reply_markup: new InlineKeyboard().url(
        "🔐 Verifícate",
        `https://t.me/${ctx.me.username}`,
      ),
    },
  );
  if (!warning.ok) {
    console.error(`[PROMOTION] No se pudo registrar advertencia userId=${userId}`);
  }
  await next();
});
