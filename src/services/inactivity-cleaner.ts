import { isDeletedTelegramAccount } from "../filters/deleted-accounts.js";
import { getBotRights, getMemberSafely, isProtectedMember, isVerifiableMember } from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { getGroupData } from "../storage/index.js";
import type { IndexedUser } from "../storage/types.js";
import type { MyContext } from "../types.js";
import { getAllKnownGroups } from "./group-registry.js";
import {
  getInactiveActivityCandidates,
  markTelegramAccountDeleted,
  warnMissingActivityConfiguration,
  type UserActivityCandidate,
} from "./user-activity.js";
import { isInactivityProtectedUser } from "./inactivity.js";
import { isVerifiedUser } from "./verified-users.js";
import { callWithRetryAfter, runChatActionExclusive } from "../utils/safety.js";
import { invalidateSecurityCaches } from "../utils/member-cache.js";

export const INACTIVITY_CLEANUP_DAYS = 21;
export const INACTIVITY_CLEANER_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const INACTIVITY_CLEANER_BATCH_SIZE = 50;
export const INACTIVITY_CLEANER_ACTION_DELAY_MS = 1_000;

export interface InactivityCleanerOptions {
  now?: number;
  batchSize?: number;
  actionDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function localCandidate(
  groupId: number,
  user: IndexedUser,
  cutoffMs: number,
): UserActivityCandidate | undefined {
  const lastSeen = user.lastSeen ?? user.joinedAt;
  if (!lastSeen || lastSeen * 1000 >= cutoffMs) return undefined;
  return {
    groupId,
    userId: user.id,
    lastActiveAt: new Date(lastSeen * 1000).toISOString(),
    isDeleted: false,
  };
}

export function mergeInactivityCandidates(
  candidates: readonly UserActivityCandidate[],
  indexedUsers: Record<string, IndexedUser>,
  groupId: number,
  cutoffMs: number,
): UserActivityCandidate[] {
  const byUser = new Map<number, UserActivityCandidate>();
  for (const candidate of candidates) {
    if (candidate.groupId === groupId) byUser.set(candidate.userId, candidate);
  }
  for (const user of Object.values(indexedUsers)) {
    const candidate = localCandidate(groupId, user, cutoffMs);
    if (!candidate) continue;
    const current = byUser.get(candidate.userId);
    if (
      !current ||
      Date.parse(candidate.lastActiveAt) > Date.parse(current.lastActiveAt)
    ) {
      byUser.set(candidate.userId, {
        ...candidate,
        isDeleted: current?.isDeleted ?? false,
      });
    }
  }
  return [...byUser.values()]
    .sort((a, b) => {
      if (a.isDeleted !== b.isDeleted) return a.isDeleted ? -1 : 1;
      return Date.parse(a.lastActiveAt) - Date.parse(b.lastActiveAt);
    });
}

async function removeCandidate(
  ctx: MyContext,
  chatId: number,
  candidate: UserActivityCandidate,
  cutoffMs: number,
  simulationMode: boolean,
): Promise<"removed" | "simulated" | "skipped" | "error"> {
  const { userId } = candidate;
  if (await isInactivityProtectedUser(userId)) return "skipped";
  const member = await getMemberSafely(ctx, chatId, userId);
  if (
    !member ||
    member.user.is_bot ||
    member.status === "left" ||
    member.status === "kicked" ||
    isProtectedMember(member) ||
    !isVerifiableMember(member)
  ) {
    return "skipped";
  }

  let verified;
  try {
    verified = await isVerifiedUser(chatId, userId);
  } catch (error) {
    console.error(
      `[INACTIVITY_CLEANER] No se pudo confirmar verificación groupId=${chatId} userId=${userId}; se omite.`,
      error,
    );
    return "skipped";
  }
  if (verified) return "skipped";

  const deleted = isDeletedTelegramAccount(member.user);
  const inactive = Date.parse(candidate.lastActiveAt) < cutoffMs;
  if (!deleted && !candidate.isDeleted && !inactive) return "skipped";

  const rights = await getBotRights(ctx, chatId);
  if (!rights.canRestrict) {
    await logEvent(ctx, chatId, "INACTIVITY_REMOVE_ERROR", {
      targetId: userId,
      targetName: member.user.first_name,
      result: "error",
      detail: "Depuración automática omitida: falta can_restrict_members.",
    });
    return "error";
  }

  if (simulationMode) {
    await logEvent(ctx, chatId, "INACTIVITY_SCAN", {
      targetId: userId,
      targetName: member.user.first_name,
      result: "queued",
      detail: "SIMULACIÓN: candidato elegible; no se modificó su estado en Telegram.",
    });
    return "simulated";
  }

  try {
    if (deleted && !candidate.isDeleted) {
      await markTelegramAccountDeleted(chatId, userId);
    }
    await runChatActionExclusive(chatId, async () => {
      await callWithRetryAfter(() => ctx.api.banChatMember(chatId, userId));
      invalidateSecurityCaches(chatId, userId);
      await callWithRetryAfter(() =>
        ctx.api.unbanChatMember(chatId, userId, { only_if_banned: true }),
      );
      invalidateSecurityCaches(chatId, userId);
    });
    await logEvent(ctx, chatId, "INACTIVITY_REMOVE", {
      targetId: userId,
      targetName: member.user.first_name,
      result: "ok",
      detail: deleted || candidate.isDeleted
        ? "Cuenta marcada como eliminada expulsada."
        : `Usuario sin actividad durante al menos ${INACTIVITY_CLEANUP_DAYS} días expulsado.`,
    });
    return "removed";
  } catch (error) {
    console.error(
      `[INACTIVITY_CLEANER] Falló expulsión groupId=${chatId} userId=${userId}:`,
      error,
    );
    await logEvent(ctx, chatId, "INACTIVITY_REMOVE_ERROR", {
      targetId: userId,
      result: "error",
      detail: "Falló la expulsión automática; se reintentará en el siguiente ciclo.",
    });
    return "error";
  }
}

export async function runInactivityCleaner(
  ctx: MyContext,
  options: InactivityCleanerOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  const cutoffMs = now - INACTIVITY_CLEANUP_DAYS * 24 * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs).toISOString();
  const batchSize = Math.min(
    INACTIVITY_CLEANER_BATCH_SIZE,
    Math.max(1, Math.floor(options.batchSize ?? INACTIVITY_CLEANER_BATCH_SIZE)),
  );
  const delayMs = Math.max(0, options.actionDelayMs ?? INACTIVITY_CLEANER_ACTION_DELAY_MS);
  const wait = options.sleep ?? sleep;

  for (const group of getAllKnownGroups()) {
    try {
      const data = await getGroupData(group.id);
      if (!data.inactivity.enabled) continue;
      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        warnMissingActivityConfiguration();
        await logEvent(ctx, group.id, "INACTIVITY_SCAN", {
          result: "error",
          detail: "Depuración omitida: no se puede confirmar el estado de verificación en Supabase.",
        });
        continue;
      }
      const rights = await getBotRights(ctx, group.id);
      if (!rights.canRestrict) {
        await logEvent(ctx, group.id, "INACTIVITY_SCAN", {
          result: "error",
          detail: "Depuración omitida: el bot requiere can_restrict_members.",
        });
        continue;
      }

      let storedCandidates: UserActivityCandidate[] = [];
      try {
        storedCandidates = await getInactiveActivityCandidates(group.id, cutoff, {
          limit: 200,
        });
      } catch (error) {
        console.error(
          `[INACTIVITY_CLEANER] No se pudo consultar actividad Supabase groupId=${group.id}; se usarán solo los registros locales disponibles.`,
          error,
        );
      }

      const candidates = mergeInactivityCandidates(
        storedCandidates,
        data.indexedUsers,
        group.id,
        cutoffMs,
      ).slice(0, batchSize);
      let removed = 0;
      let simulated = 0;
      let skipped = 0;
      let failed = 0;
      const simulationMode = data.inactivity.simulationMode !== false;

      for (const candidate of candidates) {
        const result = await removeCandidate(
          ctx,
          group.id,
          candidate,
          cutoffMs,
          simulationMode,
        );
        if (result === "removed") {
          removed += 1;
          if (delayMs > 0) await wait(delayMs);
        } else if (result === "simulated") {
          simulated += 1;
        } else if (result === "error") {
          failed += 1;
        } else {
          skipped += 1;
        }
      }

      await logEvent(ctx, group.id, "INACTIVITY_SCAN", {
        result: failed > 0 ? "error" : "ok",
        detail:
          `Candidatos=${candidates.length}; simulados=${simulated}; expulsados=${removed}; ` +
          `omitidos=${skipped}; fallidos=${failed}; lote=${batchSize}.`,
      });
    } catch (error) {
      console.error(
        `[INACTIVITY_CLEANER] Falló el ciclo groupId=${group.id}:`,
        error,
      );
      await logEvent(ctx, group.id, "INACTIVITY_REMOVE_ERROR", {
        result: "error",
        detail: "Falló la depuración del grupo; se reintentará en el siguiente ciclo.",
      });
    }
  }
}
