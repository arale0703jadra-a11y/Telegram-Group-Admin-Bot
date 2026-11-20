import type { ChatMember, User } from "@grammyjs/types";
import { Composer } from "grammy";
import {
  allowedServiceBotIds,
  isConfiguredAdminId,
  pendingServiceBotLabels,
} from "../config.js";
import { getBotRights, getMemberSafely } from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { invalidateSecurityCaches } from "../utils/member-cache.js";
import {
  CooldownTracker,
  callWithRetryAfter,
  runChatActionExclusive,
} from "../utils/safety.js";
import { isGroupChat } from "../utils/permissions.js";
import type { MyContext } from "../types.js";

/**
 * Clasifica a quien añadió un bot. Se conserva SOLO como contexto de
 * auditoría: en esta fase la expulsión no depende de quién lo añadió, sino de
 * si el bot figura en la lista blanca de bots de servicio.
 */
export function isAuthorizedBotAdder(
  adderId: number,
  member: ChatMember | undefined,
): boolean {
  return (
    member !== undefined &&
    (isConfiguredAdminId(adderId) ||
      member.status === "creator" ||
      member.status === "administrator")
  );
}

/**
 * Configuración efectiva del guard para un contexto concreto.
 * Con `pendingServiceBots` no vacío la expulsión queda desactivada: mientras
 * falte el ID numérico de un bot de servicio declarado no se puede garantizar
 * que el bot que entra no sea ese, y no se arriesga una expulsión accidental.
 */
export interface BotGuardConfig {
  /** ID numérico de ZEUS: siempre protegido contra su propia expulsión. */
  zeusBotId: number;
  /** IDs numéricos de bots de servicio autorizados. */
  allowedBotIds: readonly number[];
  /** Bots de servicio declarados cuyo ID numérico sigue pendiente. */
  pendingServiceBots: readonly string[];
}

export type BotAdmissionDecision =
  | "protected_self"
  | "protected_allowlist"
  | "blocked_pending_configuration"
  | "expel";

export function resolveBotGuardConfig(ctx: MyContext): BotGuardConfig {
  return {
    zeusBotId: ctx.me.id,
    allowedBotIds: allowedServiceBotIds(),
    pendingServiceBots: pendingServiceBotLabels(),
  };
}

/**
 * Decide qué hacer con un bot que acaba de entrar. Nunca consulta quién lo
 * añadió: la única excepción son los IDs numéricos de la lista blanca.
 */
export function evaluateBotAdmission(
  botId: number,
  config: BotGuardConfig,
): BotAdmissionDecision {
  if (botId === config.zeusBotId) return "protected_self";
  if (config.allowedBotIds.includes(botId)) return "protected_allowlist";
  if (config.pendingServiceBots.length > 0) {
    return "blocked_pending_configuration";
  }
  return "expel";
}

/**
 * Contexto de auditoría sobre quién añadió el bot. Best-effort y solo
 * informativo: nunca otorga una excepción de expulsión.
 */
async function resolveAdderContext(
  ctx: MyContext,
  chatId: number,
): Promise<string> {
  const adderId = ctx.from?.id;
  if (typeof adderId !== "number") return "quienLoAñadió=desconocido";
  if (ctx.from?.is_bot) return `quienLoAñadió=otro-bot(userId=${adderId})`;
  const adder = await getMemberSafely(ctx, chatId, adderId);
  if (!adder) return `quienLoAñadió=no-verificable(userId=${adderId})`;
  const kind = isAuthorizedBotAdder(adderId, adder)
    ? "administrador"
    : "miembro";
  return `quienLoAñadió=${kind}(userId=${adderId})`;
}

function classifyError(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "error_code" in error &&
    typeof error.error_code === "number"
    ? `telegram_${error.error_code}`
    : error instanceof Error
      ? error.name
      : "unknown";
}

const botBanCooldown = new CooldownTracker();
const suppressedEventLogger = new CooldownTracker();

/** Ventana en la que un evento repetido del mismo bot no repite la sanción. */
export const BOT_BAN_COOLDOWN_MS = 10 * 60 * 1000;

/** Ventana mínima entre avisos de supresión por cooldown del mismo bot. */
export const SUPPRESSED_EVENT_LOG_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Evalúa un bot incorporado al grupo y, si procede, lo expulsa.
 * `config` es inyectable para las pruebas; en producción se resuelve de
 * `config.ts` (lista blanca por ID numérico) y de `ctx.me.id`.
 */
export async function handleIncomingBot(
  ctx: MyContext,
  bot: User,
  config: BotGuardConfig = resolveBotGuardConfig(ctx),
): Promise<void> {
  if (!isGroupChat(ctx) || !ctx.chat || !ctx.message) {
    return;
  }

  const chatId = ctx.chat.id;
  const targetName = bot.username ?? bot.first_name;
  const decision = evaluateBotAdmission(bot.id, config);

  if (decision === "protected_self") {
    await logEvent(ctx, chatId, "BAN", {
      targetId: bot.id,
      targetName,
      result: "ok",
      detail: "BOT_ADDITION: entrada del propio ZEUS; nunca se expulsa a sí mismo.",
    });
    return;
  }

  if (decision === "protected_allowlist") {
    await logEvent(ctx, chatId, "BAN", {
      targetId: bot.id,
      targetName,
      result: "ok",
      detail: "BOT_ADDITION: bot de servicio autorizado; entrada permitida.",
    });
    return;
  }

  if (decision === "blocked_pending_configuration") {
    await logEvent(ctx, chatId, "BAN", {
      targetId: bot.id,
      targetName,
      result: "rejected",
      detail:
        "BOT_ADDITION: expulsión no activada; ID numérico pendiente de " +
        `${config.pendingServiceBots.join(", ")}.`,
    });
    return;
  }

  const adderContext = await resolveAdderContext(ctx, chatId);

  const rights = await getBotRights(ctx, chatId);
  if (!rights.canRestrict) {
    await logEvent(ctx, chatId, "BAN", {
      targetId: bot.id,
      targetName,
      result: "error",
      detail: "BOT_ADDITION: el bot no tiene permisos para expulsar miembros.",
    });
    return;
  }

  // Sin sanciones duplicadas si Telegram reenvía el mismo evento.
  if (
    !botBanCooldown.shouldApply(
      `${chatId}:${bot.id}`,
      Date.now(),
      BOT_BAN_COOLDOWN_MS,
    )
  ) {
    // Fase 1.2 C: la supresión queda registrada (sin repetir la expulsión) y
    // el aviso se limita por ventana para no inundar el registro ante ráfagas
    // de eventos repetidos. El cooldown de expulsión no se altera.
    if (
      suppressedEventLogger.shouldApply(
        `${chatId}:${bot.id}`,
        Date.now(),
        SUPPRESSED_EVENT_LOG_THROTTLE_MS,
      )
    ) {
      await logEvent(ctx, chatId, "BAN", {
        targetId: bot.id,
        targetName,
        result: "rejected",
        detail:
          `BOT_ADDITION: evento repetido suprimido por cooldown ` +
          `(${adderContext}); no se repite la expulsión.`,
      });
    }
    return;
  }

  try {
    await runChatActionExclusive(chatId, () =>
      callWithRetryAfter(() => ctx.api.banChatMember(chatId, bot.id)),
    );
    invalidateSecurityCaches(chatId, bot.id);
    await logEvent(ctx, chatId, "BAN", {
      targetId: bot.id,
      targetName,
      result: "ok",
      detail: `BOT_ADDITION: bot no autorizado (${adderContext}); expulsión permanente.`,
    });
  } catch (error) {
    const errorCode = classifyError(error);
    console.error(
      `[BOT ADDITION GUARD] No se pudo expulsar al bot (chatId=${chatId}, botId=${bot.id}, error=${errorCode}).`,
    );
    await logEvent(ctx, chatId, "BAN", {
      targetId: bot.id,
      targetName,
      result: "error",
      detail: `BOT_ADDITION: Telegram rechazó la expulsión (${errorCode}).`,
    });
  }
}

export const botAdditionGuard = new Composer<MyContext>();

botAdditionGuard.on("message:new_chat_members", async (ctx, next) => {
  if (!isGroupChat(ctx) || !ctx.message) {
    await next();
    return;
  }

  for (const member of ctx.message.new_chat_members ?? []) {
    if (member.is_bot) {
      await handleIncomingBot(ctx, member);
    }
  }
  await next();
});
