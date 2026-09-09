import { Composer } from "grammy";
import { isGroupChat, isUserAdmin } from "../utils/permissions.js";
import type { MyContext } from "../types.js";

export const ayudaCommand = new Composer<MyContext>();

const COMMANDS_INFO: Array<Record<string, string>> = [
  { command: "/start", description: "Muestra el mensaje de bienvenida." },
  { command: "/ayuda", description: "Muestra esta lista de comandos." },
  { command: "/menu", description: "Abre el panel de administración (solo admins)." },
];

const COMMANDS_PREVIEW: Array<Record<string, string>> = [
  { command: "📋", description: "Reglas del grupo" },
  { command: "🚫", description: "Palabras y frases prohibidas" },
  { command: "🔇", description: "Silenciar (mute) temporal" },
  { command: "🔨", description: "Banear usuarios" },
  { command: "🛡️", description: "Anti-spam" },
  { command: "📊", description: "Registro de actividad" },
];

ayudaCommand.command("ayuda", async (ctx) => {
  const estoyEnGrupo = isGroupChat(ctx);
  const esAdmin = estoyEnGrupo ? await isUserAdmin(ctx) : false;

  const comandosActuales = COMMANDS_INFO.map(
    ({ command, description }) => `• *${command}* — ${description}`,
  ).join("\n");

  const proximamente = COMMANDS_PREVIEW.map(
    ({ command, description }) => `${command} ${description}`,
  ).join("\n");

  if (!estoyEnGrupo) {
    await ctx.reply(
      `📖 *Comandos disponibles*\n\n${comandosActuales}\n\n` +
        `*🧡 Próximamente*\n${proximamente}\n\n` +
        `ℹ️ Los comandos de administración solo funcionan dentro de un grupo y requieren permisos de administrador.`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  const textoAdmin = esAdmin
    ? "\n\n✅ Tienes permisos de administrador. Usa /menu para abrir el panel."
    : "\n\n⛔ Solo los administradores del grupo pueden usar los comandos de administración.";

  await ctx.reply(
    `📖 *Comandos disponibles*\n\n${comandosActuales}\n\n` +
      `*🧡 Próximamente*\n${proximamente}\n${textoAdmin}`,
    { parse_mode: "Markdown" },
  );
});