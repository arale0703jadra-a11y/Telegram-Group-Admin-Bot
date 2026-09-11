import type { ChatPermissions } from "@grammyjs/types";

/**
 * Tipos del almacenamiento persistente.
 *
 * La capa de almacenamiento guarda los datos de moderación de forma
 * INDEPENDIENTE por grupo (chat_id). El almacén activo es FileStore
 * (archivos JSON en `data/storage/<chatId>.json`), por lo que las
 * advertencias, silencios y eventos sobreviven a los reinicios del bot.
 */

export type ModerationType =
  | "WARN"
  | "UNWARN"
  | "MUTE"
  | "UNMUTE"
  | "BAN"
  | "UNBAN"
  | "DELETE"
  | "CLEAN"
  | "ILLEGAL"
  | "ANTISPAM"
  | "INACTIVITY_SCAN"
  | "INACTIVITY_REMOVE"
  | "INACTIVITY_REMOVE_ERROR";

/**
 * Registro de una acción de moderación realizada por un administrador.
 */
export interface ModerationEvent {
  id: string;
  chatId: number;
  type: ModerationType;
  adminId: number;
  adminName: string;
  targetId?: number;
  targetName?: string;
  date: string;
  result: "ok" | "error";
  detail?: string;
}

/**
 * Usuario indexado por el bot a partir de los mensajes que envía.
 * Permite buscar por @username sin depender solo del ID numérico y
 * conocer la última actividad observada (nunca una "última conexión"
 * que Telegram no expone).
 */
export interface IndexedUser {
  id: number;
  groupId?: number;
  firstName?: string;
  lastName?: string;
  name?: string;
  username?: string;
  firstSeen?: number;
  displayName?: string;
  /** Última vez (epoch segundos) que el bot vio un mensaje del usuario. */
  lastSeen?: number;
  joinedAt?: number;
  lastActivityType?: "message" | "join" | "other";
}

/**
 * Una advertencia concreta: quién, cuándo y (opcionalmente) por qué.
 */
export interface WarningEntry {
  id: string;
  userId: number;
  adminId: number;
  adminName: string;
  date: string;
  reason?: string;
}

/**
 * Estado de un silencio activo o aplicado.
 */
export interface MuteRecord {
  /** Epoch segundos en que termina el silencio. */
  until: number;
  adminId?: number;
  adminName?: string;
  reason?: string;
  /** Fecha (ISO) en que se aplicó el silencio. */
  at?: string;
  /** Permisos previos conocidos para restaurarlos al quitar el silencio. */
  previousPermissions?: ChatPermissions;
}

/**
 * Usuario baneado recuerdado por el bot, con la traza de quién lo hizo.
 */
export interface BanRecord extends IndexedUser {
  at?: string;
  adminId?: number;
  adminName?: string;
  reason?: string;
}

/**
 * Acción automática al superar el límite de advertencias.
 * Por ahora solo se prepara la arquitectura; la configuración
 * llegará en una fase posterior.
 */
export type WarnAction = "none" | "mute" | "ban";

/**
 * Configuración de la bienvenida del grupo.
 * Por ahora se usa el texto predeterminado; desde la sección
 * "👋 Bienvenida" se podrá editar en una fase posterior.
 */
export interface WelcomeConfig {
  enabled: boolean;
  message: string;
}

export interface PromotionMessages {
  promotionWarning: string;
  promotionRemoved: string;
  promotionMuted: string;
  linkWarning: string;
  verificationRequired: string;
}

export interface PromotionConfig {
  enabled: boolean;
  dictionary: string[];
  verificationContacts: string[];
  verifiedUsers: Record<string, boolean>;
  recurrenceMuteMinutes: number[];
  messages: PromotionMessages;
  infractions: Record<string, number>;
}

export type IllegalConfidence = "weak" | "suspicious" | "high";

export interface IllegalContentConfig {
  enabled: boolean;
  customTerms: string[];
  suspiciousDeletes: boolean;
  highConfidenceBan: boolean;
  highConfidenceDelete: boolean;
  events: number;
}

export interface AntiSpamConfig {
  enabled: boolean;
  maxMentionsPerMessage: number;
  blockLinks: boolean;
  detectRepeatedMessages: boolean;
  detectAutomatedBehavior: boolean;
  infractions: Record<string, number>;
}

export interface InactivityConfig {
  enabled: boolean;
  inactivityDays: number;
  customDays?: number;
}

/**
 * Datos persistidos de moderación de un grupo (key = chat_id).
 */
export interface GroupData {
  warnings: Record<string, WarningEntry[]>;
  warnLimit: number;
  warnAction: WarnAction;
  mutedUsers: Record<string, MuteRecord>;
  bannedUsers: Record<string, BanRecord>;
  recentMessages: number[];
  indexedUsers: Record<string, IndexedUser>;
  events: ModerationEvent[];
  welcome: WelcomeConfig;
  promotion: PromotionConfig;
  illegalContent: IllegalContentConfig;
  antiSpam: AntiSpamConfig;
  inactivity: InactivityConfig;
}