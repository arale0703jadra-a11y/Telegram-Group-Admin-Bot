import { Composer } from "grammy";
import type { MyContext } from "../types.js";

interface JoinServiceContext {
  chat: {
    id: number;
    type: string;
  };
  message: {
    message_id: number;
    new_chat_members?: unknown[];
    community_chat_joined?: unknown;
  };
  api: {
    deleteMessage(chatId: number | string, messageId: number): Promise<unknown>;
  };
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

export async function cleanMemberJoinServiceMessage(
  ctx: JoinServiceContext,
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
): Promise<void> {
  const joinedMembers = ctx.message.new_chat_members;
  const joinedFromCommunity = ctx.message.community_chat_joined !== undefined;
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";

  if (
    isGroup &&
    Number.isSafeInteger(ctx.chat.id) &&
    Number.isSafeInteger(ctx.message.message_id) &&
    ((Array.isArray(joinedMembers) && joinedMembers.length > 0) ||
      joinedFromCommunity)
  ) {
    try {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
    } catch (error) {
      reportFailure(ctx.chat.id, ctx.message.message_id, error);
    }
  }

  await next();
}

export const cleanServiceMessages = new Composer<MyContext>();

// These Message service fields have message_ids that deleteMessage can target.
// chat_join_request and chat_member are separate updates, not deletable messages.
async function cleanupJoinMessage(ctx: MyContext, next: () => Promise<void>): Promise<void> {
  if (!ctx.chat || !ctx.message) {
    await next();
    return;
  }
  await cleanMemberJoinServiceMessage(
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

cleanServiceMessages.on("message:new_chat_members", cleanupJoinMessage);
cleanServiceMessages.on("message:community_chat_joined", cleanupJoinMessage);
