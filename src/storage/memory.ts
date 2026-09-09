import type { GroupData } from "./types.js";
import type { PersistenceStore } from "./interface.js";
import { initialGroupData } from "./initial.js";

/**
 * Implementación en memoria del almacenamiento.
 *
 * Útil como referencia o para pruebas. El almacén ACTIVO del bot es
 * FileStore (persistente en disco), no esta clase.
 * `structuredClone` evita que quien lee mute el objeto compartido.
 */
export class MemoryStore implements PersistenceStore {
  private readonly groups = new Map<number, GroupData>();

  async loadGroup(chatId: number): Promise<GroupData> {
    const existing = this.groups.get(chatId);
    return structuredClone(existing ?? initialGroupData());
  }

  async saveGroup(chatId: number, data: GroupData): Promise<void> {
    this.groups.set(chatId, structuredClone(data));
  }

  async flushForced(): Promise<void> {
    // En memoria no hay nada que flush
  }
}