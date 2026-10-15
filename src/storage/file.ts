import {
  existsSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  BanRecord,
  ActivityMessage,
  AutomaticMessageConfig,
  GroupData,
  IndexedUser,
  ModerationEvent,
  MuteRecord,
  WarningEntry,
} from "./types.js";
import { MAX_ACTIVITY_MESSAGES } from "./types.js";
import type { PersistenceStore } from "./interface.js";
import { DEFAULT_PROMOTION_STATISTICS, initialGroupData } from "./initial.js";
import type { IllegalContentConfig, PromotionConfig } from "./types.js";

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
  private readonly corruptGroups = new Set<number>();
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
        try {
          const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<
            string,
            unknown
          >;
          data = normalizeGroupData(parsed);
        } catch (error) {
          this.corruptGroups.add(chatId);
          const backup = `${file}.corrupt-${Date.now()}.bak`;
          console.error(
            `[STORAGE] JSON corrupto en el grupo ${chatId}; se conserva el original y se crea ${backup}:`,
            error,
          );
          copyFileSync(file, backup);
        }
      }
    } catch (error) {
      console.error(`[STORAGE] No se pudo leer el grupo ${chatId}:`, error);
    }

    this.cache.set(chatId, data);
    return structuredClone(data);
  }

  async loadGroupStrict(chatId: number): Promise<GroupData> {
    const file = this.filePath(chatId);
    if (!existsSync(file)) return initialGroupData();
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return normalizeGroupData(parsed);
  }

  async saveGroup(chatId: number, data: GroupData): Promise<void> {
    if (this.corruptGroups.has(chatId)) {
      console.error(
        `[STORAGE] No se sobrescribe el archivo corrupto del grupo ${chatId}; requiere recuperación manual.`,
      );
      return;
    }
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
    illegalContent: normalizeIllegalContent(
      parsed.illegalContent,
      base.illegalContent,
    ),
    antiSpam: normalizeAntiSpam(parsed.antiSpam, base.antiSpam),
    inactivity: normalizeInactivity(parsed.inactivity, base.inactivity),
    activityMessages: normalizeActivityMessages(parsed.activityMessages),
    automaticMessage: normalizeAutomaticMessage(parsed.automaticMessage),
    newUsers: {
      enabled:
        isRecord(parsed.newUsers) && parsed.newUsers.enabled === true,
    },
    verifiedTitles: Array.isArray(parsed.verifiedTitles)
      ? parsed.verifiedTitles.filter((title): title is string => typeof title === "string")
      : base.verifiedTitles,
    autoDetectVerifiedTitles:
      typeof parsed.autoDetectVerifiedTitles === "boolean"
        ? parsed.autoDetectVerifiedTitles
        : base.autoDetectVerifiedTitles,
    autoRemoveVerifiedWhenTitleRemoved:
      typeof parsed.autoRemoveVerifiedWhenTitleRemoved === "boolean"
        ? parsed.autoRemoveVerifiedWhenTitleRemoved
        : base.autoRemoveVerifiedWhenTitleRemoved,
    verifiedTagSyncEnabled:
      typeof parsed.verifiedTagSyncEnabled === "boolean"
        ? parsed.verifiedTagSyncEnabled
        : base.verifiedTagSyncEnabled,
    verifiedMemberTags: Array.isArray(parsed.verifiedMemberTags)
      ? parsed.verifiedMemberTags.filter((tag): tag is string => typeof tag === "string")
      : base.verifiedMemberTags,
  };
}

function normalizeActivityMessages(value: unknown): ActivityMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ActivityMessage => {
    if (!isRecord(item)) return false;
    return Number.isSafeInteger(item.messageId) &&
      Number.isSafeInteger(item.groupId) &&
      Number.isSafeInteger(item.userId) &&
      typeof item.timestamp === "number" &&
      Number.isFinite(item.timestamp) &&
      (item.firstName === undefined || typeof item.firstName === "string") &&
      (item.lastName === undefined || typeof item.lastName === "string") &&
      (item.name === undefined || typeof item.name === "string") &&
      (item.username === undefined || typeof item.username === "string");
  }).slice(-MAX_ACTIVITY_MESSAGES);
}

function normalizeAutomaticMessage(value: unknown): AutomaticMessageConfig | undefined {
  if (!isRecord(value) || typeof value.message !== "string") return undefined;
  return {
    enabled: value.enabled === true,
    message: value.message,
    ...(typeof value.intervalMinutes === "number" &&
      Number.isFinite(value.intervalMinutes) && value.intervalMinutes > 0
      ? { intervalMinutes: value.intervalMinutes }
      : {}),
    ...(typeof value.nextRunAt === "string" ? { nextRunAt: value.nextRunAt } : {}),
    ...(typeof value.lastSentAt === "string" ? { lastSentAt: value.lastSentAt } : {}),
    ...(typeof value.lastMessageId === "number" &&
      Number.isSafeInteger(value.lastMessageId)
      ? { lastMessageId: value.lastMessageId }
      : {}),
  };
}

function normalizeInactivity(
  raw: unknown,
  fallback: GroupData["inactivity"],
): GroupData["inactivity"] {
  if (!isRecord(raw)) return fallback;
  const days =
    typeof raw.inactivityDays === "number" &&
    Number.isFinite(raw.inactivityDays) &&
    raw.inactivityDays > 0
      ? Math.floor(raw.inactivityDays)
      : fallback.inactivityDays;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
    inactivityDays: days,
    customDays:
      typeof raw.customDays === "number" && raw.customDays > 0
        ? Math.floor(raw.customDays)
        : undefined,
  };
}

function normalizeAntiSpam(
  raw: unknown,
  fallback: GroupData["antiSpam"],
): GroupData["antiSpam"] {
  if (!isRecord(raw)) {
    return fallback;
  }
  const positive = (value: unknown, defaultValue: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : defaultValue;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
    maxMentionsPerMessage: positive(raw.maxMentionsPerMessage, fallback.maxMentionsPerMessage),
    blockLinks: typeof raw.blockLinks === "boolean" ? raw.blockLinks : fallback.blockLinks,
    detectRepeatedMessages:
      typeof raw.detectRepeatedMessages === "boolean"
        ? raw.detectRepeatedMessages
        : fallback.detectRepeatedMessages,
    detectAutomatedBehavior:
      typeof raw.detectAutomatedBehavior === "boolean"
        ? raw.detectAutomatedBehavior
        : fallback.detectAutomatedBehavior,
    infractions: isRecord(raw.infractions)
      ? (raw.infractions as Record<string, number>)
      : {},
  };
}

function normalizeIllegalContent(
  raw: unknown,
  fallback: IllegalContentConfig,
): IllegalContentConfig {
  if (!isRecord(raw)) {
    return fallback;
  }
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
    customTerms: Array.isArray(raw.customTerms)
      ? raw.customTerms.filter((item): item is string => typeof item === "string")
      : fallback.customTerms,
    suspiciousDeletes:
      typeof raw.suspiciousDeletes === "boolean"
        ? raw.suspiciousDeletes
        : fallback.suspiciousDeletes,
    highConfidenceBan:
      typeof raw.highConfidenceBan === "boolean"
        ? raw.highConfidenceBan
        : fallback.highConfidenceBan,
    highConfidenceDelete:
      typeof raw.highConfidenceDelete === "boolean"
        ? raw.highConfidenceDelete
        : fallback.highConfidenceDelete,
    events:
      typeof raw.events === "number" && raw.events >= 0
        ? raw.events
        : fallback.events,
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
  const statistics = isRecord(raw.statistics) ? raw.statistics : {};
  const statistic = (key: keyof typeof DEFAULT_PROMOTION_STATISTICS): number =>
    typeof statistics[key] === "number" &&
    Number.isFinite(statistics[key]) &&
    statistics[key] >= 0
      ? statistics[key]
      : DEFAULT_PROMOTION_STATISTICS[key];
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
    statistics: {
      analyzed: statistic("analyzed"),
      buying: statistic("buying"),
      selling: statistic("selling"),
      neutral: statistic("neutral"),
      ambiguous: statistic("ambiguous"),
      blocked: statistic("blocked"),
      allowedVerified: statistic("allowedVerified"),
    },
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