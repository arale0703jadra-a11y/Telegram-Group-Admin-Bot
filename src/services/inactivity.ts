import { getAllKnownGroups } from "./group-registry.js";
import { getGroupData, saveGroupData } from "../storage/index.js";
import {
  getBotRights,
  getMemberSafely,
  isProtectedMember,
  isVerifiableMember,
} from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { OWNER_ID } from "../config.js";
import type { MyContext } from "../types.js";
import type { IndexedUser } from "../storage/types.js";

export interface InactiveUser extends IndexedUser {
  inactiveDays: number;
  referenceAt: number;
}

function thresholdDays(data: Awaited<ReturnType<typeof getGroupData>>): number {
  return data.inactivity.customDays ?? data.inactivity.inactivityDays;
}

export async function getInactiveUsers(
  ctx: MyContext,
  chatId: number,
): Promise<InactiveUser[]> {
  const data = await getGroupData(chatId);
  if (!data.inactivity.enabled) return [];
  const threshold = thresholdDays(data);
  const now = Math.floor(Date.now() / 1000);
  const result: InactiveUser[] = [];

  for (const user of Object.values(data.indexedUsers)) {
    const member = await getMemberSafely(ctx, chatId, user.id);
    if (!member) {
      await logEvent(ctx, chatId, "INACTIVITY_REMOVE_ERROR", {
        targetId: user.id,
        result: "error",
        detail: "Escaneo omitido: no se pudo verificar el estado actual del usuario.",
      });
      continue;
    }
    if (
      member.user.is_bot ||
      member.status === "left" ||
      member.status === "kicked" ||
      isProtectedMember(member) ||
      !isVerifiableMember(member) ||
      OWNER_ID === user.id
    ) {
      continue;
    }
    const referenceAt = user.lastSeen ?? user.joinedAt;
    if (!referenceAt) continue;
    const inactiveDays = Math.floor((now - referenceAt) / 86400);
    if (inactiveDays >= threshold) {
      result.push({ ...user, inactiveDays, referenceAt });
    }
  }
  return result.sort((a, b) => b.inactiveDays - a.inactiveDays);
}

export async function removeInactiveUser(
  ctx: MyContext,
  chatId: number,
  userId: number,
): Promise<"removed" | "skipped" | "error"> {
  const data = await getGroupData(chatId);
  if (!data.inactivity.enabled) {
    return "skipped";
  }
  const user = data.indexedUsers[String(userId)];
  const threshold = thresholdDays(data);
  const referenceAt = user?.lastSeen ?? user?.joinedAt;
  const now = Math.floor(Date.now() / 1000);
  if (!user || !referenceAt || now - referenceAt < threshold * 86400) {
    await logEvent(ctx, chatId, "INACTIVITY_REMOVE_ERROR", {
      targetId: userId,
      result: "error",
      detail: "Usuario ya no cumple el umbral de inactividad.",
    });
    return "skipped";
  }
  const member = await getMemberSafely(ctx, chatId, userId);
  if (
    !member ||
    member.user.is_bot ||
    member.status === "left" ||
    member.status === "kicked" ||
    isProtectedMember(member) ||
    !isVerifiableMember(member) ||
    OWNER_ID === userId
  ) {
    await logEvent(ctx, chatId, "INACTIVITY_REMOVE_ERROR", {
      targetId: userId,
      result: "error",
      detail: "Usuario no elegible o estado no verificable.",
    });
    return "skipped";
  }
  const rights = await getBotRights(ctx, chatId);
  if (!rights.canRestrict) {
    await logEvent(ctx, chatId, "INACTIVITY_REMOVE_ERROR", {
      targetId: userId,
      result: "error",
      detail: "Sin permisos para expulsar.",
    });
    return "error";
  }
  try {
    await ctx.api.banChatMember(chatId, userId);
    await ctx.api.unbanChatMember(chatId, userId, { only_if_banned: false });
    await logEvent(ctx, chatId, "INACTIVITY_REMOVE", {
      targetId: userId,
      result: "ok",
      detail: "Usuario inactivo expulsado.",
    });
    return "removed";
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 240) : "Error desconocido";
    await logEvent(ctx, chatId, "INACTIVITY_REMOVE_ERROR", {
      targetId: userId,
      result: "error",
      detail,
    });
    return "error";
  }
}

export async function runInactivityScan(ctx: MyContext): Promise<void> {
  for (const group of getAllKnownGroups()) {
    try {
      const data = await getGroupData(group.id);
      if (!data.inactivity.enabled) continue;
      const rights = await getBotRights(ctx, group.id);
      if (!rights.canRestrict) {
        await logEvent(ctx, group.id, "INACTIVITY_SCAN", {
          result: "error",
          detail: "Escaneo omitido: el bot no está presente como administrador con permisos.",
        });
        continue;
      }
      const candidates = await getInactiveUsers(ctx, group.id);
      for (const candidate of candidates) {
        await removeInactiveUser(ctx, group.id, candidate.id);
      }
      await logEvent(ctx, group.id, "INACTIVITY_SCAN", {
        result: "ok",
        detail: `Candidatos revisados: ${candidates.length}`,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 240) : "Error desconocido";
      await logEvent(ctx, group.id, "INACTIVITY_REMOVE_ERROR", {
        result: "error",
        detail: `Escaneo del grupo fallido: ${detail}`,
      });
    }
  }
}
