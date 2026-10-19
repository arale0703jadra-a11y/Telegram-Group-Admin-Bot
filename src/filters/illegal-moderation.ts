import { Composer } from "grammy";
import { getGroupData, saveGroupData } from "../storage/index.js";
import {
  banUser,
  deleteMessageById,
  getBotRights,
  getMemberSafely,
  isProtectedMember,
  isVerifiableMember,
} from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { OWNER_ID } from "../config.js";
import { isGroupChat } from "../utils/permissions.js";
import { CooldownTracker, KeyedMutex } from "../utils/safety.js";
import { detectIllegalContent } from "./illegal-detector.js";
import type { MyContext } from "../types.js";

export const illegalModeration = new Composer<MyContext>();

const mutex = new KeyedMutex();
const banCooldown = new CooldownTracker();
const reviewNotifyCooldown = new CooldownTracker();
const BAN_COOLDOWN_MS = 10 * 60 * 1000;
const REVIEW_NOTIFY_COOLDOWN_MS = 60 * 1000;

/**
 * Avisa por privado a los administradores cuando hace falta revisar una
 * detección ambigua. Mejor esfuerzo: los admins que no hayan iniciado al bot
 * no reciben el aviso. El RATE_LIMIT cooldown evita saturarlos.
 * No se incluye el texto del mensaje, solo chat, mensaje y categoría.
 */
async function notifyAdminsForReview(
  ctx: MyContext,
  chatId: number,
  messageId: number,
  category: string,
): Promise<void> {
  try {
    const admins = await ctx.api.getChatAdministrators(chatId);
    for (const admin of admins) {
      if (admin.user.is_bot) {
        continue;
      }
      try {
        await ctx.api.sendMessage(
          admin.user.id,
          "🔒 Detección ambigua pendiente de revisión.\n" +
            `Grupo: ${chatId}\nMensaje: ${messageId}\nCategoría: ${category}\n\n` +
            "Revisa el mensaje en el grupo y aplica la medida que corresponda. " +
            "No se ha sancionado automáticamente.",
        );
      } catch {
        // Admin sin chat privado con el bot: se ignora.
      }
    }
  } catch {
    // Sin permisos para listar administradores: se ignora.
  }
}

illegalModeration.on("message", async (ctx, next) => {
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
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const messageId = ctx.message.message_id;
  const now = Date.now();

  const data = await getGroupData(chatId);
  if (!data.illegalContent.enabled) {
    await next();
    return;
  }
  const text = ctx.message.text ?? ctx.message.caption ?? "";
  if (!text || text.startsWith("/")) {
    await next();
    return;
  }

  const detection = detectIllegalContent(text, data.illegalContent.customTerms);
  if (detection.confidence === "weak") {
    await next();
    return;
  }

  const member = await getMemberSafely(ctx, chatId, userId);
  const protectedUser =
    OWNER_ID === userId || (member ? isProtectedMember(member) : false);
  const verifiable = Boolean(member) && isVerifiableMember(member!);
  const rights = await getBotRights(ctx, chatId);
  data.illegalContent.events += 1;

  // CRÍTICO (frase explícita e inequívoca): se retira el contenido siempre;
  // se banea solo si hay permiso y el autor no está protegido.
  if (detection.critical) {
    await saveGroupData(chatId, data);
    const deletion = rights.canDelete
      ? await deleteMessageById(ctx, chatId, messageId)
      : { ok: false };
    let ban = { ok: false };
    if (!protectedUser && verifiable && rights.canRestrict) {
      ban = await mutex.runExclusive(String(chatId), async () =>
        banCooldown.shouldApply(`${chatId}:${userId}:illegal`, now, BAN_COOLDOWN_MS)
          ? await banUser(ctx, chatId, userId)
          : { ok: false },
      );
    }
    await logEvent(ctx, chatId, "ILLEGAL", {
      targetId: userId,
      result: deletion.ok || ban.ok ? "ok" : "error",
      detail: `critical:${detection.category ?? "custom"};messageId=${messageId};delete=${deletion.ok};ban=${ban.ok};protected=${protectedUser}`,
    });
    await next();
    return;
  }

  // No crítico: requiere un miembro verificable y no protegido.
  if (!verifiable || protectedUser) {
    await saveGroupData(chatId, data);
    await logEvent(ctx, chatId, "ILLEGAL", {
      targetId: userId,
      result: "error",
      detail: `skip:${detection.confidence};messageId=${messageId};miembro no verificable o protegido`,
    });
    await next();
    return;
  }

  // AMBIGUO (confianza "suspicious"): NUNCA se sanciona gravemente solo.
  if (detection.confidence === "suspicious" || detection.needsReview) {
    data.illegalContent.reviewEvents += 1;
    const action = data.illegalContent.ambiguousAction;
    await saveGroupData(chatId, data);
    let deletion = { ok: false };
    if (action === "delete" && rights.canDelete) {
      deletion = await deleteMessageById(ctx, chatId, messageId);
    }
    if (
      action === "review" &&
      data.illegalContent.notifyAdminsOnAmbiguous &&
      reviewNotifyCooldown.shouldApply(
        `review:${chatId}`,
        now,
        REVIEW_NOTIFY_COOLDOWN_MS,
      )
    ) {
      await notifyAdminsForReview(
        ctx,
        chatId,
        messageId,
        detection.category ?? "custom",
      );
    }
    await logEvent(ctx, chatId, "ILLEGAL", {
      targetId: userId,
      result: deletion.ok ? "ok" : "queued",
      detail: `ambiguous:${detection.category ?? "custom"};messageId=${messageId};action=${action};delete=${deletion.ok};solo-revision`,
    });
    await next();
    return;
  }

  // ALTA confianza (no crítico): borrar y/o banear según configuración.
  await saveGroupData(chatId, data);
  const deletion =
    data.illegalContent.highConfidenceDelete && rights.canDelete
      ? await deleteMessageById(ctx, chatId, messageId)
      : { ok: false };
  let ban = { ok: false };
  if (data.illegalContent.highConfidenceBan && rights.canRestrict) {
    ban = await mutex.runExclusive(String(chatId), async () =>
      banCooldown.shouldApply(`${chatId}:${userId}:illegal`, now, BAN_COOLDOWN_MS)
        ? await banUser(ctx, chatId, userId)
        : { ok: false },
    );
  }
  await logEvent(ctx, chatId, "ILLEGAL", {
    targetId: userId,
    result: deletion.ok || ban.ok ? "ok" : "error",
    detail: `high:${detection.category ?? "custom"};messageId=${messageId};delete=${deletion.ok};ban=${ban.ok}`,
  });
  await next();
});
