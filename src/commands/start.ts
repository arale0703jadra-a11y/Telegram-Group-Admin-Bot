import { Composer } from "grammy";
import { isGroupChat } from "../utils/permissions.js";
import { openPrivatePanel } from "../utils/private-panel.js";
import { BOT_DESCRIPTION } from "../config.js";
import type { MyContext } from "../types.js";

export const startCommand = new Composer<MyContext>();

startCommand.command("start", async (ctx) => {
  const firstName = ctx.from?.first_name ?? "";
  const name = firstName ? `, ${firstName}` : "";

  if (isGroupChat(ctx)) {
    const groupName = ctx.chat.title;
    await ctx.reply(
      `¡Hola${name}! 👋\n\n` +
        `Soy el bot de administración y moderación de *${groupName}*.\n\n` +
        `La administración del grupo se gestiona desde el chat privado del bot.\n\n` +
        `📖 Usa /ayuda para ver la lista de comandos disponibles.\n` +
        `🖥️ Los administradores pueden usar /menu para abrir el panel privado.`,
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