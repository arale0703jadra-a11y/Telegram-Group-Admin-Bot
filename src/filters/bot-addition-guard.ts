import type { ChatMember, User } from "@grammyjs/types";
import { Composer } from "grammy";
import { OWNER_ID } from "../config.js";
import { getBotRights, getMemberSafely } from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { callWithRetryAfter, runChatActionExclusive } from "../utils/safety.js";
import { isGroupChat } from "../utils/permissions.js";
import type { MyContext } from "../types.js";

export function isAuthorizedBotAdder(
  adderId: number,
  member: ChatMember | undefined,
): boolean {
  return (
    member !== undefined &&
    (adderId === OWNER_ID ||
      member.status === "creator" ||
      member.status === "administrator")
  );
}

async function banUnauthorizedBot(
  ctx: MyContext,
  bot: User,
): Promise<void> {
  if (!isGroupChat(ctx) || !ctx.chat || !ctx.message) {
    return;
  }

  const chatId = ctx.chat.id;
  const adderId = ctx.from?.id;
  if (typeof adderId !== "number" || ctx.from?.is_bot) {
    await logEvent(ctx, chatId, "BAN", {
      targetId: bot.id,
      targetName: bot.username ?? bot.first_name,
      result: "error",
      detail: "BOT_ADDITION: no se pudo verificar quién añadió el bot.",
    });
    return;
  }

  const adder = await getMemberSafely(ctx, chatId, adderId);
  if (isAuthorizedBotAdder(adderId, adder)) {
    return;
  }

  if (!adder || (adder.status !== "member" && adder.status !== "restricted")) {
    await logEvent(ctx, chatId, "BAN", {
      targetId: bot.id,
      targetName: bot.username ?? bot.first_name,
      result: "error",
      detail: "BOT_ADDITION: no se pudo verificar que quien lo añadió sea miembro normal.",
    });
    return;
  }

  const rights = await getBotRights(ctx, chatId);
  if (!rights.canRestrict) {
    await logEvent(ctx, chatId, "BAN", {
      targetId: bot.id,
      targetName: bot.username ?? bot.first_name,
      result: "error",
      detail: "BOT_ADDITION: el bot no tiene permisos para expulsar miembros.",
    });
    return;
  }

  try {
    await runChatActionExclusive(chatId, () =>
      callWithRetryAfter(() => ctx.api.banChatMember(chatId, bot.id)),
    );
    await logEvent(ctx, chatId, "BAN", {
      targetId: bot.id,
      targetName: bot.username ?? bot.first_name,
      result: "ok",
      detail: `BOT_ADDITION: añadido por miembro no administrador (userId=${adderId}); expulsión permanente.`,
    });
  } catch (error) {
    const errorCode =
      typeof error === "object" &&
      error !== null &&
      "error_code" in error &&
      typeof error.error_code === "number"
        ? `telegram_${error.error_code}`
        : error instanceof Error
          ? error.name
          : "unknown";
    console.error(
      `[BOT ADDITION GUARD] No se pudo expulsar al bot (chatId=${chatId}, botId=${bot.id}, error=${errorCode}).`,
    );
    await logEvent(ctx, chatId, "BAN", {
      targetId: bot.id,
      targetName: bot.username ?? bot.first_name,
      result: "error",
      detail: `BOT_ADDITION: Telegram rechazó la expulsión (${errorCode}).`,
    });
  }
}

export const botAdditionGuard = new Composer<MyContext>();

botAdditionGuard.on("message:new_chat_members", async (ctx, next) => {
  if (!isGroupChat(ctx) || !ctx.message) {
    await next();
    return;
  }

  for (const member of ctx.message.new_chat_members ?? []) {
    if (member.is_bot) {
      await banUnauthorizedBot(ctx, member);
    }
  }
  await next();
});
