import { FileStore } from "./file.js";
import type { PersistenceStore } from "./interface.js";
import type { GroupData } from "./types.js";

export { FileStore } from "./file.js";
export type { PersistenceStore } from "./interface.js";
export type {
  BanRecord,
  GroupData,
  IndexedUser,
  ModerationEvent,
  ModerationType,
  MuteRecord,
  PromotionConfig,
  PromotionMessages,
  WarnAction,
  WarningEntry,
  WelcomeConfig,
} from "./types.js";

/**
 * Almacén activo: PERSISTENTE en disco (data/storage/<chatId>.json).
 * Las advertencias, silencios, baneos, eventos y configuración de cada
 * grupo sobreviven a los reinicios del bot.
 */
export const store: PersistenceStore = new FileStore();

/**
 * Lee los datos de moderación de un grupo.
 */
export async function getGroupData(chatId: number): Promise<GroupData> {
  return store.loadGroup(chatId);
}

/**
 * Guarda los datos de moderación de un grupo.
 */
export async function saveGroupData(
  chatId: number,
  data: GroupData,
): Promise<void> {
  await store.saveGroup(chatId, data);
}

/**
 * Fuerza el flush inmediato de todos los datos pendientes.
 * Se usa en graceful shutdown para evitar pérdida de datos.
 */
export async function flushStorage(): Promise<void> {
  await store.flushForced();
}