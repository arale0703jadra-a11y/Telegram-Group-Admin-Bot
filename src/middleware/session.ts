import { session, type MiddlewareFn } from "grammy";
import type { GroupConfig, MyContext, SessionData, UserPanelState } from "../types.js";
import {
  SupabaseUserSessionStorage,
  UserSessionPersistenceError,
} from "../services/user-session-storage.js";
import { SessionPersistenceAlerts } from "../services/session-persistence-alerts.js";

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

let sessionAlerts = new SessionPersistenceAlerts();

/** Solo para pruebas: restablece el estado de agrupación de alertas. */
export function resetSessionPersistenceAlerts(): void {
  sessionAlerts = new SessionPersistenceAlerts();
}

const PERSISTENCE_WARNING =
  "⚠️ No se pudo guardar o recuperar tu sesión de ZEUS en Supabase. " +
  "La operación no se considera persistida; inténtalo de nuevo más tarde.";

const PERSISTENCE_RECOVERY =
  "✅ La persistencia de tu sesión de ZEUS se ha restaurado: " +
  "tus cambios se vuelven a guardar correctamente.";

/** Envío de avisos best-effort: un fallo al notificar no rompe el update. */
async function notifyUser(ctx: MyContext, text: string): Promise<void> {
  if (ctx.chat?.type === "private") {
    try {
      await ctx.reply(text);
    } catch (notificationError) {
      console.error(
        `[USER SESSION] No se pudo notificar el error (${notificationError instanceof Error ? notificationError.name : "unknown"}).`,
      );
    }
  } else if (ctx.from) {
    try {
      await ctx.api.sendMessage(ctx.from.id, text);
    } catch (notificationError) {
      console.warn(
        `[USER SESSION] No se pudo notificar en privado (${notificationError instanceof Error ? notificationError.name : "unknown"}).`,
      );
    }
  }
}

/**
 * Serializa las actualizaciones del mismo usuario dentro del proceso para
 * evitar carreras lectura/escritura (conflictos de versión) cuando llegan
 * dos updates del mismo usuario a la vez.
 */
const userUpdateQueues = new Map<string, Promise<unknown>>();

function enqueueUserUpdate<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = userUpdateQueues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  userUpdateQueues.set(key, tail);
  void tail.then(() => {
    if (userUpdateQueues.get(key) === tail) userUpdateQueues.delete(key);
  });
  return run;
}

/** Diagnóstico: número de actualizaciones aún en cola por usuario. */
export function pendingSessionUpdates(): number {
  return userUpdateQueues.size;
}

async function runSessionOperation(
  ctx: MyContext,
  next: () => Promise<void>,
): Promise<void> {
  try {
    await grammYSessionMiddleware(ctx, next);
  } catch (error) {
    if (!(error instanceof UserSessionPersistenceError)) throw error;
    const decision = sessionAlerts.recordFailure({
      operation: error.operation,
      reason: error.reason,
      databaseCode: error.databaseCode,
    });
    // Registro técnico SIEMPRE completo, se avise o no al usuario.
    console.error(
      `[USER SESSION] ${error.operation} failed reason=${error.reason}` +
        `${error.databaseCode ? ` code=${error.databaseCode}` : ""} ` +
        `occurrence=${decision.occurrence} notice=${decision.notice}.`,
    );
    if (decision.notify) await notifyUser(ctx, PERSISTENCE_WARNING);
    throw error;
  }
  if (sessionAlerts.recordSuccess()) {
    console.info(
      "[USER SESSION] Persistencia restaurada tras incidente; " +
        "aviso de recuperación enviado.",
    );
    await notifyUser(ctx, PERSISTENCE_RECOVERY);
  }
}

export const sessionMiddleware: MiddlewareFn<MyContext> = async (ctx, next) => {
  const queueKey = ctx.from ? `user:${ctx.from.id}` : undefined;
  if (!queueKey) return runSessionOperation(ctx, next);
  return enqueueUserUpdate(queueKey, () => runSessionOperation(ctx, next));
};