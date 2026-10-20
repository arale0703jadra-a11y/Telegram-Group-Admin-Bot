import { Composer, InlineKeyboard } from "grammy";
import { isUserAdminOf } from "../utils/permissions.js";
import { getGroupData, saveGroupData } from "../storage/index.js";
import {
  banUser,
  cleanRecentMessages,
  getBotRights,
  muteUser,
  unmuteUser,
  unbanUser,
  unwarnUser,
  unwarnAllUser,
  warnUser,
} from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { getTrackedUser, getUserCard } from "../utils/users.js";
import {
  buildBanConfirmPanel,
  buildCleanupPanel,
  buildCleanupSettingsPanel,
  buildAutomaticMessagePanel,
  buildDeleteHelpPanel,
  buildFilterConfirmPanel,
  buildFilterListPanel,
  buildFiltersPanel,
  buildPromotionInfoPanel,
  buildPromotionSettingsPanel,
  buildIllegalCategoriesPanel,
  buildIllegalConfirmPanel,
  buildIllegalInfoPanel,
  buildIllegalPanel,
  buildIllegalTermsPanel,
  buildInactivityPanel,
  buildInactiveUsersPanel,
  buildInactivityCleanConfirmPanel,
  buildAntiSpamPanel,
  buildProtectionCenterPanel,
  buildVerifiedModelsPanel,
  buildMainPanel,
  buildMuteMenuPanel,
  buildPromptPanel,
  buildUnbanListPanel,
  buildUnwarnAllConfirmPanel,
  buildUserCardPanel,
  buildUsersPanel,
  buildViewWarningsPanel,
  FilterAction,
  EmergencyAction,
  AutomaticMessageAction,
  buildWarningsPanel,
  ModAction,
} from "./panels.js";
import { renderPanel } from "./render.js";
import type { MyContext, PickAction } from "../types.js";
import {
  getInactiveUsers,
  removeInactiveUser,
} from "../services/inactivity.js";
import {
  getVerifiedUser,
  getVerifiedUsers,
  invalidateVerifiedUserCache,
  revokeVerifiedUser,
} from "../services/verified-users.js";
import { unmarkUserVerified } from "../services/user-registry.js";
import {
  activateEmergency,
  expireEmergencyIfNeeded,
  isEmergencyActive,
} from "../filters/anti-raid-engine.js";
import {
  restrictRecentMembers,
  restoreEmergencyRestrictions,
} from "../services/emergency-mode.js";
import { automaticMessageScheduler } from "../services/automatic-messages.js";
import { setServiceMessageCleanupEnabled } from "../commands/clean-service-messages.js";

const NO_ADMIN_MESSAGE = "⛔ Ya no eres administrador de ese grupo.";
const NO_GROUP_SELECTED_MESSAGE =
  "Primero selecciona el grupo que quieres administrar.";
const EMERGENCY_DURATION_OPTIONS = [15, 30, 60, 120, 360, 720, 1440] as const;

/**
 * Acciones reales del panel (Usuarios + Moderación).
 * Cada callback se autoriza contra el chat_id del grupo seleccionado.
 */
export const moderationActions = new Composer<MyContext>();

moderationActions.on("callback_query:data", async (ctx) => {
  const parts = ctx.callbackQuery.data.split(":");
  if (
    parts[0] !== "ma" &&
    parts[0] !== "fa" &&
    parts[0] !== "sa" &&
    parts[0] !== "ia" &&
    parts[0] !== "cl" &&
    parts[0] !== "am" &&
    parts[0] !== "ep"
  ) {
    return; // Callback ajeno: lo gestiona otro controlador.
  }

  const kind = parts[1];
  if (!kind) {
    return;
  }

  const groupId = ctx.session.user.selectedGroupId;
  if (typeof groupId !== "number" || !Number.isInteger(groupId)) {
    await ctx.answerCallbackQuery(NO_GROUP_SELECTED_MESSAGE);
    return;
  }
  const isAdmin = await isUserAdminOf(ctx, groupId);
  if (!isAdmin) {
    await ctx.answerCallbackQuery(NO_ADMIN_MESSAGE);
    return;
  }

  if (parts[0] === "ep") {
    if (
      (kind !== "toggle" && kind !== "duration") ||
      ctx.chat?.type !== "private"
    ) {
      await ctx.answerCallbackQuery("Acción del Centro de Protección no válida.");
      return;
    }
    const data = await getGroupData(groupId);
    const now = Date.now();
    data.emergency = expireEmergencyIfNeeded(data.emergency, now);

    if (kind === "duration") {
      const currentIndex = EMERGENCY_DURATION_OPTIONS.indexOf(
        data.antiRaid.emergencyMinutes as
          (typeof EMERGENCY_DURATION_OPTIONS)[number],
      );
      const nextIndex =
        currentIndex < 0
          ? EMERGENCY_DURATION_OPTIONS.indexOf(60)
          : (currentIndex + 1) % EMERGENCY_DURATION_OPTIONS.length;
      data.antiRaid.emergencyMinutes =
        EMERGENCY_DURATION_OPTIONS[nextIndex] ?? 60;
      await saveGroupData(groupId, data);
      await ctx.answerCallbackQuery(
        `Duración: ${data.antiRaid.emergencyMinutes} minutos.`,
      );
      await renderPanel(
        ctx,
        buildProtectionCenterPanel(
          data.emergency,
          data.antiRaid.emergencyMinutes,
          ctx.session.user.selectedGroupTitle,
        ),
      );
      return;
    }

    if (isEmergencyActive(data.emergency, now)) {
      const restored = await restoreEmergencyRestrictions(ctx, groupId, data);
      if (!restored) {
        await saveGroupData(groupId, data);
        await ctx.answerCallbackQuery(
          "No se pudieron restaurar todos los permisos. El modo sigue activo.",
        );
        await renderPanel(
          ctx,
          buildProtectionCenterPanel(
            data.emergency,
            data.antiRaid.emergencyMinutes,
            ctx.session.user.selectedGroupTitle,
          ),
        );
        return;
      }
      data.emergency = { active: false };
      await logEvent(ctx, groupId, "ANTIRAID", {
        result: "ok",
        detail: "Modo de emergencia desactivado manualmente.",
      });
    } else {
      data.emergency = activateEmergency(
        data.emergency,
        "activacion-manual",
        now,
        data.antiRaid.emergencyMinutes,
      );
      const restrictionResult = await restrictRecentMembers(
        ctx,
        groupId,
        data,
        now,
      );
      await logEvent(ctx, groupId, "ANTIRAID", {
        result: restrictionResult.failed > 0 ? "error" : "ok",
        detail:
          `Modo de emergencia activado manualmente; restringidos=${restrictionResult.restricted}; ` +
          `fallidos=${restrictionResult.failed}.`,
      });
    }

    await saveGroupData(groupId, data);
    await ctx.answerCallbackQuery(
      isEmergencyActive(data.emergency, Date.now())
        ? "Modo de emergencia activado."
        : "Modo de emergencia desactivado.",
    );
    await renderPanel(
      ctx,
      buildProtectionCenterPanel(
        data.emergency,
        data.antiRaid.emergencyMinutes,
        ctx.session.user.selectedGroupTitle,
      ),
    );
    return;
  }

  if (parts[0] === "cl") {
    if (kind !== "toggle" || ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery("Acción de limpieza no válida.");
      return;
    }
    const data = await getGroupData(groupId);
    data.cleanup.autoDeleteServiceMessages = !data.cleanup.autoDeleteServiceMessages;
    await saveGroupData(groupId, data);
    setServiceMessageCleanupEnabled(
      groupId,
      data.cleanup.autoDeleteServiceMessages,
    );
    await ctx.answerCallbackQuery(
      data.cleanup.autoDeleteServiceMessages
        ? "Auto-eliminación de avisos activada."
        : "Auto-eliminación de avisos desactivada.",
    );
    await renderPanel(
      ctx,
      buildCleanupSettingsPanel(data.cleanup, ctx.session.user.selectedGroupTitle),
    );
    return;
  }

  if (parts[0] === "am") {
    if (
      !["home", "toggle", "interval", "configure", "send-now"].includes(kind) ||
      ctx.chat?.type !== "private"
    ) {
      await ctx.answerCallbackQuery("Acción de mensajes recurrentes no válida.");
      return;
    }
    const data = await getGroupData(groupId);
    if (kind === "configure") {
      ctx.session.user.pendingAction = { kind: "automaticMessage", groupId };
      await ctx.answerCallbackQuery();
      await renderPanel(
        ctx,
        buildPromptPanel(
          "✏️ *MENSAJE RECURRENTE*\n\nEscribe el texto que ZEUS publicará periódicamente en el grupo.",
        ),
      );
      return;
    }
    if (kind === "toggle") {
      if (!data.automaticMessage?.message) {
        await ctx.answerCallbackQuery("Primero configura el texto del mensaje.");
        await renderPanel(
          ctx,
          buildAutomaticMessagePanel(data.automaticMessage, ctx.session.user.selectedGroupTitle),
        );
        return;
      }
      data.automaticMessage.enabled = !data.automaticMessage.enabled;
      data.automaticMessage.intervalMinutes ??= 60;
      data.automaticMessage.nextRunAt = data.automaticMessage.enabled
        ? new Date(Date.now() + data.automaticMessage.intervalMinutes * 60_000).toISOString()
        : undefined;
      await saveGroupData(groupId, data);
      await automaticMessageScheduler.refreshGroup(groupId);
      await ctx.answerCallbackQuery(
        data.automaticMessage.enabled
          ? "Mensajes recurrentes activados."
          : "Mensajes recurrentes desactivados.",
      );
    } else if (kind === "interval") {
      const intervals = [15, 30, 60, 120, 240, 480, 1440];
      const current = data.automaticMessage?.intervalMinutes ?? 60;
      const currentIndex = intervals.indexOf(current);
      const nextInterval = intervals[(currentIndex + 1) % intervals.length] ?? 60;
      data.automaticMessage = {
        enabled: data.automaticMessage?.enabled ?? false,
        message: data.automaticMessage?.message ?? "",
        intervalMinutes: nextInterval,
        nextRunAt: data.automaticMessage?.enabled
          ? new Date(Date.now() + nextInterval * 60_000).toISOString()
          : data.automaticMessage?.nextRunAt,
        lastSentAt: data.automaticMessage?.lastSentAt,
        lastMessageId: data.automaticMessage?.lastMessageId,
      };
      await saveGroupData(groupId, data);
      await automaticMessageScheduler.refreshGroup(groupId);
      await ctx.answerCallbackQuery(`Intervalo: ${nextInterval} minutos.`);
    } else if (kind === "send-now") {
      await ctx.answerCallbackQuery("Enviando mensaje…");
      const result = await automaticMessageScheduler.sendNow(groupId);
      if (!result.ok) {
        const note = result.error instanceof Error
          ? result.error.message
          : "Error de envío.";
        await renderPanel(
          ctx,
          buildAutomaticMessagePanel(
            data.automaticMessage,
            ctx.session.user.selectedGroupTitle,
            `⛔ ${note}`,
          ),
        );
        return;
      }
      const updated = await getGroupData(groupId);
      await renderPanel(
        ctx,
        buildAutomaticMessagePanel(
          updated.automaticMessage,
          ctx.session.user.selectedGroupTitle,
          "✅ Mensaje enviado.",
        ),
      );
      return;
    } else {
      await ctx.answerCallbackQuery();
    }

    await renderPanel(
      ctx,
      buildAutomaticMessagePanel(
        data.automaticMessage,
        ctx.session.user.selectedGroupTitle,
      ),
    );
    return;
  }

  if (parts[0] === "fa" || parts[0] === "sa" || parts[0] === "ia") {
    const title = ctx.session.user.selectedGroupTitle;
    if (parts[0] === "fa" && kind === "home") {
      const data = await getGroupData(groupId);
      await ctx.answerCallbackQuery();
      await renderPanel(ctx, buildFiltersPanel(data.promotion, title));
      return;
    }
    if (parts[0] === "fa" && kind === "test") {
      ctx.session.user.pendingAction = { kind: "promotionTest", groupId };
      await ctx.answerCallbackQuery();
      await renderPanel(
        ctx,
        buildPromptPanel(
          "🧪 *PROBAR MENSAJE*\n\nEnvía el texto que quieres analizar. No se publicará en el grupo ni se moderará.",
        ),
      );
      return;
    }
    if (parts[0] === "fa" && (kind === "verified" || kind === "verified_list")) {
      const page = kind === "verified_list" ? Number(parts[2] ?? 0) : 0;
      if (!Number.isInteger(page) || page < 0) {
        await ctx.answerCallbackQuery("Página no válida.");
        return;
      }
      const users = await getVerifiedUsers(groupId);
      await ctx.answerCallbackQuery();
      await renderPanel(ctx, buildVerifiedModelsPanel(users, page, title));
      return;
    }
    if (
      parts[0] === "fa" &&
      (kind === "verified_mute" || kind === "verified_ban" || kind === "verified_revoke")
    ) {
      const userId = Number(parts[2]);
      if (!Number.isSafeInteger(userId) || userId <= 0) {
        await ctx.answerCallbackQuery("Usuario no válido.");
        return;
      }
      const verifiedUser = await getVerifiedUser(groupId, userId);
      if (!verifiedUser) {
        await ctx.answerCallbackQuery("La verificación ya no está activa.");
        return;
      }

      try {
        let resultMessage: string;
        if (kind === "verified_mute") {
          const result = await muteUser(
            ctx,
            groupId,
            userId,
            24 * 60,
            verifiedUser.display_name ?? verifiedUser.username ?? String(userId),
          );
          if (!result.ok) throw new Error(result.error ?? "No se pudo silenciar.");
          resultMessage = "Silenciada durante 24 horas.";
        } else if (kind === "verified_ban") {
          const result = await banUser(
            ctx,
            groupId,
            userId,
            verifiedUser.display_name ?? verifiedUser.username ?? String(userId),
          );
          if (!result.ok) throw new Error(result.error ?? "No se pudo banear.");
          await revokeVerifiedUser(groupId, userId);
          await unmarkUserVerified(groupId, userId);
          invalidateVerifiedUserCache(groupId, userId);
          resultMessage = "Baneada y verificación retirada.";
        } else {
          await revokeVerifiedUser(groupId, userId);
          await unmarkUserVerified(groupId, userId);
          invalidateVerifiedUserCache(groupId, userId);
          resultMessage = "Verificación retirada.";
        }
        await ctx.answerCallbackQuery(resultMessage);
      } catch (error) {
        console.error(
          `[VERIFIED_ADMIN] Falló action=${kind} groupId=${groupId} userId=${userId}`,
          error,
        );
        await ctx.answerCallbackQuery("No se pudo completar la acción.");
      }
      const users = await getVerifiedUsers(groupId);
      await renderPanel(ctx, buildVerifiedModelsPanel(users, 0, title));
      return;
    }
    if (
      parts[0] === "fa" &&
      (kind === "stats" ||
        kind === "buying" ||
        kind === "selling" ||
        kind === "links")
    ) {
      const data = await getGroupData(groupId);
      await ctx.answerCallbackQuery();
      await renderPanel(
        ctx,
        buildPromotionInfoPanel(kind, data.promotion, title),
      );
      return;
    }
    if (parts[0] === "fa" && kind === "settings") {
      const data = await getGroupData(groupId);
      await ctx.answerCallbackQuery();
      await renderPanel(ctx, buildPromotionSettingsPanel(data.promotion, title));
      return;
    }
    if (kind === "add") {
      ctx.session.user.pendingAction = { kind: "filterAdd", groupId };
      await ctx.answerCallbackQuery();
      await renderPanel(
        ctx,
        buildPromptPanel(
          "✏️ *AGREGAR FILTRO*\n\nEscribe la palabra o frase que quieres agregar.",
        ),
      );
      return;
    }

    if (parts[0] === "ia") {
      const title = ctx.session.user.selectedGroupTitle;
      if (kind === "toggle") {
        const data = await getGroupData(groupId);
        data.inactivity.enabled = !data.inactivity.enabled;
        await saveGroupData(groupId, data);
        await ctx.answerCallbackQuery();
        await renderPanel(ctx, buildInactivityPanel(data.inactivity, title));
        return;
      }
      if (kind === "list") {
        const page = Number(parts[2] ?? 0);
        const users = await getInactiveUsers(ctx, groupId);
        await ctx.answerCallbackQuery();
        await renderPanel(ctx, buildInactiveUsersPanel(users, page, title));
        return;
      }
      if (kind === "config") {
        const data = await getGroupData(groupId);
        const choices = [7, 15, 30, 60, 90];
        const current = data.inactivity.customDays ?? data.inactivity.inactivityDays;
        const next = choices[(choices.indexOf(current) + 1) % choices.length] ?? 30;
        data.inactivity.customDays = undefined;
        data.inactivity.inactivityDays = next;
        await saveGroupData(groupId, data);
        await ctx.answerCallbackQuery(`Período: ${next} días`);
        await renderPanel(ctx, buildInactivityPanel(data.inactivity, title));
        return;
      }
      if (kind === "clean") {
        await ctx.answerCallbackQuery();
        await renderPanel(ctx, buildInactivityCleanConfirmPanel(title));
        return;
      }
      if (kind === "user") {
        const userId = Number(parts[2]);
        if (!Number.isInteger(userId)) {
          await ctx.answerCallbackQuery("Usuario no válido.");
          return;
        }
        await ctx.answerCallbackQuery();
        const card = await getUserCard(ctx, groupId, userId, title);
        card.inactivityEligible = true;
        await renderPanel(ctx, buildUserCardPanel(card));
        return;
      }
      if (kind === "remove") {
        const userId = Number(parts[2]);
        const result = await removeInactiveUser(ctx, groupId, userId);
        await ctx.answerCallbackQuery(
          result === "removed" ? "✅ Usuario expulsado." : "⛔ No se pudo expulsar.",
        );
        await renderPanel(ctx, buildInactivityPanel((await getGroupData(groupId)).inactivity, title));
        return;
      }
      if (kind === "confirm") {
        const users = await getInactiveUsers(ctx, groupId);
        let removed = 0;
        let skipped = 0;
        let errors = 0;
        for (const user of users) {
          const result = await removeInactiveUser(ctx, groupId, user.id);
          if (result === "removed") removed += 1;
          else if (result === "skipped") skipped += 1;
          else errors += 1;
        }
        await ctx.answerCallbackQuery("✅ Limpieza completada.");
        await renderPanel(
          ctx,
          buildInactivityPanel((await getGroupData(groupId)).inactivity, title),
        );
        console.log(`[INACTIVITY] groupId=${groupId} removed=${removed} skipped=${skipped} errors=${errors}`);
        return;
      }
      if (kind === "cancel") {
        await ctx.answerCallbackQuery();
        await renderPanel(ctx, buildInactivityPanel((await getGroupData(groupId)).inactivity, title));
        return;
      }
    }

    if (parts[0] === "sa") {
      const data = await getGroupData(groupId);
      switch (kind) {
        case "toggle":
          data.antiSpam.enabled = !data.antiSpam.enabled;
          break;
        case "links":
          data.antiSpam.blockLinks = !data.antiSpam.blockLinks;
          break;
        case "repeated":
          data.antiSpam.detectRepeatedMessages = !data.antiSpam.detectRepeatedMessages;
          break;
        case "automated":
          data.antiSpam.detectAutomatedBehavior = !data.antiSpam.detectAutomatedBehavior;
          break;
        case "mentions": {
          data.antiSpam.maxMentionsPerMessage =
            data.antiSpam.maxMentionsPerMessage === 5 ? 10 : 5;
          break;
        }
        default:
          await ctx.answerCallbackQuery("Acción Anti-spam no reconocida.");
          return;
      }
      await saveGroupData(groupId, data);
      await ctx.answerCallbackQuery();
      await renderPanel(ctx, buildAntiSpamPanel(data.antiSpam, ctx.session.user.selectedGroupTitle));
      return;
    }
    if (kind === "illegal") {
      await ctx.answerCallbackQuery();
      await renderPanel(ctx, buildIllegalCategoriesPanel(title));
      return;
    }
    if (kind === "illegal_list") {
      const page = Number(parts[2]);
      if (!Number.isInteger(page) || page < 0) {
        await ctx.answerCallbackQuery("Página no válida.");
        return;
      }
      const data = await getGroupData(groupId);
      await ctx.answerCallbackQuery();
      await renderPanel(
        ctx,
        buildIllegalTermsPanel(data.illegalContent.customTerms, page, title),
      );
      return;
    }
    if (kind === "illegal_delete") {
      const index = Number(parts[2]);
      const page = Number(parts[3]);
      const data = await getGroupData(groupId);
      const term = data.illegalContent.customTerms[index];
      if (!Number.isInteger(index) || !Number.isInteger(page) || page < 0 || !term) {
        await ctx.answerCallbackQuery("Palabra no válida.");
        return;
      }
      ctx.session.user.pendingAction = {
        kind: "illegalDelete",
        groupId,
        index,
        page,
      };
      await ctx.answerCallbackQuery();
      await renderPanel(ctx, buildIllegalConfirmPanel(term, title));
      return;
    }
    if (kind === "illegal_confirm") {
      const pending = ctx.session.user.pendingAction;
      if (!pending || pending.kind !== "illegalDelete" || pending.groupId !== groupId) {
        await ctx.answerCallbackQuery("La operación ya no está disponible.");
        return;
      }
      const data = await getGroupData(groupId);
      if (!data.illegalContent.customTerms[pending.index]) {
        await ctx.answerCallbackQuery("La palabra ya no existe.");
        return;
      }
      data.illegalContent.customTerms.splice(pending.index, 1);
      await saveGroupData(groupId, data);
      ctx.session.user.pendingAction = undefined;
      await ctx.answerCallbackQuery("✅ Palabra eliminada.");
      await renderPanel(
        ctx,
        buildIllegalTermsPanel(data.illegalContent.customTerms, pending.page, title),
      );
      return;
    }
    if (kind === "illegal_config" || kind === "illegal_events") {
      const data = await getGroupData(groupId);
      await ctx.answerCallbackQuery();
      await renderPanel(
        ctx,
        buildIllegalInfoPanel(
          data.illegalContent,
          kind === "illegal_config" ? "config" : "events",
          title,
        ),
      );
      return;
    }
    if (kind === "illegal_toggle") {
      const data = await getGroupData(groupId);
      data.illegalContent.enabled = !data.illegalContent.enabled;
      await saveGroupData(groupId, data);
      await ctx.answerCallbackQuery();
      await renderPanel(ctx, buildIllegalPanel(data.illegalContent, title));
      return;
    }
    if (kind === "illegal_add") {
      ctx.session.user.pendingAction = { kind: "illegalAdd", groupId };
      await ctx.answerCallbackQuery();
      await renderPanel(ctx, buildPromptPanel("✏️ Escribe la palabra personalizada que quieres agregar."));
      return;
    }
    if (kind === "cancel") {
      ctx.session.user.pendingAction = undefined;
      await ctx.answerCallbackQuery();
      await renderPanel(ctx, buildFiltersPanel((await getGroupData(groupId)).promotion, title));
      return;
    }
    if (kind === "toggle") {
      const data = await getGroupData(groupId);
      data.promotion.enabled = !data.promotion.enabled;
      await saveGroupData(groupId, data);
      await ctx.answerCallbackQuery(
        data.promotion.enabled ? "🟢 Filtros activados." : "🔴 Filtros desactivados.",
      );
      await renderPanel(ctx, buildFiltersPanel(data.promotion, title));
      return;
    }
    if (kind === "view") {
      const page = Number(parts[2]);
      if (!Number.isInteger(page) || page < 0) {
        await ctx.answerCallbackQuery("Página no válida.");
        return;
      }
      const data = await getGroupData(groupId);
      await ctx.answerCallbackQuery();
      await renderPanel(ctx, buildFilterListPanel(data.promotion, page, "view", title));
      return;
    }
    if (kind === "deletepage") {
      const page = Number(parts[2]);
      if (!Number.isInteger(page) || page < 0) {
        await ctx.answerCallbackQuery("Página no válida.");
        return;
      }
      const data = await getGroupData(groupId);
      await ctx.answerCallbackQuery();
      await renderPanel(ctx, buildFilterListPanel(data.promotion, page, "delete", title));
      return;
    }
    if (kind === "delete") {
      const index = Number(parts[2]);
      const page = Number(parts[3]);
      const data = await getGroupData(groupId);
      const term = data.promotion.dictionary[index];
      if (
        !Number.isInteger(index) ||
        !Number.isInteger(page) ||
        page < 0 ||
        !term
      ) {
        await ctx.answerCallbackQuery("Filtro no válido.");
        return;
      }
      ctx.session.user.pendingAction = {
        kind: "filterDelete",
        groupId,
        index,
        page,
      };
      await ctx.answerCallbackQuery();
      await renderPanel(ctx, buildFilterConfirmPanel(term, title));
      return;
    }
    if (kind === "confirm") {
      const pending = ctx.session.user.pendingAction;
      if (
        !pending ||
        pending.kind !== "filterDelete" ||
        pending.groupId !== groupId
      ) {
        await ctx.answerCallbackQuery("La operación ya no está disponible.");
        return;
      }
      const data = await getGroupData(groupId);
      if (!data.promotion.dictionary[pending.index]) {
        ctx.session.user.pendingAction = undefined;
        await ctx.answerCallbackQuery("El filtro ya no existe.");
        await renderPanel(ctx, buildFiltersPanel(data.promotion, title));
        return;
      }
      const [removed] = data.promotion.dictionary.splice(pending.index, 1);
      await saveGroupData(groupId, data);
      ctx.session.user.pendingAction = undefined;
      await ctx.answerCallbackQuery("✅ Filtro eliminado.");
      await renderPanel(ctx, buildFilterListPanel(data.promotion, pending.page, "delete", title));
      console.log(`[FILTER] removed groupId=${groupId} term=${JSON.stringify(removed)}`);
      return;
    }
    await ctx.answerCallbackQuery("❌ Acción de filtros no reconocida.");
    return;
  }

  const searchCallbackAnswered = kind === "search";
  if (searchCallbackAnswered) {
    console.log("[USER SEARCH 1] callback received");
    console.log(`[USER SEARCH 2] userId=${ctx.from?.id ?? "unknown"}`);
    console.log(
      `[USER SEARCH 2] selectedGroupId=${ctx.session.user.selectedGroupId ?? "undefined"}`,
    );
    console.log("[USER SEARCH 4] before answerCallbackQuery");
    try {
      await ctx.answerCallbackQuery();
      console.log("[USER SEARCH 5] after answerCallbackQuery");
    } catch (error) {
      console.error("[USER SEARCH] answerCallbackQuery failed", error);
      return;
    }
  }

  if (kind === "cancel") {
    const pending = ctx.session.user.pendingAction;
    ctx.session.user.pendingAction = undefined;
    await ctx.answerCallbackQuery();
    const title = ctx.session.user.selectedGroupTitle;
    if (pending?.kind === "illegalAdd" || pending?.kind === "illegalDelete") {
      await renderPanel(
        ctx,
        buildIllegalPanel((await getGroupData(groupId)).illegalContent, title),
      );
      return;
    }
    if (
      pending?.kind === "filterAdd" ||
      pending?.kind === "filterDelete"
    ) {
      await renderPanel(ctx, buildFiltersPanel((await getGroupData(groupId)).promotion, title));
      return;
    }
    if (
      pending?.kind === "search" &&
      Number.isInteger(pending.groupId)
    ) {
      const data = await getGroupData(pending.groupId);
      const users = Object.values(data.indexedUsers).sort((a, b) =>
        (a.name || a.username || String(a.id)).localeCompare(
          b.name || b.username || String(b.id),
        ),
      );
      await renderPanel(ctx, buildUsersPanel(users, 0, title));
      console.log("[USER SEARCH] pending cleared");
      return;
    }
    await renderPanel(ctx, buildMainPanel(title));
    return;
  }

  const userId = Number(parts[2]);
  const groupTitle = ctx.session.user.selectedGroupTitle;

  switch (kind) {
    case "users": {
      const page = Number(parts[2]);
      if (!Number.isInteger(page) || page < 0) {
        await ctx.answerCallbackQuery("Página no válida.");
        return;
      }
      const data = await getGroupData(groupId);
      const users = Object.values(data.indexedUsers).sort((a, b) =>
        (a.name || a.username || String(a.id)).localeCompare(
          b.name || b.username || String(b.id),
        ),
      );
      console.log(
        `[USERS PANEL] groupId=${groupId} observedUsers=${users.length}`,
      );
      await ctx.answerCallbackQuery();
      await renderPanel(ctx, buildUsersPanel(users, page, groupTitle));
      return;
    }
    case "search": {
      const prompt =
        "🔎 *BUSCAR USUARIO*\n\n" +
        "Envía el @usuario o el ID del usuario que quieres consultar.\n\n" +
        "También puedes usar un usuario que el bot ya haya observado en este grupo.";
      console.log("[USER SEARCH 6] before setting pending");
      ctx.session.user.pendingAction = { kind: "search", groupId };
      console.log("[USER SEARCH 7] pending set kind=search");
      console.log("[USER SEARCH 8] before sendMessage");
      try {
        await ctx.reply(prompt, {
          reply_markup: new InlineKeyboard().text("❌ Cancelar", ModAction.cancel),
          parse_mode: "Markdown",
        });
        console.log("[USER SEARCH 9] after sendMessage");
      } catch (error) {
        ctx.session.user.pendingAction = undefined;
        console.error("[USER SEARCH] sendMessage failed", error);
      }
      return;
    }
    case "warnmenu": {
      const prompt =
        "⚠️ *ADVERTENCIAS*\n\n" +
        "¿Sobre qué usuario quieres actuar? Envía el @usuario o su ID.";
      await beginPick(ctx, groupId, "warn", prompt);
      return;
    }
    case "mutesel": {
      const prompt =
        "🔇 *SILENCIAR*\n\n" +
        "¿A qué usuario quieres silenciar? Envía el @usuario o su ID.";
      await beginPick(ctx, groupId, "mute", prompt);
      return;
    }
    case "unmutesel": {
      const prompt =
        "🔊 *QUITAR SILENCIO*\n\n" +
        "¿A qué usuario quieres quitarle el silencio? Envía el @usuario o su ID.";
      await beginPick(ctx, groupId, "unmute", prompt);
      return;
    }
    case "banprompt": {
      const prompt =
        "🔨 *BANEAR*\n\n" +
        "¿A qué usuario quieres banear? Envía el @usuario o su ID.";
      await beginPick(ctx, groupId, "ban", prompt);
      return;
    }
    case "unbanlist":
      await ctx.answerCallbackQuery();
      await showUnbanList(ctx, groupId, groupTitle);
      return;
    case "clean":
      await ctx.answerCallbackQuery();
      await renderPanel(ctx, buildCleanupPanel());
      return;
    case "deletehelp":
      await ctx.answerCallbackQuery();
      await renderPanel(ctx, buildDeleteHelpPanel());
      return;
    case "info": {
      if (!Number.isInteger(userId)) {
        await ctx.answerCallbackQuery("Usuario no válido.");
        return;
      }
      await renderUserCard(ctx, groupId, userId, groupTitle);
      return;
    }
    case "warn": {
      if (!Number.isInteger(userId)) {
        await ctx.answerCallbackQuery("Usuario no válido.");
        return;
      }
      ctx.session.user.pendingAction = {
        kind: "warnReason",
        userId,
        groupId,
      };
      await ctx.answerCallbackQuery();
      await renderPanel(
        ctx,
        buildPromptPanel(
          "⚠️ *MOTIVO DE LA ADVERTENCIA*\n\nEscribe el motivo de la advertencia.",
        ),
      );
      return;
    }
    case "unwarn": {
      if (!Number.isInteger(userId)) {
        await ctx.answerCallbackQuery("Usuario no válido.");
        return;
      }
      const who = await getTrackedUserName(ctx, groupId, userId);
      const result = await unwarnUser(ctx, groupId, userId, who);
      if (result.ok) {
        await ctx.answerCallbackQuery({ text: "🗑️ Advertencia eliminada.", show_alert: true });
      } else {
        await ctx.answerCallbackQuery({ text: `⛔ ${result.error}`, show_alert: true });
      }
      await renderUserCard(ctx, groupId, userId, groupTitle);
      return;
    }
    case "unwarnall": {
      if (!Number.isInteger(userId)) {
        await ctx.answerCallbackQuery("Usuario no válido.");
        return;
      }
      const who = await getTrackedUserName(ctx, groupId, userId);
      await ctx.answerCallbackQuery();
      await renderPanel(ctx, buildUnwarnAllConfirmPanel({ id: userId, name: who }));
      return;
    }
    case "confirmunwarnall": {
      if (!Number.isInteger(userId)) {
        await ctx.answerCallbackQuery("Usuario no válido.");
        return;
      }
      const who = await getTrackedUserName(ctx, groupId, userId);
      const result = await unwarnAllUser(ctx, groupId, userId, who);
      if (result.ok) {
        await ctx.answerCallbackQuery({ text: "🧹 Todas las advertencias eliminadas.", show_alert: true });
        await renderUserCard(ctx, groupId, userId, groupTitle);
      } else {
        await ctx.answerCallbackQuery({ text: `⛔ ${result.error}`, show_alert: true });
        await renderWarnings(ctx, groupId, userId);
      }
      return;
    }
    case "viewwarnings": {
      if (!Number.isInteger(userId)) {
        await ctx.answerCallbackQuery("Usuario no válido.");
        return;
      }
      const who = await getTrackedUserName(ctx, groupId, userId);
      const data = await getGroupData(groupId);
      const warnings = data.warnings[String(userId)] ?? [];
      await ctx.answerCallbackQuery();
      await renderPanel(
        ctx,
        buildViewWarningsPanel(warnings, data.warnLimit, who ?? `ID ${userId}`, userId),
      );
      return;
    }
    case "mute": {
      if (!Number.isInteger(userId)) {
        await ctx.answerCallbackQuery("Usuario no válido.");
        return;
      }
      const who = await getTrackedUserName(ctx, groupId, userId);
      await ctx.answerCallbackQuery();
      await renderPanel(ctx, buildMuteMenuPanel({ id: userId, name: who }));
      return;
    }
    case "muteat": {
      if (!Number.isInteger(userId)) {
        await ctx.answerCallbackQuery("Usuario no válido.");
        return;
      }
      const minutes = Number(parts[3]);
      if (!Number.isInteger(minutes) || minutes < 1) {
        await ctx.answerCallbackQuery("Duración no válida.");
        return;
      }
      const who = await getTrackedUserName(ctx, groupId, userId);
      const result = await muteUser(ctx, groupId, userId, minutes, who);
      if (result.ok) {
        await ctx.answerCallbackQuery({
          text: `🔇 Silenciado durante ${minutes} min. Telegram restaurará sus permisos al terminar.`,
          show_alert: true,
        });
        await renderUserCard(ctx, groupId, userId, groupTitle);
      } else {
        await ctx.answerCallbackQuery({ text: `⛔ ${result.error}`, show_alert: true });
        await renderPanel(ctx, buildMuteMenuPanel({ id: userId, name: who }));
      }
      return;
    }
    case "mutecustom": {
      if (!Number.isInteger(userId)) {
        await ctx.answerCallbackQuery("Usuario no válido.");
        return;
      }
      ctx.session.user.pendingAction = {
        kind: "muteMinutes",
        userId,
        groupId,
      };
      const prompt =
        "⚙️ *SILENCIO PERSONALIZADO*\n\n" +
        "Envía la duración del silencio en *minutos* (máx. 527040).";
      await ctx.answerCallbackQuery();
      await renderPanel(ctx, buildPromptPanel(prompt));
      return;
    }
    case "unmute": {
      if (!Number.isInteger(userId)) {
        await ctx.answerCallbackQuery("Usuario no válido.");
        return;
      }
      const who = await getTrackedUserName(ctx, groupId, userId);
      const result = await unmuteUser(ctx, groupId, userId, who);
      if (result.ok) {
        await ctx.answerCallbackQuery({ text: "🔊 Silencio eliminado.", show_alert: true });
      } else {
        await ctx.answerCallbackQuery({ text: `⛔ ${result.error}`, show_alert: true });
      }
      await renderUserCard(ctx, groupId, userId, groupTitle);
      return;
    }
    case "banconfirm": {
      if (!Number.isInteger(userId)) {
        await ctx.answerCallbackQuery("Usuario no válido.");
        return;
      }
      const who = await getTrackedUserName(ctx, groupId, userId);
      await ctx.answerCallbackQuery();
      await renderPanel(
        ctx,
        buildBanConfirmPanel({ id: userId, name: who }, groupTitle),
      );
      return;
    }
    case "ban": {
      if (!Number.isInteger(userId)) {
        await ctx.answerCallbackQuery("Usuario no válido.");
        return;
      }
      const who = await getTrackedUserName(ctx, groupId, userId);
      const result = await banUser(ctx, groupId, userId, who);
      if (result.ok) {
        await ctx.answerCallbackQuery({
          text: `🔨 Usuario baneado.`,
          show_alert: true,
        });
      } else {
        await ctx.answerCallbackQuery({ text: `⛔ ${result.error}`, show_alert: true });
      }
      if (result.ok) {
        await renderUserCard(ctx, groupId, userId, groupTitle);
      } else {
        await renderUserCard(ctx, groupId, userId, groupTitle);
      }
      return;
    }
    case "unban": {
      if (!Number.isInteger(userId)) {
        await ctx.answerCallbackQuery("Usuario no válido.");
        return;
      }
      const who = await getTrackedUserName(ctx, groupId, userId);
      const result = await unbanUser(ctx, groupId, userId, who);
      if (result.ok) {
        await ctx.answerCallbackQuery({
          text: "♻️ Desbaneado correctamente.",
          show_alert: true,
        });
      } else {
        await ctx.answerCallbackQuery({ text: `⛔ ${result.error}`, show_alert: true });
      }
      await renderUserCard(ctx, groupId, userId, groupTitle);
      return;
    }
    case "cleanup": {
      const count = Number(parts[2]);
      if (!Number.isInteger(count) || count < 1) {
        await ctx.answerCallbackQuery("Cantidad no válida.");
        return;
      }

      // Se comprueban los permisos del bot antes de intentar borrar.
      const { canDelete } = await getBotRights(ctx, groupId);
      if (!canDelete) {
        await ctx.answerCallbackQuery({
          text: "⛔ El bot no tiene permisos para borrar mensajes en este grupo.",
          show_alert: true,
        });
        await renderPanel(
          ctx,
          buildCleanupPanel(
            "⛔ El bot no tiene permiso para borrar mensajes en este grupo.",
          ),
        );
        return;
      }

      // Se responde antes de la operación larga para no agotar el
      // tiempo del callback de Telegram.
      await ctx.answerCallbackQuery("⏳ Limpiando mensajes…");
      const result = await cleanRecentMessages(ctx, groupId, count);

      await logEvent(ctx, groupId, "CLEAN", {
        result: "ok",
        detail: `${result.deleted}/${result.attempted} mensajes`,
      });

      const note =
        result.attempted === 0
          ? "🤔 El bot no ha registrado mensajes recientes para limpiar."
          : `✅ Se eliminaron *${result.deleted} de ${result.attempted}* mensajes localizados.`;

      await renderPanel(ctx, buildCleanupPanel(note));
      return;
    }
    default:
      await ctx.answerCallbackQuery("❌ Acción no reconocida.");
      return;
  }
});

/**
 * Inicia un asistente de USUARIOS/MODERACIÓN que espera que el
 * administrador escriba el @usuario o ID en el siguiente mensaje.
 */
async function beginPick(
  ctx: MyContext,
  groupId: number,
  action: PickAction,
  prompt: string,
  callbackAlreadyAnswered = false,
): Promise<void> {
  ctx.session.user.pendingAction = { kind: "pick", action, groupId };
  if (action === "search") {
    console.log(
      `[PENDING SEARCH] created userId=${ctx.from?.id ?? "unknown"} groupId=${groupId}`,
    );
  }
  if (!callbackAlreadyAnswered) {
    await ctx.answerCallbackQuery();
  }
  await renderPanel(ctx, buildPromptPanel(prompt));
}

async function renderUserCard(
  ctx: MyContext,
  groupId: number,
  userId: number,
  groupTitle?: string,
): Promise<void> {
  const panel = buildUserCardPanel(await getUserCard(ctx, groupId, userId, groupTitle));
  await renderPanel(ctx, panel);
}

async function renderWarnings(
  ctx: MyContext,
  groupId: number,
  userId: number,
): Promise<void> {
  const data = await getUserCard(ctx, groupId, userId);
  const panel = buildWarningsPanel(data.user, data.warnings, data.warnLimit);
  await renderPanel(ctx, panel);
}

async function showUnbanList(
  ctx: MyContext,
  groupId: number,
  groupTitle?: string,
): Promise<void> {
  const data = await getGroupData(groupId);
  const panel = buildUnbanListPanel(Object.values(data.bannedUsers), groupTitle);
  await renderPanel(ctx, panel);
}

/**
 * Nombre (o @username) de un usuario ya indexado; si no, su ID.
 */
async function getTrackedUserName(
  ctx: MyContext,
  groupId: number,
  userId: number,
): Promise<string | undefined> {
  const data = await getGroupData(groupId);
  return getTrackedUser(data, userId).name ?? getTrackedUser(data, userId).username;
}