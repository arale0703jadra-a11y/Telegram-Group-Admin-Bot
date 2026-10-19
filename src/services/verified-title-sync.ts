import type { Api } from "grammy";
import type { ChatMemberAdministrator } from "@grammyjs/types";
import { OWNER_ID } from "../config.js";
import {
  canRevokeVerifiedAdministrator,
} from "./verified-user-policy.js";
import {
  addVerifiedUser,
  getVerifiedUser,
  getVerifiedUsers,
  revokeVerifiedUser,
  updateVerifiedUser,
} from "./verified-users.js";
import {
  markUserVerified,
  recordObservedUser,
  syncVerifiedUserStates,
  unmarkUserVerified,
} from "./user-registry.js";

export interface VerifiedUserSyncResult {
  administratorsSynchronized: number;
  verifiedUsersSynchronized: number;
  verifiedAdministratorsDemoted: number;
}

export function hasVerifiedCustomTitle(title: string | undefined): boolean {
  return title?.trim().toLocaleLowerCase("es") === "verificada";
}

const REMOVE_ADMIN_RIGHTS = {
  is_anonymous: false,
  can_manage_chat: false,
  can_delete_messages: false,
  can_manage_video_chats: false,
  can_restrict_members: false,
  can_promote_members: false,
  can_change_info: false,
  can_invite_users: false,
  can_post_stories: false,
  can_edit_stories: false,
  can_delete_stories: false,
  can_post_messages: false,
  can_edit_messages: false,
  can_pin_messages: false,
  can_manage_topics: false,
  can_manage_direct_messages: false,
};

async function registerAndDemoteVerifiedAdministrator(
  api: Api,
  groupId: number,
  actorId: number,
  admin: ChatMemberAdministrator,
): Promise<boolean> {
  if (!hasVerifiedCustomTitle(admin.custom_title) || admin.user.is_bot) {
    return false;
  }

  const bot = await api.getMe();
  const botMember = await api.getChatMember(groupId, bot.id);
  const canDemote = botMember.status === "administrator" &&
    botMember.can_promote_members === true;
  const previouslyVerified = await getVerifiedUser(groupId, admin.user.id);
  const allowed = canRevokeVerifiedAdministrator({
    status: admin.status,
    isBot: admin.user.is_bot,
    isVerified: true,
    isProtected: admin.user.id === OWNER_ID,
    botCanPromote: canDemote,
  });
  if (!allowed) {
    console.warn(
      `[VERIFIED_TITLE] No se pudo degradar userId=${admin.user.id} groupId=${groupId}; ` +
        `botCanPromote=${canDemote} protected=${admin.user.id === OWNER_ID}`,
    );
    return false;
  }

  if (previouslyVerified) {
    await updateVerifiedUser(groupId, admin.user.id, {
      username: admin.user.username,
      displayName: [admin.user.first_name, admin.user.last_name]
        .filter(Boolean)
        .join(" "),
    });
  } else {
    await addVerifiedUser({
      groupId,
      userId: admin.user.id,
      username: admin.user.username,
      displayName: [admin.user.first_name, admin.user.last_name]
        .filter(Boolean)
        .join(" "),
      createdBy: actorId,
      verificationMethod: "detected_custom_title",
      detectedAt: new Date().toISOString(),
    });
  }

  try {
    await api.promoteChatMember(groupId, admin.user.id, REMOVE_ADMIN_RIGHTS);
  } catch (error) {
    try {
      await revokeVerifiedUser(groupId, admin.user.id);
    } catch (rollbackError) {
      console.error(
        `[VERIFIED_TITLE] No se pudo retirar el registro tras fallar la degradación userId=${admin.user.id} groupId=${groupId}`,
        rollbackError,
      );
    }
    try {
      await unmarkUserVerified(groupId, admin.user.id);
    } catch (rollbackError) {
      console.error(
        `[VERIFIED_TITLE] No se pudo limpiar la caché local userId=${admin.user.id} groupId=${groupId}`,
        rollbackError,
      );
    }
    throw error;
  }

  await recordObservedUser(groupId, admin.user, { status: "member" });
  await markUserVerified(
    groupId,
    admin.user.id,
    admin.user.username,
    [admin.user.first_name, admin.user.last_name].filter(Boolean).join(" "),
  );
  console.log(
    `[VERIFIED_TITLE] Verificada registrada y degradada userId=${admin.user.id} groupId=${groupId}`,
  );
  return true;
}

export async function syncVerifiedAdministrators(
  api: Api,
  groupId: number,
  actorId: number,
): Promise<VerifiedUserSyncResult> {
  const admins = await api.getChatAdministrators(groupId);
  let administratorsSynchronized = 0;
  let verifiedAdministratorsDemoted = 0;

  for (const admin of admins) {
    if (admin.user.is_bot) continue;
    await recordObservedUser(groupId, admin.user, { status: admin.status });
    administratorsSynchronized += 1;
    if (admin.status !== "administrator" || !hasVerifiedCustomTitle(admin.custom_title)) {
      continue;
    }

    try {
      if (await registerAndDemoteVerifiedAdministrator(api, groupId, actorId, admin)) {
        verifiedAdministratorsDemoted += 1;
      }
    } catch (error) {
      console.error(
        `[VERIFIED_TITLE] Falló la detección/degradación userId=${admin.user.id} groupId=${groupId}`,
        error,
      );
    }
  }

  const verifiedUsers = await getVerifiedUsers(groupId);
  await syncVerifiedUserStates(groupId, verifiedUsers);
  return {
    administratorsSynchronized,
    verifiedUsersSynchronized: verifiedUsers.length,
    verifiedAdministratorsDemoted,
  };
}
