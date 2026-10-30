import { Composer } from "grammy";
import type { MyContext } from "../types.js";
import {
  bootstrapSystemOwner,
  consumeRecoveryKey,
  generateRecoveryKey,
  isEffectiveOwner,
} from "../services/system-owner.js";
import { COMMANDS } from "./definitions.js";

export const zeusCommand = new Composer<MyContext>();

function privateOnly(ctx: MyContext): boolean {
  return ctx.chat?.type === "private" && Boolean(ctx.from);
}

async function requireOwner(ctx: MyContext): Promise<boolean> {
  if (!privateOnly(ctx) || !ctx.from || !(await isEffectiveOwner(ctx.from.id))) {
    await ctx.reply("⛔ No autorizado.");
    return false;
  }
  return true;
}

async function bootstrap(ctx: MyContext): Promise<void> {
  if (!privateOnly(ctx) || !ctx.from || !(await isEffectiveOwner(ctx.from.id))) {
    await ctx.reply("⛔ Bootstrap no autorizado.");
    return;
  }
  try {
    const bootstrapped = await bootstrapSystemOwner(ctx.from.id);
    await ctx.reply(
      bootstrapped
        ? "✅ System Owner inicial establecido."
        : "⛔ El System Owner ya está establecido o el bootstrap no está disponible.",
    );
  } catch {
    await ctx.reply("⛔ No se pudo establecer el System Owner inicial.");
  }
}

zeusCommand.command(COMMANDS.bootstrap, bootstrap);

async function generateRecovery(ctx: MyContext): Promise<void> {
  if (!(await requireOwner(ctx))) return;
  try {
    const key = await generateRecoveryKey(ctx.from!.id);
    // This is the sole plaintext delivery. It is sent only to the authenticated
    // owner's private chat and is never logged or echoed again.
    await ctx.reply(
      `🔐 Clave de recuperación de un solo uso:\n\n${key}\n\n` +
      "Guárdala fuera de Telegram. No volveré a mostrarla.",
    );
  } catch {
    await ctx.reply("⛔ No se pudo generar la clave de recuperación.");
  }
}

zeusCommand.command(COMMANDS.generateRecovery, generateRecovery);
zeusCommand.command(COMMANDS.generateRecoveryAlias, generateRecovery);
zeusCommand.command(COMMANDS.generateRecoveryEnglishAlias, generateRecovery);

async function beginRecovery(ctx: MyContext): Promise<void> {
  if (!privateOnly(ctx)) {
    await ctx.reply("🔐 La recuperación solo está disponible en el chat privado del bot.");
    return;
  }
  if (typeof ctx.match === "string" && ctx.match.trim()) {
    ctx.session.user.pendingAction = undefined;
    try {
      await ctx.deleteMessage();
    } catch (error) {
      console.warn(
        `[RECOVERY] No se pudo borrar el comando con argumentos userId=${ctx.from?.id ?? "unknown"} ` +
          `error=${error instanceof Error ? error.name : "unknown"}`,
      );
    }
    await ctx.reply(
      "⛔ No incluyas la clave junto al comando. Envíala en un mensaje privado separado después de iniciar la recuperación.",
    );
    return;
  }
  ctx.session.user.pendingAction = { kind: "recoveryKey" };
  await ctx.reply(
    "🔐 Envía tu clave de recuperación de un solo uso en un mensaje privado separado.",
  );
}

zeusCommand.command(COMMANDS.recover, beginRecovery);
zeusCommand.command(COMMANDS.recoverAlias, beginRecovery);
zeusCommand.command(COMMANDS.recoverEnglishAlias, beginRecovery);
