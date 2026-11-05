import { session, type MiddlewareFn } from "grammy";
import type { GroupConfig, MyContext, SessionData, UserPanelState } from "../types.js";
import {
  SupabaseUserSessionStorage,
  UserSessionPersistenceError,
} from "../services/user-session-storage.js";

/**
 * Configuración por defecto de cada grupo.
 * Cada grupo arranca con estos valores y puede personalizarlos
 * de forma totalmente independiente (soporte multi-grupo).
 */
function initialGroupConfig(): GroupConfig {
  return {
    activo: true,
    reglas: "",
    palabrasProhibidas: [],
    antiSpam: false,
    registrosActividad: false,
    idioma: "es",
  };
}

/**
 * Estado inicial del panel privado por usuario.
 */
function initialUserPanelState(): UserPanelState {
  return {
    selectedGroupId: undefined,
    selectedGroupTitle: undefined,
    persistenceVersion: 0,
  };
}

const userSessionStorage = new SupabaseUserSessionStorage();

/**
 * Middleware de sesión múltiple:
 * - `group`: key = chat.id (configuración independiente por grupo).
 * - `user`: key = from.id, persistida en Supabase.
 */
const grammYSessionMiddleware = session<SessionData, MyContext>({
  type: "multi",
  group: {
    initial: initialGroupConfig,
    getSessionKey: (ctx) => ctx.chat?.id.toString(),
  },
  user: {
    initial: initialUserPanelState,
    getSessionKey: (ctx) => ctx.from ? `user:${ctx.from.id}` : undefined,
    storage: userSessionStorage,
  },
});

export const sessionMiddleware: MiddlewareFn<MyContext> = async (ctx, next) => {
  try {
    await grammYSessionMiddleware(ctx, next);
  } catch (error) {
    if (!(error instanceof UserSessionPersistenceError)) throw error;
    console.error(
      `[USER SESSION] ${error.operation} failed reason=${error.reason}` +
        `${error.databaseCode ? ` code=${error.databaseCode}` : ""}.`,
    );
    const warning =
      "⚠️ No se pudo guardar o recuperar tu sesión de ZEUS en Supabase. " +
      "La operación no se considera persistida; inténtalo de nuevo más tarde.";
    if (ctx.chat?.type === "private") {
      try {
        await ctx.reply(warning);
      } catch (notificationError) {
        console.error(
          `[USER SESSION] No se pudo notificar el error (${notificationError instanceof Error ? notificationError.name : "unknown"}).`,
        );
      }
    } else if (ctx.from) {
      try {
        await ctx.api.sendMessage(ctx.from.id, warning);
      } catch (notificationError) {
        console.warn(
          `[USER SESSION] No se pudo notificar en privado (${notificationError instanceof Error ? notificationError.name : "unknown"}).`,
        );
      }
    }
    throw error;
  }
};