import { session } from "grammy";
import type { GroupConfig, MyContext, SessionData, UserPanelState } from "../types.js";

export const PENDING_ACTION_TIMEOUT_MS = 10 * 60 * 1000;

function normalizePendingState(state: UserPanelState): void {
  if (!state.pendingAction) {
    state.pendingSince = undefined;
    return;
  }
  if (
    state.pendingSince &&
    Date.now() - state.pendingSince > PENDING_ACTION_TIMEOUT_MS
  ) {
    state.pendingAction = undefined;
    state.pendingSince = undefined;
    return;
  }
  if (!state.pendingSince) {
    state.pendingSince = Date.now();
  }
}

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
const sessionStore = session<SessionData, MyContext>({
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

export const sessionMiddleware = async (
  ctx: MyContext,
  next: () => Promise<void>,
): Promise<void> => {
  await sessionStore(ctx, async () => {
    normalizePendingState(ctx.session.user);
    await next();
    normalizePendingState(ctx.session.user);
  });
};