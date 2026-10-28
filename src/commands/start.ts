import { Composer } from "grammy";
import { isGroupChat } from "../utils/permissions.js";
import { openPrivatePanel } from "../utils/private-panel.js";
import { BOT_DESCRIPTION } from "../config.js";
import type { MyContext } from "../types.js";
import { COMMANDS } from "./definitions.js";

export const startCommand = new Composer<MyContext>();

startCommand.command(COMMANDS.start, async (ctx) => {
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