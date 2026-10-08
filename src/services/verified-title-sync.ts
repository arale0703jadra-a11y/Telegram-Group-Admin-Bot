import type { Api } from "grammy";
import { getVerifiedUsers } from "./verified-users.js";
import { recordObservedUser, syncVerifiedUserStates } from "./user-registry.js";

export interface VerifiedUserSyncResult {
  administratorsSynchronized: number;
  verifiedUsersSynchronized: number;
}

export async function syncVerifiedAdministrators(
  api: Api,
  groupId: number,
): Promise<VerifiedUserSyncResult> {
  const admins = await api.getChatAdministrators(groupId);
  let administratorsSynchronized = 0;

  for (const admin of admins) {
    if (admin.user.is_bot) continue;
    await recordObservedUser(groupId, admin.user, { status: admin.status });
    administratorsSynchronized += 1;
  }

  const verifiedUsers = await getVerifiedUsers(groupId);
  await syncVerifiedUserStates(groupId, verifiedUsers);
  return {
    administratorsSynchronized,
    verifiedUsersSynchronized: verifiedUsers.length,
  };
}
