import type { MyContext } from "../types.js";
import { getGroupData, saveGroupData } from "../storage/index.js";
import type { ModerationType } from "../storage/types.js";

export interface EventLogInfo {
  targetId?: number;
  targetName?: string;
  result: "ok" | "error";
  detail?: string;
}

const MAX_EVENTS_PER_GROUP = 300;

/**
 * Registra un evento de moderación en el grupo indicado.
 * Los eventos quedan guardados en la capa de almacenamiento para
 * poder consultarlos después (cuadro "Actividad → Moderación").
 */
export async function logEvent(
  ctx: MyContext,
  chatId: number,
  type: ModerationType,
  info: EventLogInfo,
): Promise<void> {
  try {
    const data = await getGroupData(chatId);
    data.events.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chatId,
      type,
      adminId: ctx.from?.id ?? 0,
      adminName: ctx.from?.first_name ?? "Desconocido",
      targetId: info.targetId,
      targetName: info.targetName,
      date: new Date().toISOString(),
      result: info.result,
      detail: info.detail,
    });
    if (data.events.length > MAX_EVENTS_PER_GROUP) {
      data.events = data.events.slice(-MAX_EVENTS_PER_GROUP);
    }
    await saveGroupData(chatId, data);
  } catch {
    // El registro no debe romper la acción de moderación.
  }
}