import { Composer } from "grammy";
import { isGroupChat } from "../utils/permissions.js";
import { openPrivatePanel } from "../utils/private-panel.js";
import { BOT_DESCRIPTION } from "../config.js";
import type { MyContext } from "../types.js";
import { COMMANDS } from "./definitions.js";

export const startCommand = new Composer<MyContext>();

startCommand.command(COMMANDS.start, async (ctx) => {
  if (
    ctx.chat.type === "private" &&
    typeof ctx.match === "string" &&
    ctx.match.trim() === "menu"
  ) {
    try {
      await openPrivatePanel(ctx);
    } catch (error) {
      const detail = error instanceof Error ? error.name : "unknown";
      console.error(
        `[START] No se pudo abrir el panel desde el enlace de acceso error=${detail}`,
      );
      try {
        await ctx.reply(
          "⚠️ No pude abrir el panel en este momento. Inténtalo de nuevo más tarde.",
        );
      } catch {
        // Un segundo fallo al responder no debe escapar sin controlar.
      }
    }
    return;
  }

  const firstName = ctx.from?.first_name ?? "";
  const name = firstName ? `, ${firstName}` : "";

  if (isGroupChat(ctx)) {
    const groupName = ctx.chat.title;
    await ctx.reply(
      `¡Hola${name}! 👋\n\n` +
        `Soy el bot de administración y moderación de *${groupName}*.\n\n` +
        `La administración del grupo se gestiona desde el chat privado del bot.\n\n` +
        `📖 Usa /ayuda para ver la lista de comandos disponibles.\n` +
        `🖥️ El panel privado requiere una cuenta autorizada de ZEUS y permisos vigentes en este grupo.`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  await ctx.reply(
    `¡Hola${name}! 👋\n\n` +
      `${BOT_DESCRIPTION}.\n\n` +
      `A continuación verás tus grupos administrables, si los tienes.\n\n` +
      `📖 Usa /ayuda para ver la lista de comandos disponibles.`,
    { parse_mode: "Markdown" },
  );

  await openPrivatePanel(ctx);
});