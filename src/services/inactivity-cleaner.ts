import { getMemberSafely, isProtectedMember, isVerifiableMember } from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { getGroupData } from "../storage/index.js";
import type { MyContext } from "../types.js";
import { getAllKnownGroups } from "./group-registry.js";
import {
  getInactiveActivityCandidates,
  warnMissingActivityConfiguration,
  type UserActivityCandidate,
} from "./user-activity.js";
import { isInactivityProtectedUser } from "./inactivity.js";
import { isVerifiedUser } from "./verified-users.js";

export const INACTIVITY_CLEANUP_DAYS = 21;
export const INACTIVITY_CLEANER_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const INACTIVITY_CLEANER_BATCH_SIZE = 50;

export interface InactivityCleanerOptions {
  now?: number;
  batchSize?: number;
}

async function removeCandidate(
  ctx: MyContext,
  chatId: number,
  candidate: UserActivityCandidate,
  cutoffMs: number,
  simulationMode: boolean,
): Promise<"simulated" | "pending_review" | "skipped" | "error"> {
  const { userId } = candidate;
  if (
    candidate.groupId !== chatId ||
    !Number.isSafeInteger(userId) ||
    userId <= 0
  ) {
    return "error";
  }
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
    if (!member) {
      await logEvent(ctx, chatId, "INACTIVITY_REMOVE_ERROR", {
        targetId: userId,
        result: "error",
        detail: "Escaneo omitido: no se pudo verificar el estado actual del usuario.",
      });
      return "error";
    }
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

  const lastActiveAt = Date.parse(candidate.lastActiveAt);
  if (!Number.isFinite(lastActiveAt) || lastActiveAt >= cutoffMs) return "skipped";

  const result = simulationMode ? "simulated" : "pending_review";
  if (simulationMode) {
    await logEvent(ctx, chatId, "INACTIVITY_SCAN", {
      targetId: userId,
      targetName: member.user.first_name,
      result: "queued",
      detail:
        "SIMULACIÓN: última actividad observada superó 21 días, pero ZEUS no " +
        "conserva evidencia de cobertura continua; no se modificó su estado en Telegram.",
    });
  } else {
    await logEvent(ctx, chatId, "INACTIVITY_SCAN", {
      targetId: userId,
      targetName: member.user.first_name,
      result: "queued",
      detail:
        "pending_review: última actividad observada superó 21 días, pero ZEUS " +
        "no conserva evidencia de cobertura continua; no se ejecutó una expulsión.",
    });
  }
  return result;
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
      let storedCandidates: UserActivityCandidate[];
      try {
        storedCandidates = await getInactiveActivityCandidates(group.id, cutoff, {
          limit: 200,
        });
      } catch (error) {
        console.error(
          `[INACTIVITY_CLEANER] No se pudo consultar actividad Supabase groupId=${group.id}; se omite el grupo.`,
          error,
        );
        await logEvent(ctx, group.id, "INACTIVITY_SCAN", {
          result: "error",
          detail: "Depuración omitida: falló la consulta de actividad; no se usarán datos locales como fallback.",
        });
        continue;
      }

      const candidates = storedCandidates.slice(0, batchSize);
      let simulated = 0;
      let pendingReview = 0;
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
        if (result === "simulated") simulated += 1;
        else if (result === "pending_review") pendingReview += 1;
        else if (result === "error") {
          failed += 1;
        } else {
          skipped += 1;
        }
      }

      await logEvent(ctx, group.id, "INACTIVITY_SCAN", {
        result: failed > 0 ? "error" : "ok",
        detail:
          `Candidatos=${candidates.length}; simulados=${simulated}; pendientes de revisión=${pendingReview}; ` +
          `expulsados=0; omitidos=${skipped}; fallidos=${failed}; lote=${batchSize}.`,
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
