import { Bot, Context } from "grammy";
import { validateConfig, BOT_NAME } from "./config.js";
import { sessionMiddleware } from "./middleware/session.js";
import { registerCommands } from "./commands/index.js";
import {
  cleanServiceMessages,
  initializeServiceMessageCleanup,
} from "./commands/clean-service-messages.js";
import { menuNavigation } from "./menus/index.js";
import { moderationActions } from "./menus/actions.js";
import { isGroupChat, isUserAdmin } from "./utils/permissions.js";
import { promotionModeration } from "./filters/moderation.js";
import { illegalModeration } from "./filters/illegal-moderation.js";
import { antiRaid } from "./filters/anti-raid.js";
import { antiSpam } from "./filters/anti-spam.js";
import { linkFilter } from "./filters/link-filter.js";
import { profileChecker } from "./filters/profile-checker.js";
import { adminImpersonation } from "./filters/admin-impersonation.js";
import { botAdditionGuard } from "./filters/bot-addition-guard.js";
import { deletedAccounts } from "./filters/deleted-accounts.js";
import { emergencyLockdown } from "./filters/emergency-lockdown.js";
import { newMemberQuarantine } from "./filters/new-member-quarantine.js";
import { adminGuardian } from "./security/admin-guardian.js";
import { replyWithAutoDelete } from "./utils/cleanup.js";
import {
  INACTIVITY_CLEANER_INTERVAL_MS,
  runInactivityCleaner,
} from "./services/inactivity-cleaner.js";
import { recordUserActivity } from "./services/user-activity.js";
import { getGroupData, saveGroupData, store } from "./storage/index.js";
import {
  markUserAsAdmin,
  registerGroup,
  unregisterGroup,
} from "./services/group-registry.js";
import { MAX_ACTIVITY_MESSAGES, type ActivityMessage } from "./storage/types.js";
import type { MyContext } from "./types.js";
import { syncVerifiedAdministrators } from "./services/verified-title-sync.js";
import { openPrivatePanel } from "./utils/private-panel.js";
import {
  expireEmergencyIfNeeded,
  isEmergencyActive,
} from "./filters/anti-raid-engine.js";
import { restrictRecentMembers } from "./services/emergency-mode.js";
import { automaticMessageScheduler } from "./services/automatic-messages.js";

async function main(): Promise<void> {
  validateConfig();

  const bot = new Bot<MyContext>(process.env.BOT_TOKEN as string);
  await bot.init();
  await initializeServiceMessageCleanup();
  const inactivityContext = Object.assign(
    new Context({ update_id: 0 }, bot.api, bot.botInfo),
    { session: { group: {}, user: {} } },
  ) as MyContext;

  bot.catch((err) => {
    console.error(`[ERROR] ${err.message}`);
  });

  bot.use(cleanServiceMessages);
  bot.use(sessionMiddleware);
  bot.use(deletedAccounts);
  bot.use(adminGuardian);
  bot.use(botAdditionGuard);
  bot.use(profileChecker);
  bot.use(adminImpersonation);

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
          if (!admin.user.is_bot) {
            markUserAsAdmin(ctx.chat.id, admin.user.id);
          }
        }
      } catch (error) {
        console.error(
          `[GROUP_REGISTRY] No se pudieron registrar administradores groupId=${ctx.chat.id}`,
          error,
        );
      }
      try {
        await syncVerifiedAdministrators(ctx.api, ctx.chat.id, ctx.from?.id ?? 0);
      } catch (error) {
        console.error(
          `[VERIFIED_TITLE] No se pudo sincronizar administradores groupId=${ctx.chat.id}`,
          error,
        );
      }

      console.log(
        `El bot es administrador del grupo ${ctx.chat.id} (${ctx.chat.title ?? "sin título"})`,
      );
    }
  });

  bot.command("admin", async (ctx) => {
    if (ctx.chat.type === "private") {
      await openPrivatePanel(ctx);
      return;
    }
    const esAdmin = await isUserAdmin(ctx);
    await replyWithAutoDelete(
      ctx,
      esAdmin
        ? "✅ Tienes permisos de administrador o creador en este grupo."
        : "⛔ No tienes permisos de administrador en este grupo.",
    );
  });

  bot.on("chat_member", async (ctx, next) => {
    if (isGroupChat(ctx) && ctx.from) {
      const member = ctx.chatMember.new_chat_member;
      const previousStatus = ctx.chatMember.old_chat_member.status;
      const hasJoined =
        member.status === "member" ||
        (member.status === "restricted" && member.is_member);
      if (
        !member.user.is_bot &&
        (previousStatus === "left" || previousStatus === "kicked") &&
        hasJoined
      ) {
        try {
          const data = await getGroupData(ctx.chat.id);
          const key = String(member.user.id);
          const joinedAt = ctx.chatMember.date;
          const name = [
            member.user.first_name,
            member.user.last_name,
          ].filter(Boolean).join(" ");
          const existing = data.indexedUsers[key];
          data.indexedUsers[key] = {
            ...existing,
            id: member.user.id,
            groupId: ctx.chat.id,
            firstName: member.user.first_name,
            lastName: member.user.last_name,
            name,
            displayName: name,
            username: member.user.username ?? "",
            firstSeen: existing?.firstSeen ?? joinedAt,
            joinedAt,
            lastActivityType: "join",
          };
          const now = Date.now();
          data.emergency = expireEmergencyIfNeeded(data.emergency, now);
          if (isEmergencyActive(data.emergency, now)) {
            const result = await restrictRecentMembers(
              ctx,
              ctx.chat.id,
              data,
              now,
            );
            if (result.failed > 0) {
              console.error(
                `[ANTI_RAID] Fallaron ${result.failed} restricciones para la entrada groupId=${ctx.chat.id} userId=${member.user.id}.`,
              );
            }
          }
          await saveGroupData(ctx.chat.id, data);
        } catch (error) {
          console.error(
            `[ANTI_RAID] No se pudo registrar la entrada groupId=${ctx.chat.id} userId=${member.user.id}:`,
            error,
          );
        }
      }
      if (
        member.status === "administrator" &&
        "custom_title" in member &&
        member.custom_title?.trim().toLocaleLowerCase("es") === "verificada"
      ) {
        try {
          await syncVerifiedAdministrators(ctx.api, ctx.chat.id, ctx.from.id);
        } catch (error) {
          console.error(
            `[VERIFIED_TITLE] No se pudo procesar chat_member groupId=${ctx.chat.id} userId=${member.user.id}`,
            error,
          );
        }
      }
    }
    await next();
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
      data.activityMessages = data.activityMessages.filter(
        (message) => message.timestamp >= now - 60 * 24 * 60 * 60,
      );
      const joinedMembers = "new_chat_members" in ctx.message
        ? ctx.message.new_chat_members ?? []
        : [];

      if (!ctx.from.is_bot) {
        const key = String(ctx.from.id);
        const existing = data.indexedUsers[key];
        const firstName = ctx.from.first_name ?? "";
        const lastName = ctx.from.last_name ?? "";
        const displayName = [firstName, lastName].filter(Boolean).join(" ");
        const activityMessage: ActivityMessage = {
          messageId: ctx.message.message_id,
          groupId: chatId,
          userId: ctx.from.id,
          firstName,
          lastName,
          name: displayName,
          username: ctx.from.username,
          timestamp: now,
        };
        if (!data.activityMessages.some(
          (message) =>
            message.groupId === chatId &&
            message.messageId === ctx.message.message_id,
        )) {
          data.activityMessages.push(activityMessage);
          if (data.activityMessages.length > MAX_ACTIVITY_MESSAGES) {
            data.activityMessages.splice(
              0,
              data.activityMessages.length - MAX_ACTIVITY_MESSAGES,
            );
          }
        }
        if (existing) {
          existing.groupId = chatId;
          existing.firstSeen ??= now;
          existing.firstName = firstName;
          existing.lastName = lastName;
          existing.username = ctx.from.username ?? "";
          existing.name = displayName;
          existing.displayName = displayName;
          existing.lastSeen = now;
          existing.lastActivityType = "message";
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
            lastActivityType: "message",
          };
        }
      }

      for (const member of joinedMembers) {
        if (member.is_bot) continue;
        const key = String(member.id);
        const existing = data.indexedUsers[key];
        const name = [member.first_name, member.last_name].filter(Boolean).join(" ");
        if (existing) {
          existing.groupId = chatId;
          existing.firstSeen ??= now;
          existing.joinedAt = now;
          existing.lastActivityType = "join";
          existing.firstName = member.first_name;
          existing.lastName = member.last_name;
          existing.name = name;
          existing.displayName = name;
          existing.username = member.username ?? "";
        } else {
          data.indexedUsers[key] = {
            id: member.id,
            groupId: chatId,
            firstName: member.first_name,
            lastName: member.last_name,
            name,
            displayName: name,
            username: member.username ?? "",
            firstSeen: now,
            joinedAt: now,
            lastActivityType: "join",
          };
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
    if (!ctx.from.is_bot) {
      try {
        await recordUserActivity(ctx, chatId, ctx.from.id, ctx.message.date);
      } catch (error) {
        console.error(
          `[USER_ACTIVITY] No se pudo guardar actividad groupId=${chatId} userId=${ctx.from.id}:`,
          error,
        );
      }
    }
    await next();
  });

  bot.use(antiRaid);
  bot.use(emergencyLockdown);
  bot.use(newMemberQuarantine);
  bot.use(linkFilter);
  bot.use(antiSpam);
  bot.use(illegalModeration);
  bot.use(promotionModeration);
  registerCommands(bot);

  bot.use(menuNavigation);
  bot.use(moderationActions);

  const inactivityTimer = setInterval(() => {
    void runInactivityCleaner(inactivityContext);
  }, INACTIVITY_CLEANER_INTERVAL_MS);
  void runInactivityCleaner(inactivityContext);
  automaticMessageScheduler.start(bot.api);

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
      automaticMessageScheduler.stop();
      clearInterval(inactivityTimer);
      console.log("🤖 Bot detenido correctamente.");
    } catch (error) {
      console.error("❌ Error al detener bot:", error);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await bot.start({
    // Fijar la lista evita conservar una configuración previa que excluya
    // mensajes normales de grupo del polling.
    allowed_updates: [
      "message",
      "chat_member",
      "callback_query",
      "my_chat_member",
    ],
    onStart: (botInfo) => {
      console.log(`🤖 ${BOT_NAME} iniciado correctamente como @${botInfo.username}`);
    },
  });

}

main().catch((error) => {
  console.error("Error al iniciar el bot:", error);
  process.exit(1);
});