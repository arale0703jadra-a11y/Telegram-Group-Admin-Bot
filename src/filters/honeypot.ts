import { randomBytes } from "node:crypto";
import { Composer, InlineKeyboard } from "grammy";
import type { ChatMember, ChatPermissions } from "@grammyjs/types";
import { OWNER_ID } from "../config.js";
import {
  getBotRights,
  getMemberSafely,
  isProtectedMember,
} from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { getGroupData, saveGroupData } from "../storage/index.js";
import type { MyContext } from "../types.js";
import { invalidateSecurityCaches } from "../utils/member-cache.js";
import { isGroupChat } from "../utils/permissions.js";
import { callWithRetryAfter } from "../utils/safety.js";
import {
  EMERGENCY_MEMBER_PERMISSIONS,
} from "../services/emergency-mode.js";
import {
  isEmergencyActive,
  isRecentEmergencyMember,
} from "./anti-raid-engine.js";

export const HONEYPOT_CHALLENGE_SECONDS = 180;
const pendingChallenges = new Map<
  string,
  {
    token: string;
    messageId: number;
    expiresAt: number;
    cleanupTimer: ReturnType<typeof setTimeout>;
  }
>();
const LOCKED_PERMISSIONS: ChatPermissions = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_react_to_messages: false,
  can_invite_users: false,
};

function challengeKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

function newToken(): string {
  return randomBytes(9).toString("base64url");
}

export function isHoneypotChallengeOwner(
  expectedUserId: number,
  actualUserId: number,
  expectedToken: string,
  actualToken: string,
  expiresAt: number,
  now: number,
): boolean {
  return (
    expectedUserId === actualUserId &&
    expectedToken === actualToken &&
    now < expiresAt
  );
}

function isNewRegularMember(member: ChatMember): boolean {
  return member.status === "member" ||
    (member.status === "restricted" && member.is_member);
}

function removeExpiredChallenges(now: number): void {
  for (const [key, challenge] of pendingChallenges) {
    if (challenge.expiresAt <= now) {
      clearTimeout(challenge.cleanupTimer);
      pendingChallenges.delete(key);
    }
  }
}

export const honeypot = new Composer<MyContext>();

honeypot.on("chat_member", async (ctx, next) => {
  if (!isGroupChat(ctx) || !ctx.chatMember) {
    await next();
    return;
  }

  const update = ctx.chatMember;
  const member = update.new_chat_member;
  const previousStatus = update.old_chat_member.status;
  if (
    member.user.is_bot ||
    !isNewRegularMember(member) ||
    (previousStatus !== "left" && previousStatus !== "kicked") ||
    member.user.id === OWNER_ID
  ) {
    await next();
    return;
  }

  const chatId = ctx.chat.id;
  const userId = member.user.id;
  const now = Date.now();
  removeExpiredChallenges(now);
  const rights = await getBotRights(ctx, chatId);
  if (!rights.canRestrict) {
    await logEvent(ctx, chatId, "ANTIRAID", {
      targetId: userId,
      targetName: member.user.username ?? member.user.first_name,
      result: "error",
      detail: "HONEYPOT: no se pudo iniciar el reto porque falta can_restrict_members.",
    });
    await next();
    return;
  }

  const token = newToken();
  const expiresAt = now + HONEYPOT_CHALLENGE_SECONDS * 1000;
  try {
    await callWithRetryAfter(() =>
      ctx.api.restrictChatMember(chatId, userId, LOCKED_PERMISSIONS, {
        until_date: Math.floor(expiresAt / 1000),
      }),
    );
    invalidateSecurityCaches(chatId, userId);
    const sent = await ctx.api.sendMessage(
      chatId,
      "👋 Para participar, confirma que has llegado y quieres entrar a la conversación. " +
        "Mientras tanto, la escritura queda pausada por un máximo de 3 minutos.",
      {
        reply_markup: new InlineKeyboard().text(
          "✅ Continuar al grupo",
          `hp:${userId}:${token}`,
        ),
      },
    );
    const key = challengeKey(chatId, userId);
    const cleanup = setTimeout(() => {
      const current = pendingChallenges.get(key);
      if (current?.token === token) pendingChallenges.delete(key);
      void ctx.api.deleteMessage(chatId, sent.message_id).catch((error: unknown) => {
        console.error(
          `[HONEYPOT] No se pudo limpiar el reto de bienvenida chatId=${chatId} messageId=${sent.message_id}:`,
          error,
        );
      });
    }, HONEYPOT_CHALLENGE_SECONDS * 1000);
    cleanup.unref?.();
    pendingChallenges.set(challengeKey(chatId, userId), {
      token,
      messageId: sent.message_id,
      expiresAt,
      cleanupTimer: cleanup,
    });
    await logEvent(ctx, chatId, "ANTIRAID", {
      targetId: userId,
      targetName: member.user.username ?? member.user.first_name,
      result: "ok",
      detail: "HONEYPOT: reto de bienvenida visible iniciado; restricción expira en 3 minutos si no se completa.",
    });

  } catch (error) {
    console.error(
      `[HONEYPOT] No se pudo iniciar el reto chatId=${chatId} userId=${userId}:`,
      error,
    );
    await logEvent(ctx, chatId, "ANTIRAID", {
      targetId: userId,
      result: "error",
      detail: "HONEYPOT: falló la preparación del reto; la restricción temporal caduca por sí sola.",
    });
  }
  await next();
});

honeypot.on("callback_query:data", async (ctx, next) => {
  const parts = ctx.callbackQuery.data.split(":");
  if (parts[0] !== "hp") {
    await next();
    return;
  }

  const message = ctx.callbackQuery.message;
  const chatId = message?.chat.id;
  const userId = Number(parts[1]);
  const token = parts[2];
  if (
    typeof chatId !== "number" ||
    !Number.isSafeInteger(userId) ||
    typeof token !== "string" ||
    !ctx.from
  ) {
    await ctx.answerCallbackQuery("El reto no es válido.");
    return;
  }

  const key = challengeKey(chatId, userId);
  const challenge = pendingChallenges.get(key);
  if (!challenge) {
    await ctx.answerCallbackQuery("El reto caducó. Puedes continuar participando.");
    return;
  }
  if (Date.now() >= challenge.expiresAt) {
    clearTimeout(challenge.cleanupTimer);
    pendingChallenges.delete(key);
    await ctx.answerCallbackQuery("El reto caducó. Puedes continuar participando.");
    return;
  }
  if (
    !isHoneypotChallengeOwner(
      userId,
      ctx.from.id,
      challenge.token,
      token,
      challenge.expiresAt,
      Date.now(),
    )
  ) {
    await ctx.answerCallbackQuery("Este botón de verificación pertenece a otra persona.");
    return;
  }

  const member = await getMemberSafely(ctx, chatId, userId);
  if (!member || !isNewRegularMember(member) || isProtectedMember(member)) {
    clearTimeout(challenge.cleanupTimer);
    pendingChallenges.delete(key);
    await ctx.answerCallbackQuery("No pude confirmar tu estado actual en el grupo.");
    return;
  }

  const rights = await getBotRights(ctx, chatId);
  if (!rights.canRestrict) {
    await ctx.answerCallbackQuery("No pude completar la verificación; inténtalo en un momento.");
    return;
  }

  const data = await getGroupData(chatId);
  const now = Date.now();
  const joinedAt = data.indexedUsers[String(userId)]?.joinedAt;
  let permissions: ChatPermissions;
  let untilDate = 0;
  if (
    isEmergencyActive(data.emergency, now) &&
    isRecentEmergencyMember(joinedAt, now)
  ) {
    permissions = EMERGENCY_MEMBER_PERMISSIONS;
    untilDate = Math.min(
      data.emergency.expiresAt ?? now,
      (joinedAt ?? 0) * 1000 + 48 * 60 * 60 * 1000,
    );
    data.emergency.restrictedUsers ??= {};
    data.emergency.restrictedUsers[String(userId)] = Math.ceil(untilDate / 1000);
  } else {
    let chat;
    try {
      chat = await ctx.api.getChat(chatId);
    } catch (error) {
      console.error(`[HONEYPOT] No se pudieron consultar permisos de grupo chatId=${chatId}:`, error);
      await ctx.answerCallbackQuery("No pude restaurar tus permisos; la restricción expira automáticamente.");
      return;
    }
    permissions =
      "permissions" in chat && chat.permissions
        ? chat.permissions
        : {
            can_send_messages: true,
            can_send_audios: true,
            can_send_documents: true,
            can_send_photos: true,
            can_send_videos: true,
            can_send_video_notes: true,
            can_send_voice_notes: true,
            can_send_polls: true,
            can_send_other_messages: true,
            can_add_web_page_previews: true,
            can_react_to_messages: true,
            can_invite_users: true,
          };
  }

  try {
    await callWithRetryAfter(() =>
      ctx.api.restrictChatMember(chatId, userId, permissions, {
        until_date: untilDate,
      }),
    );
    invalidateSecurityCaches(chatId, userId);
    await saveGroupData(chatId, data);
    clearTimeout(challenge.cleanupTimer);
    pendingChallenges.delete(key);
    await ctx.answerCallbackQuery("Verificación completada.");
    try {
      await ctx.api.deleteMessage(chatId, challenge.messageId);
    } catch (error) {
      console.error(
        `[HONEYPOT] No se pudo borrar el mensaje del reto chatId=${chatId} messageId=${challenge.messageId}:`,
        error,
      );
    }
    await logEvent(ctx, chatId, "ANTIRAID", {
      targetId: userId,
      targetName: member.user.username ?? member.user.first_name,
      result: "ok",
      detail: "HONEYPOT: reto de bienvenida completado.",
    });
  } catch (error) {
    console.error(
      `[HONEYPOT] No se pudo restaurar la participación chatId=${chatId} userId=${userId}:`,
      error,
    );
    await ctx.answerCallbackQuery("Falló la verificación; la restricción expira automáticamente.");
  }
});
