import { Composer } from "grammy";
import { logEvent } from "../moderation/events.js";
import { isGroupChat } from "../utils/permissions.js";
import type { MyContext } from "../types.js";

const REVIEW_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const lastReviewNotice = new Map<string, number>();

export function isDeletedTelegramAccount(user: {
  first_name: string;
  last_name?: string;
  username?: string;
}): boolean {
  // Telegram exposes this as mutable profile text, not as verified deletion evidence.
  return (
    user.first_name === "Deleted Account" &&
    !user.last_name &&
    !user.username
  );
}

function shouldLogReview(chatId: number, userId: number, now: number): boolean {
  const key = `${chatId}:${userId}`;
  const previous = lastReviewNotice.get(key);
  if (previous !== undefined && now - previous < REVIEW_NOTICE_INTERVAL_MS) {
    return false;
  }
  if (lastReviewNotice.size >= 500) {
    const oldest = lastReviewNotice.keys().next();
    if (!oldest.done) lastReviewNotice.delete(oldest.value);
  }
  lastReviewNotice.set(key, now);
  return true;
}

export const deletedAccounts = new Composer<MyContext>();

deletedAccounts.on("message", async (ctx, next) => {
  if (
    !isGroupChat(ctx) ||
    !ctx.message ||
    !ctx.from ||
    ctx.from.is_bot ||
    !isDeletedTelegramAccount(ctx.from)
  ) {
    await next();
    return;
  }

  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  if (shouldLogReview(chatId, userId, Date.now())) {
    await logEvent(ctx, chatId, "INACTIVITY_SCAN", {
      targetId: userId,
      result: "queued",
      detail:
        "pending_review: perfil con nombre visible «Deleted Account»; " +
        "Telegram no proporciona evidencia verificable de eliminación. No se tomó ninguna acción.",
    });
  }
  await next();
});
