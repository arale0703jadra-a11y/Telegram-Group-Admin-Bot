import { Composer } from "grammy";
import { isGroupChat, isUserAdmin } from "../utils/permissions.js";
import type { MyContext } from "../types.js";
import { COMMANDS, COMMAND_DEFINITIONS } from "./definitions.js";

export const ayudaCommand = new Composer<MyContext>();

ayudaCommand.command(COMMANDS.ayuda, async (ctx) => {
  const estoyEnGrupo = isGroupChat(ctx);
  const esAdmin = estoyEnGrupo ? await isUserAdmin(ctx) : false;

  const comandosActuales = COMMAND_DEFINITIONS.map((definition) =>
    `• *${definition.command}* — ${definition.description}` +
    (definition.aliases.length ? ` (alias: ${definition.aliases.join(", ")})` : ""),
  ).join("\n");

  if (!estoyEnGrupo) {
    await ctx.reply(
      `📖 *Comandos disponibles*\n\n${comandosActuales}\n\n` +
        `ℹ️ Las operaciones de grupo requieren permisos de administrador. El panel privado requiere una cuenta autorizada de ZEUS.`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  const textoAdmin = esAdmin
    ? "\n\n✅ Tienes permisos de administrador en el grupo. El panel privado requiere además una cuenta autorizada de ZEUS."
    : "\n\n⛔ Necesitas permisos de administrador del grupo para las operaciones de administración.";

  await ctx.reply(
    `📖 *Comandos disponibles*\n\n${comandosActuales}${textoAdmin}`,
    { parse_mode: "Markdown" },
  );
});