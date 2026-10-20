import { Composer } from "grammy";
import { markTelegramAccountDeleted } from "../services/user-activity.js";
import { isVerifiedUser } from "../services/verified-users.js";
import { callWithRetryAfter } from "../utils/safety.js";
import { invalidateSecurityCaches } from "../utils/member-cache.js";
import {
  deleteMessageById,
  getBotRights,
  getMemberSafely,
  isProtectedMember,
  isVerifiableMember,
} from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { isGroupChat } from "../utils/permissions.js";
import type { MyContext } from "../types.js";

export function isDeletedTelegramAccount(user: {
  first_name: string;
  last_name?: string;
  username?: string;
}): boolean {
  return (
    user.first_name === "Deleted Account" &&
    !user.last_name &&
    !user.username
  );
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
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn(
      `[DELETED_ACCOUNT] Expulsión omitida groupId=${chatId} userId=${userId}: no se puede confirmar estado de verificación.`,
    );
    await next();
    return;
  }
  const member = await getMemberSafely(ctx, chatId, userId);
  if (
    !member ||
    member.user.is_bot ||
    !isVerifiableMember(member) ||
    isProtectedMember(member)
  ) {
    await next();
    return;
  }

  let verified;
  try {
    verified = await isVerifiedUser(chatId, userId);
  } catch (error) {
    console.error(
      `[DELETED_ACCOUNT] Verificación de estado fallida groupId=${chatId} userId=${userId}:`,
      error,
    );
    await next();
    return;
  }
  if (verified) {
    await next();
    return;
  }

  const rights = await getBotRights(ctx, chatId);
  if (!rights.canRestrict) {
    await logEvent(ctx, chatId, "INACTIVITY_REMOVE_ERROR", {
      targetId: userId,
      result: "error",
      detail: "Cuenta eliminada sospechosa; expulsión omitida por falta de permisos.",
    });
    await next();
    return;
  }

  try {
    try {
      await markTelegramAccountDeleted(chatId, userId);
    } catch (error) {
      console.error(
        `[DELETED_ACCOUNT] No se pudo guardar la marca en Supabase groupId=${chatId} userId=${userId}:`,
        error,
      );
    }
    if (rights.canDelete) {
      try {
        const result = await deleteMessageById(ctx, chatId, ctx.message.message_id);
        if (!result.ok) {
          console.error(
            `[DELETED_ACCOUNT] No se pudo borrar el mensaje groupId=${chatId} messageId=${ctx.message.message_id}: ${result.error}`,
          );
        }
      } catch (error) {
        console.error(
          `[DELETED_ACCOUNT] No se pudo borrar el mensaje groupId=${chatId} messageId=${ctx.message.message_id}:`,
          error,
        );
      }
    }
    await callWithRetryAfter(() => ctx.api.banChatMember(chatId, userId));
    invalidateSecurityCaches(chatId, userId);
    await callWithRetryAfter(() =>
      ctx.api.unbanChatMember(chatId, userId, { only_if_banned: true }),
    );
    invalidateSecurityCaches(chatId, userId);
    await logEvent(ctx, chatId, "INACTIVITY_REMOVE", {
      targetId: userId,
      targetName: "Deleted Account",
      result: "ok",
      detail: "Cuenta eliminada expulsada silenciosamente.",
    });
  } catch (error) {
    console.error(
      `[DELETED_ACCOUNT] No se pudo expulsar groupId=${chatId} userId=${userId}:`,
      error,
    );
    await logEvent(ctx, chatId, "INACTIVITY_REMOVE_ERROR", {
      targetId: userId,
      targetName: "Deleted Account",
      result: "error",
      detail: "Falló la expulsión silenciosa de la cuenta marcada como eliminada.",
    });
  }
});
