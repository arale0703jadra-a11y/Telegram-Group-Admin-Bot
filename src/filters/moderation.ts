import { Composer, InlineKeyboard } from "grammy";
import { getGroupData, saveGroupData } from "../storage/index.js";
import {
  deleteMessageById,
  getMemberSafely,
  isVerifiableMember,
  muteUser,
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
import { getVerifiedUserPermissions } from "../services/verified-users.js";
import { sanitizeIncomingText } from "../utils/sanitizer.js";
import { CooldownTracker, KeyedMutex } from "../utils/safety.js";

const sanctionMutex = new KeyedMutex();
const muteCooldown = new CooldownTracker();
const MUTE_COOLDOWN_MS = 60 * 1000;

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
  const text = sanitizeIncomingText(ctx.message.text ?? ctx.message.caption ?? "");
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

  const verifiedPermissions = await getVerifiedUserPermissions(chatId, userId);
  const verified = verifiedPermissions?.bypass_promotion_filter === true;
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

  const deletion = await deleteMessageById(ctx, chatId, ctx.message.message_id);
  const firstName = ctx.from.first_name;
  let muted = false;
  if (deletion.ok) {
    // Serializa la sanción por chat para no duplicar infractions/silencios.
    await sanctionMutex.runExclusive(String(chatId), async () => {
      data.promotion.statistics.blocked += 1;
      const key = String(userId);
      const infraction = (data.promotion.infractions[key] ?? 0) + 1;
      data.promotion.infractions[key] = infraction;
      await saveGroupData(chatId, data);

      const ladder = data.promotion.recurrenceMuteMinutes;
      const canMuteNow =
        ladder.length > 0 &&
        infraction >= 2 &&
        muteCooldown.shouldApply(
          `${chatId}:${userId}:promotion`,
          Date.now(),
          MUTE_COOLDOWN_MS,
        );
      if (canMuteNow) {
        const minutes =
          ladder[Math.min(infraction - 2, ladder.length - 1)] ??
          ladder[ladder.length - 1]!;
        muted = (await muteUser(ctx, chatId, userId, minutes, firstName)).ok;
      }
    });
  }

  await logEvent(ctx, chatId, "DELETE", {
    targetId: userId,
    targetName: firstName,
    result: deletion.ok ? "ok" : "error",
    detail: `Promoción detectada (${detection.matches.join(", ") || "enlace"}); mute=${muted}`,
  });

  if (deletion.ok) {
    const verificationMessage = await ctx.reply(
      buildPromotionMessage(data.promotion),
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
      verificationMessage.message_id,
      WARNING_AUTO_DELETE_SECONDS,
    );
    if (muted) {
      // Solo se anuncia el silencio cuando la sanción se aplicó realmente.
      const mutedMessage = await ctx.reply(data.promotion.messages.promotionMuted);
      scheduleMessageDeletion(
        ctx,
        chatId,
        mutedMessage.message_id,
        WARNING_AUTO_DELETE_SECONDS,
      );
    }
  }
  await next();
});
