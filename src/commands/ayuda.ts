import { Composer } from "grammy";
import type { MyContext } from "../types.js";

export const ayudaCommand = new Composer<MyContext>();

ayudaCommand.command("ayuda", async (ctx) => {
  await ctx.reply(
    "🆘 *AYUDA*\n\n" +
      "🚨 *Emergencias*\n" +
      "/menu — Abrir el panel administrativo.\n" +
      "/borrar — Eliminar un mensaje respondiendo a él.\n\n" +
      "🔐 *Recovery Key*\n" +
      "Sirve exclusivamente para recuperar o cambiar el System Owner, no autoriza grupos ni concede permisos de Telegram, y es de un solo uso.\n\n" +
      "Las funciones administrativas están disponibles desde /menu cuando tienes permisos.",
    { parse_mode: "Markdown" },
  );
});