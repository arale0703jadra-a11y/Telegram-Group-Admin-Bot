import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  BanRecord,
  GroupData,
  IndexedUser,
  ModerationEvent,
  MuteRecord,
  WarningEntry,
} from "./types.js";
import type { PersistenceStore } from "./interface.js";
import { initialGroupData } from "./initial.js";
import type { PromotionConfig } from "./types.js";

/**
 * Almacenamiento PERSISTENTE en disco, un archivo JSON por grupo:
 *   data/storage/<chatId>.json
 *
 * Los datos de moderación (advertencias, silencios, baneos, eventos y
 * configuración) sobreviven a los reinicios del bot. Se guarda con un
 * pequeño retardo (debounce) para no bloquear el procesamiento de
 * mensajes con escrituras síncronas en cada mensaje.
 */
export class FileStore implements PersistenceStore {
  private readonly cache = new Map<number, GroupData>();
  private readonly dirty = new Set<number>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  private storageDir(): string {
    return resolve(process.cwd(), "data", "storage");
  }

  private filePath(chatId: number): string {
    return resolve(this.storageDir(), `${chatId}.json`);
  }

  async loadGroup(chatId: number): Promise<GroupData> {
    const cached = this.cache.get(chatId);
    if (cached) {
      return structuredClone(cached);
    }

    let data = initialGroupData();
    try {
      const file = this.filePath(chatId);
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<
          string,
          unknown
        >;
        data = normalizeGroupData(parsed);
      }
    } catch (error) {
      console.error(`[STORAGE] No se pudo leer el grupo ${chatId}:`, error);
    }

    this.cache.set(chatId, data);
    return structuredClone(data);
  }

  async saveGroup(chatId: number, data: GroupData): Promise<void> {
    this.cache.set(chatId, structuredClone(data));
    this.dirty.add(chatId);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flushAll();
    }, 250);
  }

  private async flushAll(): Promise<void> {
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const chatId of ids) {
      const data = this.cache.get(chatId);
      if (!data) {
        continue;
      }
      try {
        const file = this.filePath(chatId);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
      } catch (error) {
        console.error(`[STORAGE] No se pudo guardar el grupo ${chatId}:`, error);
        this.dirty.add(chatId);
      }
    }
  }

  /**
   * Fuerza el flush inmediato de todos los datos pendientes.
   * Se usa en graceful shutdown para evitar pérdida de datos.
   */
  async flushForced(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flushAll();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Recompone los datos leídos de disco garantizando que TODAS las
 * secciones existan con su forma actual. Normaliza también el formato
 * antiguo de advertencias (número suelto) al nuevo (lista de entradas).
 */
function normalizeGroupData(parsed: Record<string, unknown>): GroupData {
  const base = initialGroupData();

  return {
    ...base,
    warnings: normalizeWarnings(parsed.warnings),
    warnLimit:
      typeof parsed.warnLimit === "number" && parsed.warnLimit > 0
        ? parsed.warnLimit
        : base.warnLimit,
    warnAction:
      parsed.warnAction === "mute" ||
      parsed.warnAction === "ban" ||
      parsed.warnAction === "none"
        ? parsed.warnAction
        : base.warnAction,
    mutedUsers: isRecord(parsed.mutedUsers)
      ? (parsed.mutedUsers as Record<string, MuteRecord>)
      : {},
    bannedUsers: isRecord(parsed.bannedUsers)
      ? (parsed.bannedUsers as Record<string, BanRecord>)
      : {},
    recentMessages: Array.isArray(parsed.recentMessages)
      ? (parsed.recentMessages as number[])
      : [],
    indexedUsers: isRecord(parsed.indexedUsers)
      ? (parsed.indexedUsers as Record<string, IndexedUser>)
      : {},
    events: Array.isArray(parsed.events)
      ? (parsed.events as ModerationEvent[])
      : [],
    welcome: {
      enabled: true,
      message: "",
      ...(isRecord(parsed.welcome) ? parsed.welcome : {}),
    },
    promotion: normalizePromotion(parsed.promotion, base.promotion),
  };
}

function normalizePromotion(
  raw: unknown,
  fallback: PromotionConfig,
): PromotionConfig {
  if (!isRecord(raw)) {
    return fallback;
  }
  const messages = isRecord(raw.messages) ? raw.messages : {};
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
    dictionary: Array.isArray(raw.dictionary)
      ? raw.dictionary.filter((item): item is string => typeof item === "string")
      : fallback.dictionary,
    verificationContacts: Array.isArray(raw.verificationContacts)
      ? raw.verificationContacts.filter(
          (item): item is string => typeof item === "string",
        )
      : fallback.verificationContacts,
    verifiedUsers: isRecord(raw.verifiedUsers)
      ? (raw.verifiedUsers as Record<string, boolean>)
      : fallback.verifiedUsers,
    recurrenceMuteMinutes: Array.isArray(raw.recurrenceMuteMinutes)
      ? raw.recurrenceMuteMinutes.filter(
          (item): item is number => typeof item === "number" && item >= 0,
        )
      : fallback.recurrenceMuteMinutes,
    messages: {
      ...fallback.messages,
      promotionWarning:
        typeof messages.promotionWarning === "string"
          ? messages.promotionWarning
          : fallback.messages.promotionWarning,
      promotionRemoved:
        typeof messages.promotionRemoved === "string"
          ? messages.promotionRemoved
          : fallback.messages.promotionRemoved,
      promotionMuted:
        typeof messages.promotionMuted === "string"
          ? messages.promotionMuted
          : fallback.messages.promotionMuted,
      linkWarning:
        typeof messages.linkWarning === "string"
          ? messages.linkWarning
          : fallback.messages.linkWarning,
      verificationRequired:
        typeof messages.verificationRequired === "string"
          ? messages.verificationRequired
          : fallback.messages.verificationRequired,
    },
    infractions: isRecord(raw.infractions)
      ? (raw.infractions as Record<string, number>)
      : {},
  };
}

function normalizeWarnings(
  raw: unknown,
): Record<string, WarningEntry[]> {
  if (!isRecord(raw)) {
    return {};
  }

  const result: Record<string, WarningEntry[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      result[key] = value as WarningEntry[];
      continue;
    }
    // Formato antiguo: un número suelto de advertencias.
    const count = Math.max(0, Number(value) || 0);
    const entries: WarningEntry[] = [];
    for (let i = 0; i < count; i += 1) {
      const date = new Date(
        Date.now() - (count - i) * 24 * 60 * 60 * 1000,
      ).toISOString();
      entries.push({
        id: `legacy-${key}-${i}`,
        userId: Number(key),
        adminId: 0,
        adminName: "Registro migrado",
        date,
        reason: "Asignada antes de guardar el motivo",
      });
    }
    result[key] = entries;
  }
  return result;
}