import { Composer } from "grammy";
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
import { detectPromotion } from "./detector.js";
import type { MyContext } from "../types.js";
import {
  delegateSecurityCommand,
  isCerberoExecutionEnabled,
} from "../services/security-commands.js";
import {
  getVerifiedUserPermissions,
  isVerifiedUser,
} from "../services/verified-users.js";
import { shouldSkipPromotionFilter } from "../services/verified-user-policy.js";

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
  if (shouldSkipPromotionFilter(data.promotion.enabled, false)) {
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

  let verified: boolean;
  let verifiedPermissions;
  try {
    verified = await isVerifiedUser(chatId, userId);
    verifiedPermissions = await getVerifiedUserPermissions(chatId, userId);
  } catch (error) {
    console.error(
      `[PROMOTION] No se pudo consultar la verificación userId=${userId}; se omite moderación:`,
      error,
    );
    await next();
    return;
  }

  const detectorVerified =
    verified || verifiedPermissions?.bypass_promotion_filter === true;
  const detection = detectPromotion(
    text,
    data.promotion.dictionary,
    { verified: detectorVerified },
  );
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

  const reason =
    `Promoción SELLING detectada: ` +
    `${detection.sellingSignals.join(", ") || detection.reason}`;
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
    const deleteOrder = await delegateSecurityCommand({
      groupId: chatId,
      action: "DELETE_MESSAGE",
      targetMessageId: ctx.message.message_id,
      payload: { reason },
    });
    deletion = { ok: deleteOrder.ok };
  } else {
    warning = await warnUser(
      ctx,
      chatId,
      userId,
      ctx.from.first_name,
      reason,
    );
    deletion = await deleteMessageById(ctx, chatId, ctx.message.message_id);
  }
  if (infraction >= 2 && muteMinutes > 0) {
    if (isCerberoExecutionEnabled()) {
      await delegateSecurityCommand({
        groupId: chatId,
        action: "MUTE_USER",
        targetUserId: userId,
        payload: { duration_minutes: muteMinutes, reason },
      });
    } else {
      await muteUser(ctx, chatId, userId, muteMinutes, ctx.from.first_name);
    }
  }

  await logEvent(ctx, chatId, "DELETE", {
    targetId: userId,
    targetName: ctx.from.first_name,
    result: deletion.ok ? "ok" : "error",
    detail: `Promoción SELLING detectada (${detection.sellingSignals.join(", ") || detection.reason})`,
  });

  if (deletion.ok) {
    try {
      const latestData = await getGroupData(chatId);
      latestData.promotion.statistics.blocked += 1;
      await saveGroupData(chatId, latestData);
    } catch (error) {
      console.error(
        `[PROMOTION] No se pudo actualizar estadísticas de bloqueo chatId=${chatId}:`,
        error,
      );
    }

    try {
      await ctx.api.sendMessage(
        chatId,
        "🔒 Para promocionarte en este grupo necesitas estar verificada con:\n\n" +
          "@Alexiita_Babyy\n" +
          "@CRONOSgp4\n" +
          "@ChrisUzca2406",
      );
    } catch (error) {
      console.error(
        `[PROMOTION] No se pudo enviar el aviso de verificación userId=${userId}:`,
        error,
      );
    }
  }

  if (!warning.ok) {
    console.error(`[PROMOTION] No se pudo registrar advertencia userId=${userId}`);
  }
  await next();
});
