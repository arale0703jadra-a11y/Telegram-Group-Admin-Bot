import type { Context, SessionFlavor } from "grammy";

/**
 * Datos de configuración independientes por grupo.
 * La sesión se guarda usando el ID del chat como clave, de modo que
 * cada grupo mantiene su propia configuración.
 */
export interface GroupConfig {
  activo: boolean;
  reglas: string;
  palabrasProhibidas: string[];
  antiSpam: boolean;
  registrosActividad: boolean;
  idioma: string;
}

/**
 * Acción en espera de que el administrador indique un usuario objetivo.
 * El bot pide el @usuario o ID y lo resuelve con el siguiente mensaje.
 */
export type PickAction = "search" | "warn" | "mute" | "unmute" | "ban";

export type PendingAction =
  | { kind: "search"; groupId: number; messageId?: number }
  | { kind: "pick"; action: PickAction; groupId: number; messageId?: number }
  | { kind: "muteMinutes"; userId: number; groupId: number; messageId?: number }
  | {
      kind: "muteReason";
      userId: number;
      groupId: number;
      minutes: number;
      messageId?: number;
    }
  | { kind: "warnReason"; userId: number; groupId: number; messageId?: number }
  | { kind: "banReason"; userId: number; groupId: number; messageId?: number }
  | { kind: "unbanId"; groupId: number; messageId?: number };

/**
 * Estado del panel de administración en el chat privado.
 * Se guarda por usuario (clave = from.id), de modo que cada
 * administrador gestiona de forma independiente qué grupo administra.
 */
export interface UserPanelState {
  selectedGroupId?: number;
  selectedGroupTitle?: string;
  pendingAction?: PendingAction;
}

/**
 * Datos de sesión múltiple:
 * - `group`: configuración por grupo (key = chat.id).
 * - `user`: estado del panel privado por usuario (key = from.id).
 */
export interface SessionData {
  group: GroupConfig;
  user: UserPanelState;
}

/**
 * Contexto ampliado del bot con el soporte de sesión múltiple.
 */
export type MyContext = Context & SessionFlavor<SessionData>;