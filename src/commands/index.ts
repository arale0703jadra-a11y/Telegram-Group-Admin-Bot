import { Composer } from "grammy";
import { startCommand } from "./start.js";
import { ayudaCommand } from "./ayuda.js";
import { menuCommand } from "./menu.js";
import { moderationCommand } from "./moderation.js";
import { privateInput } from "./private-input.js";
import { welcomeCommand } from "./welcome.js";
import type { MyContext } from "../types.js";

/**
 * Instala todos los comandos y eventos en el bot.
 * Los módulos se agrupan aquí para mantener modular la estructura.
 */
export function registerCommands(bot: Composer<MyContext>): void {
  bot.use(startCommand);
  bot.use(ayudaCommand);
  bot.use(menuCommand);
  bot.use(moderationCommand);
  bot.use(privateInput);
  bot.use(welcomeCommand);
}