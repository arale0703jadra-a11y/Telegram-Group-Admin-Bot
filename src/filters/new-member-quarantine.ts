import { Composer } from "grammy";
import { getGroupData } from "../storage/index.js";
import {
  deleteMessageById,
  getBotRights,
  getMemberSafely,
  isProtectedMember,
  isVerifiableMember,
} from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { isGroupChat } from "../utils/permissions.js";
import {
  containsMention,
  containsUrl,
} from "../utils/message-content.js";
import type { MyContext } from "../types.js";
import { sanitizeIncomingText } from "../utils/sanitizer.js";

export const NEW_MEMBER_QUARANTINE_MS = 48 * 60 * 60 * 1000;
export const newMemberQuarantine = new Composer<MyContext>();

export function isWithinNewMemberQuarantine(
  joinedAt: number | undefined,
  now: number,
): boolean {
  if (
    joinedAt === undefined ||
    !Number.isSafeInteger(joinedAt) ||
    joinedAt <= 0
  ) {
    return false;
  }
  const joinedAtMs = joinedAt * 1000;
  return joinedAtMs <= now && now - joinedAtMs < NEW_MEMBER_QUARANTINE_MS;
}

newMemberQuarantine.on("message", async (ctx, next) => {
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
  const joinedAt = data.indexedUsers[String(userId)]?.joinedAt;
  const hasViolation =
    containsUrl(ctx.message) ||
    containsMention(ctx.message) ||
    /https?:\/\/|www\./iu.test(
      sanitizeIncomingText(ctx.message.text ?? ctx.message.caption ?? ""),
    );
  if (!hasViolation || !isWithinNewMemberQuarantine(joinedAt, Date.now())) {
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
    await logEvent(ctx, chatId, "ANTISPAM", {
      targetId: userId,
      targetName: ctx.from.username ?? ctx.from.first_name,
      result: "error",
      detail: "NEW_MEMBER_QUARANTINE: contenido no borrado; falta can_delete_messages.",
    });
    return;
  }

  const deletion = await deleteMessageById(ctx, chatId, ctx.message.message_id);
  await logEvent(ctx, chatId, "ANTISPAM", {
    targetId: userId,
    targetName: ctx.from.username ?? ctx.from.first_name,
    result: deletion.ok ? "ok" : "error",
    detail: `NEW_MEMBER_QUARANTINE:delete=${deletion.ok};url=${containsUrl(ctx.message)};mention=${containsMention(ctx.message)}`,
  });
});
