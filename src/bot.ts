import { Bot } from "grammy";
import { validateConfig, BOT_NAME } from "./config.js";
import { sessionMiddleware } from "./middleware/session.js";
import { registerCommands } from "./commands/index.js";
import { menuNavigation } from "./menus/index.js";
import { moderationActions } from "./menus/actions.js";
import { isGroupChat, isUserAdmin } from "./utils/permissions.js";
import { promotionModeration } from "./filters/moderation.js";
import { getGroupData, saveGroupData, store } from "./storage/index.js";
import {
  markUserAsAdmin,
  registerGroup,
  unregisterGroup,
} from "./services/group-registry.js";
import type { MyContext } from "./types.js";

async function main(): Promise<void> {
  validateConfig();

  const bot = new Bot<MyContext>(process.env.BOT_TOKEN as string);

  bot.use(sessionMiddleware);

  bot.catch((err) => {
    console.error(`[ERROR] ${err.message}`);
  });

  bot.on("my_chat_member", async (ctx) => {
    if (!isGroupChat(ctx)) {
      return;
    }

    const next = ctx.myChatMember.new_chat_member.status;

    // Bot expulsado, fuera del grupo o ya NO administrador:
    // el grupo deja de ser administrable para el panel.
    if (
      next === "kicked" ||
      next === "left" ||
      next === "member" ||
      next === "restricted"
    ) {
      unregisterGroup(ctx.chat.id);
      console.log(`El bot ya no es administrador del grupo ${ctx.chat.id}`);
      return;
    }

    if (next === "administrator") {
      registerGroup(ctx.chat.id, ctx.chat.title ?? "");

      // Registra a los administradores reales para poder ofrecer el
      // panel en privado sin depender solo de /menu.
      try {
        const admins = await ctx.api.getChatAdministrators(ctx.chat.id);
        for (const admin of admins) {
          if (admin.user.is_bot) {
            continue;
          }
          markUserAsAdmin(ctx.chat.id, admin.user.id);
        }
      } catch {
        // Sin permisos o fallo temporal: se ignora.
      }

      console.log(
        `El bot es administrador del grupo ${ctx.chat.id} (${ctx.chat.title ?? "sin título"})`,
      );
    }
  });

  bot.command("admin", async (ctx) => {
    const esAdmin = await isUserAdmin(ctx);
    await ctx.reply(
      esAdmin
        ? "✅ Tienes permisos de administrador o creador en este grupo."
        : "⛔ No tienes permisos de administrador en este grupo.",
    );
  });

  // Indexa usuarios y mensajes recientes del grupo (en el almacén por chat_id)
  // para poder buscar por @username y limpiar mensajes desde el panel privado.
  bot.on("message", async (ctx, next) => {
    if (!isGroupChat(ctx) || !ctx.from) {
      await next();
      return;
    }

    const chatId = ctx.chat.id;
    console.log(
      `[USER OBSERVED] groupId=${chatId} userId=${ctx.from.id} ` +
        `username=${ctx.from.username ?? "none"}`,
    );
    try {
      const data = await getGroupData(chatId);
      const now = Math.floor(Date.now() / 1000);

      if (!ctx.from.is_bot) {
        const key = String(ctx.from.id);
        const existing = data.indexedUsers[key];
        const firstName = ctx.from.first_name ?? "";
        const lastName = ctx.from.last_name ?? "";
        const displayName = [firstName, lastName].filter(Boolean).join(" ");
        if (existing) {
          existing.groupId = chatId;
          existing.firstName = firstName;
          existing.lastName = lastName;
          existing.username = ctx.from.username ?? "";
          existing.name = displayName;
          existing.displayName = displayName;
          existing.lastSeen = now;
        } else {
          data.indexedUsers[key] = {
            id: ctx.from.id,
            groupId: chatId,
            firstName,
            lastName,
            name: displayName,
            username: ctx.from.username ?? "",
            firstSeen: now,
            displayName,
            lastSeen: now,
          };
        }
        if (Object.keys(data.indexedUsers).length > 300) {
          const oldest = Object.keys(data.indexedUsers)[0];
          if (oldest) {
            delete data.indexedUsers[oldest];
          }
        }
      }

      data.recentMessages.push(ctx.message.message_id);
      if (data.recentMessages.length > 250) {
        data.recentMessages.splice(0, data.recentMessages.length - 250);
      }

      await saveGroupData(chatId, data);
      console.log(
        `[USER OBSERVED] persisted groupId=${chatId} userId=${ctx.from.id}`,
      );
    } catch (error) {
      console.error("[INDEXADO] No se pudo registrar el mensaje:", error);
    }
    await next();
  });

  bot.use(promotionModeration);
  registerCommands(bot);

  bot.use(menuNavigation);
  bot.use(moderationActions);

  await bot.start({
    // Fijar la lista evita conservar una configuración previa que excluya
    // mensajes normales de grupo del polling.
    allowed_updates: ["message", "callback_query", "my_chat_member"],
    onStart: (botInfo) => {
      console.log(`🤖 ${BOT_NAME} iniciado correctamente como @${botInfo.username}`);
    },
  });

  // Graceful shutdown: forzar flush de datos antes de cerrar
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} recibido. Cerrando bot de forma segura...`);
    try {
      // Forzar flush de todos los datos pendientes
      await store.flushForced();
      console.log("✅ Datos guardados correctamente.");
    } catch (error) {
      console.error("❌ Error al guardar datos:", error);
    }
    try {
      await bot.stop();
      console.log("🤖 Bot detenido correctamente.");
    } catch (error) {
      console.error("❌ Error al detener bot:", error);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Error al iniciar el bot:", error);
  process.exit(1);
});