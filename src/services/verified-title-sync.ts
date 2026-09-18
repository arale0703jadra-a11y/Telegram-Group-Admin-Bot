import type { Api } from "grammy";
import { getGroupData } from "../storage/index.js";
import {
  addVerifiedUser,
  getVerifiedUsers,
  getVerifiedUser,
  clearVerifiedTitleLoss,
  markVerifiedTitleLoss,
  revokeVerifiedUser,
} from "./verified-users.js";
import {
  markUserVerified,
  recordObservedUser,
  unmarkUserVerified,
} from "./user-registry.js";

export interface VerifiedTitleSyncResult {
  matched: number;
  created: number;
  updated: number;
  removed: number;
  pendingRemoval: number;
}

function normalizeTitle(title: string): string {
  return title.trim().normalize("NFC");
}

export function hasConfiguredVerifiedTitle(
  customTitle: string | undefined,
  configuredTitles: readonly string[],
): boolean {
  if (!customTitle) return false;
  const normalized = normalizeTitle(customTitle);
  return configuredTitles.some(
    (title) => normalizeTitle(title) === normalized,
  );
}

export async function syncVerifiedAdministrators(
  api: Api,
  groupId: number,
  actorId = 0,
): Promise<VerifiedTitleSyncResult> {
  const data = await getGroupData(groupId);
  if (!data.autoDetectVerifiedTitles) {
    return { matched: 0, created: 0, updated: 0, removed: 0, pendingRemoval: 0 };
  }
  const configuredTitles = data.verifiedTitles;
  const admins = await api.getChatAdministrators(groupId);
  const result: VerifiedTitleSyncResult = {
    matched: 0,
    created: 0,
    updated: 0,
    removed: 0,
    pendingRemoval: 0,
  };
  const matchedIds = new Set<number>();
  const detectedAt = new Date().toISOString();

  for (const admin of admins) {
    if (
      admin.user.is_bot ||
      admin.status !== "administrator" ||
      !hasConfiguredVerifiedTitle(admin.custom_title, configuredTitles)
    ) {
      continue;
    }

    result.matched += 1;
    matchedIds.add(admin.user.id);
    await recordObservedUser(groupId, admin.user, { status: "administrator" });
    const existing = await getVerifiedUser(groupId, admin.user.id);
    if (!existing || existing.verification_method !== "manual") {
      await addVerifiedUser({
        groupId,
        userId: admin.user.id,
        username: admin.user.username,
        displayName: [admin.user.first_name, admin.user.last_name]
          .filter(Boolean)
          .join(" "),
        createdBy: actorId,
        verificationMethod: "detected_custom_title",
        detectedAt,
        customTitleDetected: admin.custom_title,
      });
    }
    await clearVerifiedTitleLoss(groupId, admin.user.id);
    await markUserVerified(
      groupId,
      admin.user.id,
      admin.user.username,
      [admin.user.first_name, admin.user.last_name].filter(Boolean).join(" "),
    );

    if (existing) {
      result.updated += 1;
    } else {
      result.created += 1;
    }
    console.log(
      `[VERIFIED_SYNC]\n` +
        `usuario: ${[admin.user.first_name, admin.user.last_name].filter(Boolean).join(" ") || "sin nombre"}\n` +
        `telegram_id: ${admin.user.id}\n` +
        `custom_title encontrado: ${admin.custom_title}\n` +
        `acción realizada: ${existing?.verification_method === "manual" ? "conservado como manual" : existing ? "actualizado" : "creado"} como detected_custom_title`,
    );
  }

  if (data.autoRemoveVerifiedWhenTitleRemoved) {
    const verifiedUsers = await getVerifiedUsers(groupId);
    for (const user of verifiedUsers) {
      if (user.verification_method === "detected_custom_title" && !matchedIds.has(user.user_id)) {
        const now = Date.now();
        let lossAction = "pérdida pendiente de segunda comprobación/24 horas";
        if (!user.title_lost_at) {
          await markVerifiedTitleLoss(groupId, user.user_id, new Date(now).toISOString());
          result.pendingRemoval += 1;
          console.log(`[VERIFIED_SYNC]\nUsuario detectado: ${user.display_name ?? user.username ?? "sin nombre"}\nID: ${user.user_id}\nTítulo: ninguno configurado\nAcción: primera pérdida registrada`);
        } else if (now - new Date(user.title_lost_at).getTime() >= 24 * 60 * 60 * 1000) {
          await revokeVerifiedUser(groupId, user.user_id);
          await unmarkUserVerified(groupId, user.user_id);
          result.removed += 1;
          lossAction = "verified revocado por retirada del título";
          console.log(`[VERIFIED_SYNC]\nUsuario detectado: ${user.display_name ?? user.username ?? "sin nombre"}\nID: ${user.user_id}\nTítulo: ninguno configurado\nAcción: verified revocado tras 24 horas`);
        } else {
          result.pendingRemoval += 1;
        }
        console.log(
          `[VERIFIED_SYNC]\n` +
            `usuario: ${user.display_name ?? user.username ?? "sin nombre"}\n` +
            `telegram_id: ${user.user_id}\n` +
            `custom_title encontrado: ninguno configurado\n` +
            `acción realizada: ${lossAction}`,
        );
      }
    }
  }

  return result;
}
