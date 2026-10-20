import { Composer } from "grammy";
import { getGroupData, saveGroupData } from "../storage/index.js";
import type { MyContext } from "../types.js";
import {
  deleteMessageById,
  getBotRights,
  getMemberSafely,
  isProtectedMember,
  isVerifiableMember,
} from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { isGroupChat } from "../utils/permissions.js";
import { containsEmergencyMedia, containsUrl } from "../utils/message-content.js";
import {
  expireEmergencyIfNeeded,
  isEmergencyActive,
  isRecentEmergencyMember,
} from "./anti-raid-engine.js";

export const emergencyLockdown = new Composer<MyContext>();

emergencyLockdown.on("message", async (ctx, next) => {
  if (
    !isGroupChat(ctx) ||
    !ctx.from ||
    ctx.from.is_bot ||
    !ctx.message
  ) {
    await next();
    return;
  }

  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const data = await getGroupData(chatId);
  const now = Date.now();
  const previousEmergency = data.emergency;
  data.emergency = expireEmergencyIfNeeded(data.emergency, now);
  if (data.emergency !== previousEmergency) {
    await saveGroupData(chatId, data);
  }

  if (!isEmergencyActive(data.emergency, now)) {
    await next();
    return;
  }

  const tracked = data.indexedUsers[String(userId)];
  if (
    !isRecentEmergencyMember(tracked?.joinedAt, now) ||
    (!containsUrl(ctx.message) && !containsEmergencyMedia(ctx.message))
  ) {
    await next();
    return;
  }

  const member = await getMemberSafely(ctx, chatId, userId);
  if (
    !member ||
    !isVerifiableMember(member) ||
    isProtectedMember(member)
  ) {
    await next();
    return;
  }

  const rights = await getBotRights(ctx, chatId);
  if (!rights.canDelete) {
    await logEvent(ctx, chatId, "ANTIRAID", {
      targetId: userId,
      targetName: ctx.from.username ?? ctx.from.first_name,
      result: "error",
      detail: "Emergency lockdown: no fue posible borrar contenido restringido; falta can_delete_messages.",
    });
    return;
  }

  const deletion = await deleteMessageById(ctx, chatId, ctx.message.message_id);
  await logEvent(ctx, chatId, "ANTIRAID", {
    targetId: userId,
    targetName: ctx.from.username ?? ctx.from.first_name,
    result: deletion.ok ? "ok" : "error",
    detail: `EMERGENCY_LOCKDOWN:delete=${deletion.ok};url=${containsUrl(ctx.message)};media=${containsEmergencyMedia(ctx.message)}`,
  });
});
