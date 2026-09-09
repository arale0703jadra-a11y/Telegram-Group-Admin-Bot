import type { Context } from "grammy";
import type { ChatMember } from "@grammyjs/types";
import type { MyContext } from "../types.js";

/**
 * Tipos de estado de miembro de Telegram que se consideran administradores.
 */
const ADMIN_STATUSES = new Set(["creator", "administrator"]);

export interface AdminCheckResult {
  isAdmin: boolean;
  status?: ChatMember["status"];
  error?: string;
}

/**
 * Indica si el chat actual es un grupo o supergrupo.
 */
export function isGroupChat(ctx: Context): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

/**
 * Comprueba si `ctx.from` es administrador o creador del grupo indicado.
 *
 * IMPORTANTE: se usa en el panel privado, donde el chat actual NO es el
 * grupo. La autorización se valida SIEMPRE con el chat_id específico.
 */
export async function isUserAdminOf(
  ctx: MyContext,
  chatId: number,
  userId = ctx.from?.id,
): Promise<boolean> {
  return (await checkUserAdminOf(ctx, chatId, userId)).isAdmin;
}

/**
 * Comprueba la autorización contra Telegram y conserva la causa del rechazo
 * para diagnóstico sin usar ningún registro local como autoridad.
 */
export async function checkUserAdminOf(
  ctx: MyContext,
  chatId: number,
  userId?: number,
): Promise<AdminCheckResult> {
  if (
    typeof chatId !== "number" ||
    !Number.isInteger(chatId) ||
    typeof userId !== "number" ||
    !Number.isInteger(userId)
  ) {
    console.warn(
      `[AUTH] userId=${userId ?? "unknown"} groupId=${chatId} ` +
        "telegramStatus=invalid access=error",
    );
    return { isAdmin: false, error: "invalid-identifiers" };
  }
  try {
    const member = await ctx.api.getChatMember(chatId, userId);
    const isAdmin = ADMIN_STATUSES.has(member.status);
    console.log(
      `[AUTH] userId=${userId} groupId=${chatId} ` +
        `telegramStatus=${member.status} access=${isAdmin ? "granted" : "denied"}`,
    );
    return { isAdmin, status: member.status };
  } catch (error) {
    const description =
      error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 160) : "unknown";
    console.error(
      `[AUTH] userId=${userId} groupId=${chatId} ` +
        `telegramError=${description} access=error`,
    );
    return { isAdmin: false, error: description };
  }
}

/**
 * Comprueba si el usuario que envió el mensaje es administrador o
 * creador del chat actual. Válido para comandos ejecutados en el grupo.
 */
export async function isUserAdmin(ctx: MyContext): Promise<boolean> {
  if (!isGroupChat(ctx) || !ctx.chat || !ctx.from) {
    return false;
  }
  return isUserAdminOf(ctx, ctx.chat.id, ctx.from.id);
}