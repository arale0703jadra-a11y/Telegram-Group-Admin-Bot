import type { ChatMember, ChatPermissions } from "@grammyjs/types";
import type { MyContext } from "../types.js";
import { isConfiguredAdminId } from "../config.js";
import type { GroupData } from "../storage/types.js";
import {
  getBotRights,
  getMemberSafely,
} from "../moderation/actions.js";
import { invalidateSecurityCaches } from "../utils/member-cache.js";
import { callWithRetryAfter } from "../utils/safety.js";
import { isRecentEmergencyMember } from "../filters/anti-raid-engine.js";

export const EMERGENCY_MEMBER_PERMISSIONS: ChatPermissions = {
  can_send_messages: true,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_react_to_messages: true,
  can_change_info: false,
  can_invite_users: false,
  can_edit_tag: false,
  can_pin_messages: false,
  can_manage_topics: false,
};

const NORMAL_MEMBER_PERMISSIONS: ChatPermissions = {
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
  can_edit_tag: false,
  can_pin_messages: false,
  can_manage_topics: false,
  can_change_info: false,
};

const PERMISSION_KEYS: readonly (keyof ChatPermissions)[] = [
  "can_send_messages",
  "can_send_audios",
  "can_send_documents",
  "can_send_photos",
  "can_send_videos",
  "can_send_video_notes",
  "can_send_voice_notes",
  "can_send_polls",
  "can_send_other_messages",
  "can_add_web_page_previews",
  "can_react_to_messages",
  "can_invite_users",
  "can_edit_tag",
  "can_pin_messages",
  "can_manage_topics",
  "can_change_info",
];

function isEmergencyRestriction(member: ChatMember): boolean {
  if (member.status !== "restricted") return false;
  return PERMISSION_KEYS.every(
    (key) => member[key] === EMERGENCY_MEMBER_PERMISSIONS[key],
  );
}

function memberDefaultPermissions(value: unknown): ChatPermissions {
  if (typeof value !== "object" || value === null) {
    return NORMAL_MEMBER_PERMISSIONS;
  }
  const permissions: ChatPermissions = {};
  for (const key of PERMISSION_KEYS) {
    const permission = (value as Record<string, unknown>)[key];
    if (typeof permission === "boolean") permissions[key] = permission;
  }
  return Object.keys(permissions).length > 0
    ? permissions
    : NORMAL_MEMBER_PERMISSIONS;
}

function emergencyUntil(
  joinedAt: number,
  emergencyExpiresAt: number,
): number {
  return Math.min(
    emergencyExpiresAt,
    joinedAt * 1000 + 48 * 60 * 60 * 1000,
  );
}

export interface EmergencyRestrictionResult {
  restricted: number;
  failed: number;
}

export async function restrictRecentMembers(
  ctx: MyContext,
  chatId: number,
  data: GroupData,
  now: number,
): Promise<EmergencyRestrictionResult> {
  const result: EmergencyRestrictionResult = { restricted: 0, failed: 0 };
  const expiresAt =
    data.emergency.expiresAt ??
    now + data.antiRaid.emergencyMinutes * 60 * 1000;
  if (!data.emergency.restrictedUsers) data.emergency.restrictedUsers = {};

  const rights = await getBotRights(ctx, chatId);
  if (!rights.canRestrict) {
    console.error(
      `[EMERGENCY] Sin permiso para restringir miembros en el grupo ${chatId}.`,
    );
    result.failed = 1;
    return result;
  }

  for (const [userKey, tracked] of Object.entries(data.indexedUsers)) {
    const userId = Number(userKey);
    if (
      !Number.isSafeInteger(userId) ||
      userId <= 0 ||
      isConfiguredAdminId(userId) ||
      data.emergency.restrictedUsers[userKey] ||
      !isRecentEmergencyMember(tracked.joinedAt, now) ||
      tracked.joinedAt === undefined
    ) {
      continue;
    }

    const until = emergencyUntil(tracked.joinedAt, expiresAt);
    const untilDate = Math.ceil(until / 1000);
    if (untilDate <= Math.floor(now / 1000) + 30) continue;

    invalidateSecurityCaches(chatId, userId);
    const member = await getMemberSafely(ctx, chatId, userId);
    if (!member) {
      result.failed += 1;
      console.error(
        `[EMERGENCY] No se pudo verificar userId=${userId} groupId=${chatId}; se omite la restricción.`,
      );
      continue;
    }
    if (member.status !== "member") {
      continue;
    }

    try {
      await callWithRetryAfter(() =>
        ctx.api.restrictChatMember(
          chatId,
          userId,
          EMERGENCY_MEMBER_PERMISSIONS,
          { until_date: untilDate },
        ),
      );
      invalidateSecurityCaches(chatId, userId);
      data.emergency.restrictedUsers[userKey] = untilDate;
      result.restricted += 1;
    } catch (error) {
      result.failed += 1;
      console.error(
        `[EMERGENCY] No se pudo restringir userId=${userId} groupId=${chatId}:`,
        error,
      );
    }
  }
  return result;
}

export async function restoreEmergencyRestrictions(
  ctx: MyContext,
  chatId: number,
  data: GroupData,
): Promise<boolean> {
  const userKeys = Object.keys(data.emergency.restrictedUsers ?? {});
  if (userKeys.length === 0) return true;

  const rights = await getBotRights(ctx, chatId);
  if (!rights.canRestrict) {
    console.error(
      `[EMERGENCY] No se puede restaurar a los miembros del grupo ${chatId}: falta can_restrict_members.`,
    );
    return false;
  }

  let failed = false;
  let defaultPermissions: ChatPermissions = NORMAL_MEMBER_PERMISSIONS;
  try {
    const chat = await ctx.api.getChat(chatId);
    if ("permissions" in chat) {
      defaultPermissions = memberDefaultPermissions(chat.permissions);
    }
  } catch (error) {
    failed = true;
    console.error(
      `[EMERGENCY] No se pudieron consultar los permisos predeterminados del grupo ${chatId}:`,
      error,
    );
  }
  if (failed) return false;

  for (const userKey of userKeys) {
    const userId = Number(userKey);
    if (!Number.isSafeInteger(userId) || userId <= 0) continue;
    invalidateSecurityCaches(chatId, userId);
    const member = await getMemberSafely(ctx, chatId, userId);
    if (!member) {
      failed = true;
      console.error(
        `[EMERGENCY] No se pudo verificar userId=${userId} groupId=${chatId} al restaurar permisos.`,
      );
      continue;
    }
    if (member.status !== "restricted") continue;
    if (!isEmergencyRestriction(member)) {
      delete data.emergency.restrictedUsers?.[userKey];
      continue;
    }
    try {
      await callWithRetryAfter(() =>
        ctx.api.restrictChatMember(chatId, userId, defaultPermissions, {
          until_date: 0,
        }),
      );
      invalidateSecurityCaches(chatId, userId);
      delete data.emergency.restrictedUsers?.[userKey];
    } catch (error) {
      failed = true;
      console.error(
        `[EMERGENCY] No se pudo restaurar userId=${userId} groupId=${chatId}:`,
        error,
      );
    }
  }
  return !failed;
}
