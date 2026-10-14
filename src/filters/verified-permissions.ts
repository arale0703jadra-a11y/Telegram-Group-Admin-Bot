import { Composer } from "grammy";
import { deleteMessageById, isVerifiableMember } from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { isGroupChat } from "../utils/permissions.js";
import type { MyContext } from "../types.js";
import { delegateSecurityCommand, isCerberoExecutionEnabled } from "../services/security-commands.js";
import { getVerifiedUserPermissions } from "../services/verified-users.js";
import { getVerifiedMessageRestriction } from "../services/verified-user-policy.js";

function messageHasMedia(ctx: MyContext): boolean {
  const message = ctx.message;
  return Boolean(
    message &&
      [
        "photo",
        "video",
        "animation",
        "document",
        "sticker",
        "audio",
        "voice",
        "video_note",
      ].some((field) => field in message),
  );
}

export const verifiedPermissions = new Composer<MyContext>();

verifiedPermissions.on("message", async (ctx, next) => {
  if (
    !isGroupChat(ctx) ||
    !ctx.from ||
    ctx.from.is_bot ||
    ctx.from.id === ctx.me.id ||
    !ctx.message ||
    isCerberoExecutionEnabled()
  ) {
    await next();
    return;
  }

  let permissions;
  try {
    permissions = await getVerifiedUserPermissions(ctx.chat.id, ctx.from.id);
  } catch (error) {
    console.error(
      `[VERIFIED_PERMISSION] No se pudieron consultar permisos groupId=${ctx.chat.id} userId=${ctx.from.id}; se mantienen los filtros generales:`,
      error,
    );
    await next();
    return;
  }
  if (!permissions) {
    await next();
    return;
  }

  let member;
  try {
    member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
  } catch (error) {
    console.error(
      `[VERIFIED_PERMISSION] No se pudo comprobar la pertenencia groupId=${ctx.chat.id} userId=${ctx.from.id}; se mantienen los filtros generales:`,
      error,
    );
    await next();
    return;
  }
  if (!isVerifiableMember(member)) {
    await next();
    return;
  }

  const restriction = getVerifiedMessageRestriction(
    permissions,
    messageHasMedia(ctx),
  );
  if (!restriction) {
    await next();
    return;
  }

  const reason =
    restriction === "posting_disabled"
      ? "VERIFIED_PERMISSION:can_post=false"
      : "VERIFIED_PERMISSION:can_send_media=false";
  let result: "ok" | "queued" | "error" = "error";
  if (isCerberoExecutionEnabled()) {
    const order = await delegateSecurityCommand({
      groupId: ctx.chat.id,
      action: "DELETE_MESSAGE",
      targetMessageId: ctx.message.message_id,
      idempotencyKey: String(ctx.update.update_id),
      payload: { reason },
    });
    result = order.ok ? "queued" : "error";
  } else {
    const deletion = await deleteMessageById(
      ctx,
      ctx.chat.id,
      ctx.message.message_id,
    );
    result = deletion.ok ? "ok" : "error";
  }

  await logEvent(ctx, ctx.chat.id, "DELETE", {
    targetId: ctx.from.id,
    targetName: ctx.from.first_name,
    result,
    detail:
      result === "queued"
        ? `${reason}; orden enviada, eliminación aún no confirmada`
        : reason,
  });
  await next();
});
