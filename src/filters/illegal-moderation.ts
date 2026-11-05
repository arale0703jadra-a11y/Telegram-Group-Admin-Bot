import { createHash } from "node:crypto";
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
import { isConfiguredAdminId } from "../config.js";
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
const DETECTION_WINDOW_MS = 10 * 60 * 1000;
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const MAX_TRACKED_MESSAGES = 4_096;
const MAX_TRACKED_USERS = 2_048;
const processedMessages = new Map<string, { digest: string; expiresAt: number }>();
const inFlightMessages = new Set<string>();
const recentUserSignals = new Map<string, number[]>();

interface ActionOutcome {
  deletion: boolean;
  ban: boolean;
}

function messageText(message: NonNullable<MyContext["msg"]>): string {
  if ("text" in message && typeof message.text === "string") return message.text;
  if ("caption" in message && typeof message.caption === "string") return message.caption;
  return "";
}

function hasMessageLink(message: NonNullable<MyContext["msg"]>, text: string): boolean {
  const entities = [
    ...(("entities" in message && Array.isArray(message.entities)) ? message.entities : []),
    ...(("caption_entities" in message && Array.isArray(message.caption_entities))
      ? message.caption_entities
      : []),
  ];
  return entities.some((entity) => entity.type === "url" || entity.type === "text_link") ||
    /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/)/iu.test(text);
}

function isForwardedMessage(message: NonNullable<MyContext["msg"]>): boolean {
  return (
    "forward_origin" in message ||
    "forward_from" in message ||
    "forward_from_chat" in message ||
    "forward_sender_name" in message
  );
}

function trimMap<K, V>(map: Map<K, V>, maxEntries: number): void {
  while (map.size > maxEntries) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

function wasAlreadyProcessed(key: string, digest: string, now: number): boolean {
  for (const [messageKey, entry] of processedMessages) {
    if (entry.expiresAt <= now) processedMessages.delete(messageKey);
  }
  const previous = processedMessages.get(key);
  return previous?.digest === digest && previous.expiresAt > now;
}

function recordRecentSignal(key: string, now: number): number {
  for (const [userKey, timestamps] of recentUserSignals) {
    const recent = timestamps.filter((timestamp) => timestamp > now - DETECTION_WINDOW_MS);
    if (recent.length === 0) recentUserSignals.delete(userKey);
    else recentUserSignals.set(userKey, recent);
  }
  const recent = (recentUserSignals.get(key) ?? [])
    .filter((timestamp) => timestamp > now - DETECTION_WINDOW_MS);
  recent.push(now);
  recentUserSignals.set(key, recent);
  trimMap(recentUserSignals, MAX_TRACKED_USERS);
  return recent.length;
}

function auditDetail(
  detection: ReturnType<typeof detectIllegalContent>,
  messageId: number,
  outcome: ActionOutcome,
  action: string,
): string {
  return [
    `risk=${detection.risk}`,
    `category=${detection.category ?? "unclassified"}`,
    `intent=${detection.intent}`,
    `signals=${detection.signals.join(",").slice(0, 360)}`,
    `normalized=${detection.normalizationApplied}`,
    `explicitIntent=${detection.explicitIntent}`,
    `messageId=${messageId}`,
    `action=${action}`,
    `delete=${outcome.deletion}`,
    `ban=${outcome.ban}`,
  ].join(";");
}

async function notifyAdminsForReview(
  ctx: MyContext,
  chatId: number,
  messageId: number,
  category: string,
  risk: "medium" | "high",
): Promise<void> {
  let admins;
  try {
    admins = await ctx.api.getChatAdministrators(chatId);
  } catch (error) {
    console.error(
      `[ILLEGAL] No se pudieron consultar administradores groupId=${chatId} ` +
        `messageId=${messageId} error=${error instanceof Error ? error.name : "unknown"}`,
    );
    return;
  }
  for (const admin of admins) {
    if (admin.user.is_bot) continue;
    try {
      await ctx.api.sendMessage(
        admin.user.id,
        `🔒 Alerta de seguridad: riesgo ${risk} (${category}).\n` +
          `Grupo: ${chatId}\nMensaje: ${messageId}\n` +
          "El aviso no contiene ni almacena el texto del mensaje.",
      );
    } catch (error) {
      console.warn(
        `[ILLEGAL] No se pudo enviar alerta groupId=${chatId} messageId=${messageId} ` +
          `adminId=${admin.user.id} error=${error instanceof Error ? error.name : "unknown"}`,
      );
    }
  }
}

async function inspectMessage(ctx: MyContext): Promise<boolean> {
  const message = ctx.msg;
  if (
    !isGroupChat(ctx) ||
    !ctx.chat ||
    !ctx.from ||
    ctx.from.is_bot ||
    ctx.from.id === ctx.me.id ||
    !message
  ) return false;

  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const messageId = message.message_id;
  const now = Date.now();
  const data = await getGroupData(chatId);
  if (!data.illegalContent.enabled) return false;

  const originalText = messageText(message);
  if (!originalText || originalText.startsWith("/")) return false;
  const digest = createHash("sha256").update(originalText).digest("hex");
  const messageKey = `${chatId}:${messageId}`;
  if (wasAlreadyProcessed(messageKey, digest, now)) return false;
  const inFlightKey = `${messageKey}:${digest}`;
  if (inFlightMessages.has(inFlightKey)) return false;
  inFlightMessages.add(inFlightKey);

  let completed = false;
  try {
    const detectionContext = {
      hasLink: hasMessageLink(message, originalText),
      forwarded: isForwardedMessage(message),
    };
    let detection = detectIllegalContent(
      originalText,
      data.illegalContent.customTerms,
      detectionContext,
      data.illegalContent.riskThresholds,
    );
    if (detection.category && detection.risk !== "high") {
      const recentCount = recordRecentSignal(`${chatId}:${userId}`, now);
      detection = detectIllegalContent(
        originalText,
        data.illegalContent.customTerms,
        {
          ...detectionContext,
          repeatedCount: recentCount,
        },
        data.illegalContent.riskThresholds,
      );
    }

    if (!detection.category && detection.risk === "low") {
      completed = true;
      return false;
    }
    data.illegalContent.events += 1;
    const member = await getMemberSafely(ctx, chatId, userId);
    const protectedUser =
      isConfiguredAdminId(userId) || (member ? isProtectedMember(member) : false);
    const verifiable = Boolean(member) && isVerifiableMember(member!);
    const rights = await getBotRights(ctx, chatId);
    const outcome: ActionOutcome = { deletion: false, ban: false };

    if (detection.risk === "low") {
      await saveGroupData(chatId, data);
      await logEvent(ctx, chatId, "ILLEGAL", {
        targetId: userId,
        result: "queued",
        detail: auditDetail(detection, messageId, outcome, "record-only"),
      });
      completed = true;
      return false;
    }

    if (detection.risk === "high") {
      if (rights.canDelete) {
        outcome.deletion = (await deleteMessageById(ctx, chatId, messageId)).ok;
      }
      if (
        data.illegalContent.highConfidenceBan &&
        !protectedUser &&
        verifiable &&
        rights.canRestrict
      ) {
        outcome.ban = await mutex.runExclusive(String(chatId), async () =>
          banCooldown.shouldApply(
            `${chatId}:${userId}:illegal`,
            now,
            BAN_COOLDOWN_MS,
          )
            ? (await banUser(ctx, chatId, userId, undefined, "High-risk safety detection")).ok
            : false,
        );
      }
      await saveGroupData(chatId, data);
      await logEvent(ctx, chatId, "ILLEGAL", {
        targetId: userId,
        result: outcome.deletion || outcome.ban ? "ok" : "error",
        detail: auditDetail(
          detection,
          messageId,
          outcome,
          `high-risk${protectedUser ? "-protected-author" : ""}`,
        ),
      });
      if (
        reviewNotifyCooldown.shouldApply(
          `high:${chatId}`,
          now,
          REVIEW_NOTIFY_COOLDOWN_MS,
        )
      ) {
        await notifyAdminsForReview(
          ctx,
          chatId,
          messageId,
          detection.category ?? "unclassified",
          "high",
        );
      }
      completed = true;
      return outcome.deletion || outcome.ban;
    }

    data.illegalContent.reviewEvents += 1;
    const configuredAction = data.illegalContent.ambiguousAction;
    const shouldDelete =
      (configuredAction === "delete" || data.illegalContent.suspiciousDeletes) &&
      rights.canDelete;
    if (shouldDelete) {
      outcome.deletion = (await deleteMessageById(ctx, chatId, messageId)).ok;
    }
    await saveGroupData(chatId, data);
    await logEvent(ctx, chatId, "ILLEGAL", {
      targetId: userId,
      result: outcome.deletion ? "ok" : "queued",
      detail: auditDetail(detection, messageId, outcome, `medium-risk-${configuredAction}`),
    });
    if (
      data.illegalContent.notifyAdminsOnAmbiguous &&
      reviewNotifyCooldown.shouldApply(`review:${chatId}`, now, REVIEW_NOTIFY_COOLDOWN_MS)
    ) {
      await notifyAdminsForReview(
        ctx,
        chatId,
        messageId,
        detection.category ?? "unclassified",
        "medium",
      );
    }
    completed = true;
    return outcome.deletion;
  } finally {
    inFlightMessages.delete(inFlightKey);
    if (completed) {
      processedMessages.set(messageKey, {
        digest,
        expiresAt: now + DEDUPE_WINDOW_MS,
      });
      trimMap(processedMessages, MAX_TRACKED_MESSAGES);
    }
  }
}

illegalModeration.on(["message", "edited_message"], async (ctx, next) => {
  try {
    if (await inspectMessage(ctx)) return;
  } catch (error) {
    const message = ctx.msg;
    console.error(
      `[ILLEGAL] Falló el análisis groupId=${ctx.chat?.id ?? "unknown"} ` +
        `userId=${ctx.from?.id ?? "unknown"} messageId=${message?.message_id ?? "unknown"} ` +
        `error=${error instanceof Error ? error.name : "unknown"}`,
    );
  }
  await next();
});
