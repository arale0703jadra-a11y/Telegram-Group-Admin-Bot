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
import { detectIllegalContent } from "./illegal-detector.js";
import type { MyContext } from "../types.js";

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

  const member = await getMemberSafely(ctx, ctx.chat.id, ctx.from.id);
  const protectedUser =
    OWNER_ID === ctx.from.id ||
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
  const rights = await getBotRights(ctx, ctx.chat.id);
  data.illegalContent.events += 1;
  await saveGroupData(ctx.chat.id, data);
  if (detection.critical) {
    const deletion = rights.canDelete
      ? await deleteMessageById(ctx, ctx.chat.id, ctx.message.message_id)
      : { ok: false };
    const ban =
      member && !protectedUser && rights.canRestrict
        ? await banUser(ctx, ctx.chat.id, ctx.from.id, ctx.from.first_name)
        : { ok: false };

    await logEvent(ctx, ctx.chat.id, "ILLEGAL", {
      targetId: ctx.from.id,
      targetName: ctx.from.username ?? ctx.from.first_name,
      result: deletion.ok || ban.ok ? "ok" : "error",
      detail:
        `critical;delete=${deletion.ok};ban=${ban.ok};` +
        `banSkipped=${!member ? "unknown-member" : protectedUser ? "protected" : !rights.canRestrict ? "no-ban-permission" : "no-ban"}`,
    });
    await next();
    return;
  }
  const shouldDelete =
    detection.confidence === "high"
      ? data.illegalContent.highConfidenceDelete
      : data.illegalContent.suspiciousDeletes;
  const deletion =
    shouldDelete && rights.canDelete
      ? await deleteMessageById(ctx, ctx.chat.id, ctx.message.message_id)
      : { ok: false };
  let ban = { ok: false };
  if (detection.confidence === "high" && data.illegalContent.highConfidenceBan && !protectedUser) {
    if (rights.canRestrict) {
      ban = await banUser(ctx, ctx.chat.id, ctx.from.id, ctx.from.first_name);
    }
  }

  await logEvent(ctx, ctx.chat.id, "ILLEGAL", {
    targetId: ctx.from.id,
    targetName: ctx.from.username ?? ctx.from.first_name,
    result: deletion.ok || ban.ok ? "ok" : "error",
    detail: `${detection.category ?? "custom"}:${detection.confidence};delete=${deletion.ok};ban=${ban.ok};protected=${Boolean(protectedUser)}`,
  });
  await next();
});
