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
import { isGroupChat } from "../utils/permissions.js";
import { detectIllegalContent } from "./illegal-detector.js";
import type { MyContext } from "../types.js";
import {
  delegateSecurityCommand,
  isCerberoExecutionEnabled,
} from "../services/security-commands.js";
import { getVerifiedUserPermissions } from "../services/verified-users.js";
import { shouldSkipAutomaticDeletion, shouldSkipIllegalFilter } from "../services/verified-user-policy.js";

export const illegalModeration = new Composer<MyContext>();

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
  const userId = ctx.from.id;
  const data = await getGroupData(ctx.chat.id);
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
  let verifiedPermissions;
  try {
    verifiedPermissions = await getVerifiedUserPermissions(ctx.chat.id, userId);
  } catch (error) {
    console.error(
      `[ILLEGAL] No se pudieron consultar permisos de verificada groupId=${ctx.chat.id} userId=${userId}; se mantiene el filtro de seguridad:`,
      error,
    );
  }

  const member = await getMemberSafely(ctx, ctx.chat.id, ctx.from.id);
  const protectedUser =
    (member ? isProtectedMember(member) : false);
  if (!member || member.user.is_bot || !isVerifiableMember(member) || protectedUser) {
    await logEvent(ctx, ctx.chat.id, "ILLEGAL", {
      targetId: ctx.from.id,
      targetName: ctx.from.username ?? ctx.from.first_name,
      result: "error",
      detail: "Moderación automática omitida: miembro no verificable o protegido.",
    });
    await next();
    return;
  }
  if (
    shouldSkipIllegalFilter(
      verifiedPermissions?.bypass_illegal_filter === true,
      detection.critical,
    )
  ) {
    await next();
    return;
  }
  const rights = await getBotRights(ctx, ctx.chat.id);
  data.illegalContent.events += 1;
  await saveGroupData(ctx.chat.id, data);
  if (detection.critical) {
    let deletion = { ok: false };
    let ban = { ok: false };
    if (isCerberoExecutionEnabled()) {
      if (rights.canDelete) {
        const order = await delegateSecurityCommand({
          groupId: ctx.chat.id,
          action: "DELETE_MESSAGE",
          targetMessageId: ctx.message.message_id,
          idempotencyKey: String(ctx.update.update_id),
          payload: { reason: "ILLEGAL_CONTENT:critical" },
        });
        deletion = { ok: order.ok };
      }
      if (member && !protectedUser && rights.canRestrict) {
        const order = await delegateSecurityCommand({
          groupId: ctx.chat.id,
          action: "BAN_USER",
          targetUserId: ctx.from.id,
          idempotencyKey: String(ctx.update.update_id),
          payload: { reason: "ILLEGAL_CONTENT:critical" },
        });
        ban = { ok: order.ok };
      }
    } else {
      deletion = rights.canDelete
        ? await deleteMessageById(ctx, ctx.chat.id, ctx.message.message_id)
        : { ok: false };
      ban =
        member && !protectedUser && rights.canRestrict
          ? await banUser(ctx, ctx.chat.id, ctx.from.id, ctx.from.first_name)
          : { ok: false };
    }

    await logEvent(ctx, ctx.chat.id, "ILLEGAL", {
      targetId: ctx.from.id,
      targetName: ctx.from.username ?? ctx.from.first_name,
      result: deletion.ok || ban.ok
        ? isCerberoExecutionEnabled()
          ? "queued"
          : "ok"
        : "error",
      detail:
        `critical;delete=${deletion.ok};ban=${ban.ok};` +
        `banSkipped=${!member ? "unknown-member" : protectedUser ? "protected" : !rights.canRestrict ? "no-ban-permission" : "no-ban"}`,
    });
    if (!deletion.ok) {
      await next();
    }
    return;
  }
  const shouldDelete =
    detection.confidence === "high"
      ? data.illegalContent.highConfidenceDelete
      : data.illegalContent.suspiciousDeletes;
  const automaticDeletionDisabled = shouldSkipAutomaticDeletion(
    verifiedPermissions?.bypass_automatic_deletion === true,
    detection.critical,
  );
  let deletion = { ok: false };
  if (shouldDelete && !automaticDeletionDisabled && rights.canDelete) {
    if (isCerberoExecutionEnabled()) {
      const order = await delegateSecurityCommand({
        groupId: ctx.chat.id,
        action: "DELETE_MESSAGE",
        targetMessageId: ctx.message.message_id,
        idempotencyKey: String(ctx.update.update_id),
        payload: { reason: `ILLEGAL_CONTENT:${detection.confidence}` },
      });
      deletion = { ok: order.ok };
    } else {
      deletion = await deleteMessageById(ctx, ctx.chat.id, ctx.message.message_id);
    }
  }
  let ban = { ok: false };
  if (detection.confidence === "high" && data.illegalContent.highConfidenceBan && !protectedUser) {
    if (rights.canRestrict) {
      if (isCerberoExecutionEnabled()) {
        const order = await delegateSecurityCommand({
          groupId: ctx.chat.id,
          action: "BAN_USER",
          targetUserId: ctx.from.id,
          idempotencyKey: String(ctx.update.update_id),
          payload: { reason: `ILLEGAL_CONTENT:${detection.confidence}` },
        });
        ban = { ok: order.ok };
      } else {
        ban = await banUser(ctx, ctx.chat.id, ctx.from.id, ctx.from.first_name);
      }
    }
  }

  await logEvent(ctx, ctx.chat.id, "ILLEGAL", {
    targetId: ctx.from.id,
    targetName: ctx.from.username ?? ctx.from.first_name,
    result: deletion.ok || ban.ok
      ? isCerberoExecutionEnabled()
        ? "queued"
        : "ok"
      : "error",
    detail: `${detection.category ?? "custom"}:${detection.confidence};delete=${deletion.ok};ban=${ban.ok};protected=${Boolean(protectedUser)}`,
  });
  if (!deletion.ok) {
    await next();
  }
});
