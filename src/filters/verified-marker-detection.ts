import { Composer } from "grammy";
import { getGroupData } from "../storage/index.js";
import {
  getVerifiedUserRecord,
} from "../services/verified-users.js";
import { recordVerifiedTagObservation } from "../services/verified-tag-reviews.js";
import { findConfiguredVerifiedMarker } from "../services/verified-marker-detection.js";
import {
  isRecognizedVerifiedMemberTag,
  observeVerifiedMemberTag,
} from "../services/verified-tag-sync.js";
import { isGroupChat } from "../utils/permissions.js";
import type { MyContext } from "../types.js";

const OBSERVATION_COOLDOWN_MS = 60_000;
const MAX_OBSERVATIONS = 10_000;
const recentObservations = new Map<string, number>();

function shouldObserve(key: string, now: number): boolean {
  const lastSeen = recentObservations.get(key);
  if (lastSeen !== undefined && now - lastSeen < OBSERVATION_COOLDOWN_MS) {
    return false;
  }
  recentObservations.delete(key);
  recentObservations.set(key, now);
  if (recentObservations.size > MAX_OBSERVATIONS) {
    const oldest = recentObservations.keys().next().value;
    if (oldest !== undefined) recentObservations.delete(oldest);
  }
  return true;
}

export const verifiedMarkerDetection = new Composer<MyContext>();

verifiedMarkerDetection.on("chat_join_request", async (ctx, next) => {
  if (!isGroupChat(ctx)) {
    await next();
    return;
  }
  const applicant = ctx.chatJoinRequest.from;
  if (applicant.is_bot) {
    await next();
    return;
  }

  try {
    const data = await getGroupData(ctx.chat.id);
    const marker = data.verifiedTagSyncEnabled
      ? findConfiguredVerifiedMarker(
          [
            ctx.chatJoinRequest.bio ?? "",
            applicant.first_name,
            applicant.last_name ?? "",
            applicant.username ?? "",
          ],
          data.verifiedMemberTags,
        )
      : undefined;
    if (marker && shouldObserve(`${ctx.chat.id}:${applicant.id}`, Date.now())) {
      await recordVerifiedTagObservation({
        groupId: ctx.chat.id,
        userId: applicant.id,
        username: applicant.username,
        displayName: [applicant.first_name, applicant.last_name]
          .filter(Boolean)
          .join(" "),
        observedTag: `${marker} (solicitud de ingreso o perfil visible)`,
        status: "pending",
      });
    }
  } catch (error) {
    console.error(
      `[VERIFIED_MARKER] No se pudo revisar solicitud de ingreso groupId=${ctx.chat.id} userId=${applicant.id}:`,
      error,
    );
  }
  await next();
});

verifiedMarkerDetection.on("chat_member", async (ctx, next) => {
  if (!isGroupChat(ctx)) {
    await next();
    return;
  }
  const member = ctx.chatMember.new_chat_member;
  if (
    member.user.is_bot ||
    (member.status !== "member" && member.status !== "restricted")
  ) {
    await next();
    return;
  }

  try {
    const data = await getGroupData(ctx.chat.id);
    if (!data.verifiedTagSyncEnabled) {
      await next();
      return;
    }
    const memberTag = member.tag?.trim();
    if (isRecognizedVerifiedMemberTag(memberTag, data.verifiedMemberTags)) {
      await observeVerifiedMemberTag({
        groupId: ctx.chat.id,
        member,
        recognizedTags: data.verifiedMemberTags,
      });
      await next();
      return;
    }
    const marker = findConfiguredVerifiedMarker(
      [
        member.user.first_name,
        member.user.last_name ?? "",
        member.user.username ?? "",
      ],
      data.verifiedMemberTags,
    );
    if (marker && shouldObserve(`${ctx.chat.id}:${member.user.id}`, Date.now())) {
      const existing = await getVerifiedUserRecord(ctx.chat.id, member.user.id);
      if (!(existing?.verified && existing.revoked_at === null)) {
        await recordVerifiedTagObservation({
          groupId: ctx.chat.id,
          userId: member.user.id,
          username: member.user.username,
          displayName: [member.user.first_name, member.user.last_name]
            .filter(Boolean)
            .join(" "),
          observedTag: `${marker} (etiqueta o perfil visible)`,
          status: "pending",
        });
      }
    }
  } catch (error) {
    console.error(
      `[VERIFIED_MARKER] No se pudo revisar actualización de miembro groupId=${ctx.chat.id} userId=${member.user.id}:`,
      error,
    );
  }
  await next();
});

verifiedMarkerDetection.on("message", async (ctx, next) => {
  if (!isGroupChat(ctx) || !ctx.from || ctx.from.is_bot || !ctx.message) {
    await next();
    return;
  }

  try {
    const groupId = ctx.chat.id;
    const userId = ctx.from.id;
    const data = await getGroupData(groupId);
    if (!data.verifiedTagSyncEnabled) {
      await next();
      return;
    }

    const marker = findConfiguredVerifiedMarker(
      [
        ctx.message.text ?? "",
        ctx.message.caption ?? "",
        ctx.from.first_name,
        ctx.from.last_name ?? "",
        ctx.from.username ?? "",
      ],
      data.verifiedMemberTags,
    );
    if (!marker || !shouldObserve(`${groupId}:${userId}`, Date.now())) {
      await next();
      return;
    }

    const existing = await getVerifiedUserRecord(groupId, userId);
    if (existing?.verified && existing.revoked_at === null) {
      await next();
      return;
    }

    await recordVerifiedTagObservation({
      groupId,
      userId,
      username: ctx.from.username,
      displayName: [ctx.from.first_name, ctx.from.last_name]
        .filter(Boolean)
        .join(" "),
      observedTag: `${marker} (coincidencia en mensaje o perfil visible)`,
      status: "pending",
    });
  } catch (error) {
    console.error(
      `[VERIFIED_MARKER] No se pudo registrar candidata groupId=${ctx.chat.id} userId=${ctx.from.id}:`,
      error,
    );
  }

  await next();
});
