import { session } from "grammy";
import type { GroupConfig, MyContext, SessionData, UserPanelState } from "../types.js";

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
  };
}

/**
 * Middleware de sesión múltiple:
 * - `group`: key = chat.id (configuración independiente por grupo).
 * - `user`: key = from.id (grupo que el administrador está gestionando).
 */
export const sessionMiddleware = session<SessionData, MyContext>({
  type: "multi",
  group: {
    initial: initialGroupConfig,
    getSessionKey: (ctx) => ctx.chat?.id.toString(),
  },
  user: {
    initial: initialUserPanelState,
    getSessionKey: (ctx) => ctx.from?.id.toString(),
  },
});