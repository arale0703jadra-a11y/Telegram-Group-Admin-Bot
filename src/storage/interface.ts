import type { GroupData } from "./types.js";

/**
 * Contrato de la capa de persistencia.
 *
 * La implementación actual es en memoria (MemoryStore). Para conectar
 * Supabase en el futuro basta con crear un `SupabaseStore` que
 * implemente esta misma interfaz y usarlo en `src/storage/index.ts`.
 */
export interface PersistenceStore {
  loadGroup(chatId: number): Promise<GroupData>;
  saveGroup(chatId: number, data: GroupData): Promise<void>;
  flushForced(): Promise<void>;
}