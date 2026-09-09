import { Composer } from "grammy";
import { isGroupChat } from "../utils/permissions.js";
import { getGroupData } from "../storage/index.js";
import type { MyContext } from "../types.js";

/**
 * Texto predeterminado de bienvenida. Más adelante se podrá editar
 * desde la sección "👋 Bienvenida" del panel.
 */
export const WELCOME_DEFAULT_TEXT =
  "👋 ¡Bienvenido/a, {nombre}!\n\n" +
  "Nos alegra tenerte por aquí.\n\n" +
  "📜 Antes de participar, revisa las reglas del grupo.\n\n" +
  "💬 Respeta a los demás miembros y mantén el grupo ordenado.";

/**
 * Bienvenida automática de nuevos miembros.
 *
 * SOLO se activa con el evento `message:new_chat_members` (nuevo miembro
 * real). No se dispara por cambios de título, foto, una sola vez por
 * mensaje y nunca para la incorporación del propio bot.
 */
export const welcomeCommand = new Composer<MyContext>();

welcomeCommand.on("message:new_chat_members", async (ctx) => {
  if (!isGroupChat(ctx) || !ctx.message) {
    return;
  }

  // Se saluda solo a personas, no a bots (incluye la del propio bot).
  const people = (ctx.message.new_chat_members ?? []).filter(
    (member) => !member.is_bot,
  );
  if (people.length === 0) {
    return;
  }

  try {
    const data = await getGroupData(ctx.chat.id);
    if (!data.welcome.enabled) {
      return;
    }

    const customText = (data.welcome.message ?? "").trim();
    const template = customText || WELCOME_DEFAULT_TEXT;

    // Saludar a cada nuevo miembro individualmente
    for (const person of people) {
      const name = person.first_name || "usuario";
      const text = template.replace(/{nombre}/gi, name);

      try {
        await ctx.reply(text);
      } catch {
        // Error al enviar a este usuario específico, continuar con el siguiente
      }
    }
  } catch {
    // Sin permisos de envío o fallo temporal: no debe romper el flujo.
  }
});