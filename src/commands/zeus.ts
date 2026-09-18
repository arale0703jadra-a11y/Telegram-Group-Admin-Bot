import { Composer } from "grammy";
import type { MyContext } from "../types.js";
import {
  bootstrapSystemOwner,
  consumeRecoveryKey,
  generateRecoveryKey,
  isSystemOwner,
} from "../services/system-owner.js";
import { SYSTEM_OWNER_BOOTSTRAP_ID } from "../config.js";

export const zeusCommand = new Composer<MyContext>();

function privateOnly(ctx: MyContext): boolean {
  return ctx.chat?.type === "private" && Boolean(ctx.from);
}

async function requireOwner(ctx: MyContext): Promise<boolean> {
  if (!privateOnly(ctx) || !ctx.from || !(await isSystemOwner(ctx.from.id))) {
    await ctx.reply("⛔ No autorizado.");
    return false;
  }
  return true;
}

async function bootstrap(ctx: MyContext): Promise<void> {
  if (!privateOnly(ctx) || !ctx.from || SYSTEM_OWNER_BOOTSTRAP_ID !== ctx.from.id) {
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

zeusCommand.command("zeus-bootstrap", bootstrap);

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

zeusCommand.command("zeus-generar-recuperacion", generateRecovery);
zeusCommand.command("generar-clave-recuperacion", generateRecovery);
zeusCommand.command("zeus-generate-recovery-key", generateRecovery);

async function beginRecovery(ctx: MyContext): Promise<void> {
  if (!privateOnly(ctx)) {
    await ctx.reply("🔐 La recuperación solo está disponible en el chat privado del bot.");
    return;
  }
  ctx.session.user.pendingAction = { kind: "recoveryKey" };
  await ctx.reply("🔐 Envía tu clave de recuperación de un solo uso.");
}

zeusCommand.command("zeus-recuperar", beginRecovery);
zeusCommand.command("recuperar-zeus", beginRecovery);
zeusCommand.command("zeus-recover", beginRecovery);
