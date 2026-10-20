import { Composer } from "grammy";
import { callWithRetryAfter } from "../utils/safety.js";
import type { MyContext } from "../types.js";

interface ServiceMessageContext {
  chat: {
    id: number;
    type: string;
  };
  message: {
    message_id: number;
  };
  api: {
    deleteMessage(chatId: number | string, messageId: number): Promise<unknown>;
  };
}

const TELEGRAM_SERVICE_MESSAGE_FIELDS = [
  "new_chat_members",
  "user_shared",
  "users_shared",
  "connected_website",
  "community_chat_joined",
  "left_chat_member",
  "new_chat_title",
  "new_chat_photo",
  "delete_chat_photo",
  "group_chat_created",
  "supergroup_chat_created",
  "channel_chat_created",
  "migrate_to_chat_id",
  "migrate_from_chat_id",
  "pinned_message",
  "write_access_allowed",
  "proximity_alert_triggered",
  "forum_topic_created",
  "forum_topic_edited",
  "forum_topic_closed",
  "forum_topic_reopened",
  "general_forum_topic_hidden",
  "general_forum_topic_unhidden",
  "video_chat_started",
  "video_chat_ended",
  "video_chat_participants_invited",
  "boost_added",
  "chat_background_set",
  "giveaway_created",
  "giveaway_completed",
  "giveaway_winners",
  "gift",
  "gift_upgrade_sent",
  "unique_gift",
  "paid_message_price_changed",
  "direct_message_price_changed",
  "video_chat_scheduled",
  "checklist_tasks_done",
  "checklist_tasks_added",
  "community_chat_added",
  "community_chat_removed",
  "chat_owner_left",
  "chat_owner_changed",
  "managed_bot_created",
  "poll_option_added",
  "poll_option_deleted",
  "message_auto_delete_timer_changed",
  "suggested_post_approved",
  "suggested_post_approval_failed",
  "suggested_post_declined",
  "suggested_post_paid",
  "suggested_post_refunded",
  "successful_payment",
  "refunded_payment",
] as const;

export function isTelegramServiceMessage(message: object): boolean {
  return TELEGRAM_SERVICE_MESSAGE_FIELDS.some((field) => {
    if (!Object.hasOwn(message, field)) return false;
    const value: unknown = Reflect.get(message, field);
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "string") return value.length > 0;
    return value !== undefined && value !== null && value !== false;
  });
}

function safeErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "error_code" in error &&
    typeof error.error_code === "number" &&
    Number.isSafeInteger(error.error_code)
  ) {
    return `telegram_${error.error_code}`;
  }
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,47}$/.test(error.name)) {
    return error.name;
  }
  return "unknown";
}

export async function cleanTelegramServiceMessage(
  ctx: ServiceMessageContext,
  next: () => Promise<void>,
  reportFailure: (chatId: number, messageId: number, error: unknown) => void = (
    chatId,
    messageId,
    error,
  ) => {
    console.error(
      `[ZEUS] No se pudo borrar el mensaje de incorporación (groupId=${chatId}, messageId=${messageId}, error=${safeErrorCode(error)}).`,
    );
  },
  sleep?: (ms: number) => Promise<void>,
): Promise<void> {
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";

  if (
    isGroup &&
    Number.isSafeInteger(ctx.chat.id) &&
    Number.isSafeInteger(ctx.message.message_id) &&
    isTelegramServiceMessage(ctx.message)
  ) {
    try {
      await callWithRetryAfter(
        () => ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id),
        sleep,
      );
    } catch (error) {
      reportFailure(ctx.chat.id, ctx.message.message_id, error);
    }
  }

  await next();
}

export const cleanServiceMessages = new Composer<MyContext>();

// These Message service fields have message_ids that deleteMessage can target.
// chat_join_request and chat_member are separate updates, not deletable messages.
async function cleanupServiceMessage(ctx: MyContext, next: () => Promise<void>): Promise<void> {
  if (!ctx.chat || !ctx.message) {
    await next();
    return;
  }
  await cleanTelegramServiceMessage(
    {
      chat: ctx.chat,
      message: ctx.message,
      api: {
        deleteMessage: (chatId, messageId) =>
          ctx.api.deleteMessage(chatId, messageId),
      },
    },
    next,
  );
}

cleanServiceMessages.on("message", cleanupServiceMessage);
