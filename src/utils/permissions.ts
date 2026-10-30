import type { Context } from "grammy";
import type { ChatMember } from "@grammyjs/types";
import type { MyContext } from "../types.js";
import { getCachedChatMember } from "./member-cache.js";

/**
 * Tipos de estado de miembro de Telegram que se consideran administradores.
 */
function isAdminStatus(status: string): boolean {
  return status === "creator" || status === "administrator";
}

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
      JSON.stringify({
        event: "group_admin_check_failed",
        reason: "invalid_identifiers",
      }),
    );
    return { isAdmin: false, error: "invalid-identifiers" };
  }
  try {
    // Caché corta (10 s) + cooldown ante 429: la autorización se deniega ante
    // cualquier fallo (nunca se concede permiso por defecto).
    const member = await getCachedChatMember(ctx.api, chatId, userId);
    if (!member) {
      console.error(
        JSON.stringify({
          event: "group_admin_check_failed",
          reason: "member_lookup_unavailable",
        }),
      );
      return { isAdmin: false, error: "member-lookup-unavailable" };
    }
    const status = String(member.status).trim().toLowerCase();
    const isAdmin = isAdminStatus(status);
    console.info(
      JSON.stringify({
        event: "group_admin_check",
        result: isAdmin ? "granted" : "denied",
        status,
      }),
    );
    return { isAdmin, status: member.status };
  } catch {
    // Defensa en profundidad: getCachedChatMember no lanza, pero si algo
    // inesperado falla, se deniega sin volcar contenido del error.
    console.error(
      JSON.stringify({
        event: "group_admin_check_failed",
        reason: "unexpected_error",
      }),
    );
    return { isAdmin: false, error: "unexpected-error" };
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