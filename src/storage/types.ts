import type { ChatPermissions } from "@grammyjs/types";

export const MAX_ACTIVITY_MESSAGES = 10_000;

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
  | "ANTIRAID"
  | "INACTIVITY_SCAN"
  | "INACTIVITY_REMOVE"
  | "INACTIVITY_REMOVE_ERROR"
  | "ADMIN_GUARDIAN";

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
  result: "ok" | "queued" | "error";
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
  messageCount?: number;
  status?: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked" | "unknown";
  zeusRole?: "owner" | "administrator" | "verified" | "user";
  verified?: boolean;
}

export interface ActivityMessage {
  messageId: number;
  groupId: number;
  userId: number;
  firstName?: string;
  lastName?: string;
  name?: string;
  username?: string;
  timestamp: number;
}

export interface AutomaticMessageConfig {
  enabled: boolean;
  message: string;
  intervalMinutes?: number;
  nextRunAt?: string;
  lastSentAt?: string;
  lastMessageId?: number;
}

export interface NewUsersConfig {
  enabled: boolean;
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

export interface PromotionStatistics {
  analyzed: number;
  buying: number;
  selling: number;
  neutral: number;
  ambiguous: number;
  blocked: number;
  allowedVerified: number;
}

export interface PromotionConfig {
  enabled: boolean;
  dictionary: string[];
  verificationContacts: string[];
  verifiedUsers: Record<string, boolean>;
  recurrenceMuteMinutes: number[];
  messages: PromotionMessages;
  infractions: Record<string, number>;
  statistics: PromotionStatistics;
}

export type IllegalConfidence = "weak" | "suspicious" | "high";

/**
 * Acción automática ante una detección AMBIGUA (confianza "suspicious").
 * Por defecto "review": no se sanciona automáticamente y se avisa a un
 * administrador para que decida.
 */
export type IllegalAmbiguousAction = "review" | "delete" | "none";

export interface IllegalContentConfig {
  enabled: boolean;
  customTerms: string[];
  suspiciousDeletes: boolean;
  highConfidenceBan: boolean;
  highConfidenceDelete: boolean;
  events: number;
  /** Qué hacer con las detecciones ambiguas (confianza "suspicious"). */
  ambiguousAction: IllegalAmbiguousAction;
  /** Avisar a los administradores cuando hace falta revisión humana. */
  notifyAdminsOnAmbiguous: boolean;
  /** Contador de detecciones ambiguas encoladas para revisión. */
  reviewEvents: number;
}

export interface AntiSpamConfig {
  enabled: boolean;
  maxMentionsPerMessage: number;
  blockLinks: boolean;
  /** Restringe también invitaciones de un clic (t.me/+ y joinchat). */
  blockInvites: boolean;
  detectRepeatedMessages: boolean;
  detectAutomatedBehavior: boolean;
  /** Límite de frecuencia: mensajes máximos por usuario en la ventana. */
  rateLimitEnabled: boolean;
  maxMessagesPerWindow: number;
  windowSeconds: number;
  infractions: Record<string, number>;
}

/**
 * Detección de oleadas de entradas (raids) y actividad coordinada.
 * La API de Bots de Telegram NO expone la fecha de creación de una cuenta,
 * por lo que la "novedad" se mide por el tiempo transcurrido desde que el
 * usuario entró al grupo (observable vía `new_chat_members` o el primer
 * mensaje visto), nunca por la antigüedad de la cuenta.
 */
export interface AntiRaidConfig {
  enabled: boolean;
  /** Ventana (s) en la que se cuentan entradas para detectar una oleada. */
  joinWindowSeconds: number;
  /** Entradas mínimas en la ventana para considerar oleada. */
  joinThreshold: number;
  /** Ventana (s) para detectar mensajes coordinados idénticos. */
  coordinatedWindowSeconds: number;
  /** Usuarios distintos que deben enviar texto idéntico para coordinación. */
  coordinatedThreshold: number;
  /** Minutos durante los que se aplica restricción a cuentas recién llegadas. */
  newAccountRestrictionMinutes: number;
  /** Activar automáticamente el modo de emergencia al detectar oleada. */
  emergencyOnRaid: boolean;
  /** Duración (min) del modo de emergencia automático. */
  emergencyMinutes: number;
}

/** Modo de emergencia: límites temporales más estrictos para no exentos. */
export interface EmergencyConfig {
  active: boolean;
  reason?: string;
  /** Epoch ms en que se activó. */
  activatedAt?: number;
  /** Epoch ms en que expira (y se desactiva solo). */
  expiresAt?: number;
  /** IDs con restricción temporal aplicada por el modo de emergencia. */
  restrictedUsers?: Record<string, number>;
}

export interface InactivityConfig {
  enabled: boolean;
  inactivityDays: number;
  customDays?: number;
}

export interface CleanupConfig {
  autoDeleteServiceMessages: boolean;
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
  antiRaid: AntiRaidConfig;
  emergency: EmergencyConfig;
  /** IDs (como texto) exentos de sanciones automáticas por spam/raid. */
  trustedUsers: Record<string, true>;
  inactivity: InactivityConfig;
  cleanup: CleanupConfig;
  activityMessages: ActivityMessage[];
  automaticMessage?: AutomaticMessageConfig;
  newUsers: NewUsersConfig;
  verifiedTitles: string[];
  autoDetectVerifiedTitles: boolean;
  autoRemoveVerifiedWhenTitleRemoved: boolean;
  verifiedTagSyncEnabled: boolean;
  verifiedMemberTags: string[];
}