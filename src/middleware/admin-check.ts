import type { MiddlewareFn, NextFunction } from "grammy";
import { isUserAdmin } from "../utils/permissions.js";
import type { MyContext } from "../types.js";

const NO_PERMISSION_MESSAGE =
  "⛔ Lo siento, no tienes permisos para usar este comando.\n" +
  "Esta acción solo está disponible para administradores del grupo.";

/**
 * Middleware que protege a los comandos de administración.
 *
 * Verifica que quien invoca el comando sea administrador o creador del
 * grupo. Si no lo es, responde con un mensaje de error en español y no
 * continúa con el resto de la cadena.
 */
export function requireAdmin(
  handler: MiddlewareFn<MyContext>,
): MiddlewareFn<MyContext> {
  return async (ctx, next) => {
    if (!(await isUserAdmin(ctx))) {
      await ctx.reply(NO_PERMISSION_MESSAGE);
      return;
    }
    await handler(ctx, next as NextFunction);
  };
}
