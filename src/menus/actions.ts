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
  buildMainPanel,
  buildMuteMenuPanel,
  buildPromptPanel,
  buildUnbanListPanel,
  buildUnwarnAllConfirmPanel,
  buildUserCardPanel,
  buildUsersPanel,
  buildSubmenuPanel,
  buildAutomaticMessagePanel,
  buildViewWarningsPanel,
  FilterAction,
  buildWarningsPanel,
  buildVerifiedUserPanel,
  buildVerifiedUsersPanel,
  buildVerifiedActionConfirmPanel,
  buildVerifiedPermissionConfirmPanel,
  buildRevokedVerifiedUsersPanel,
  verifiedPermissionsSnapshot,
  type VerifiedUserProfileDetails,
  buildVerifiedTitleConfigPanel,
  buildVerifiedTagCandidatesPanel,
  buildVerifiedTagReviewConfirmPanel,
  ModAction,
} from "./panels.js";
import { renderPanel } from "./render.js";
import { automaticMessageScheduler } from "../services/automatic-messages.js";
import type { MyContext, PickAction } from "../types.js";
import {
  getInactiveUsers,
  removeInactiveUser,
} from "../services/inactivity.js";
import {
  delegateSecurityCommand,
  getSecurityWarningHistory,
  getSecurityEventsForUser,
  getSecurityCommandHistoryForUser,
  isCerberoExecutionEnabled,
  ensureCerberoBinding,
  getSecurityConfig,
  isSecurityProtectedUser,
  updateSecurityConfig,
} from "../services/security-commands.js";
import {
  getVerifiedUser,
  getVerifiedUserRecord,
  getVerifiedUsers,
  getRevokedVerifiedUsers,
  updateVerifiedUser,
  revokeVerifiedUser,
  type VerifiedUserPermissions,
} from "../services/verified-users.js";
import {
  markUserVerified,
  recordObservedUser,
  syncVerifiedUserStates,
  unmarkUserVerified,
} from "../services/user-registry.js";
import { syncVerifiedAdministrators } from "../services/verified-title-sync.js";
import {
  addVerifiedUser,
  type VerifiedUser,
} from "../services/verified-users.js";
import {
  decideVerifiedTagReview,
  getVerifiedTagReview,
  listVerifiedTagReviews,
  withVerifiedTagReviewLock,
  type VerifiedTagReview,
} from "../services/verified-tag-reviews.js";
import {
  approveVerifiedTagCandidate,
  type VerifiedTagApprovalResult,
  VerifiedTagApprovalError,
} from "../services/verified-tag-approval.js";
import {
  getVerifiedGroupMember,
  VerifiedUserRegistrationError,
} from "../services/verified-user-registration.js";
import { isSystemOwner } from "../services/system-owner.js";
import { canRevokeVerifiedAdministrator } from "../services/verified-user-policy.js";

const NO_ADMIN_MESSAGE = "⛔ Ya no eres administrador de ese grupo.";
const NO_GROUP_SELECTED_MESSAGE =
  "Primero selecciona el grupo que quieres administrar.";

function configSectionFor(kind: string): string {
  return kind.startsWith("auto_") ? "mensajes" : "config";
}

async function loadVerifiedProfileDetails(
  ctx: MyContext,
  groupId: number,
  user: VerifiedUser,
): Promise<{
  status: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked" | undefined;
  details: VerifiedUserProfileDetails;
}> {
  const details: VerifiedUserProfileDetails = { groupId, historyUnavailable: [] };
  let status:
    | "creator"
    | "administrator"
    | "member"
    | "restricted"
    | "left"
    | "kicked"
    | undefined;
  try {
    const member = await ctx.api.getChatMember(groupId, user.user_id);
    status = member.status;
    details.currentUsername = member.user.username;
  } catch (error) {
    console.error(
      `[VERIFIED] No se pudo cargar membresía userId=${user.user_id} groupId=${groupId}:`,
      error,
    );
    details.historyUnavailable?.push("membresía de Telegram");
  }

  try {
    const group = await getGroupData(groupId);
    const mute = group.mutedUsers[String(user.user_id)];
    details.muteState = mute
      ? mute.until === 0
        ? "Silencio indefinido registrado"
        : mute.until > Math.floor(Date.now() / 1000)
          ? `Silenciada hasta ${new Date(mute.until * 1000).toLocaleString()}`
          : "El registro de silencio está vencido"
      : status === "restricted"
        ? "Restringida en Telegram; sin registro local"
        : "Sin silencio local registrado";
    details.banState = status === undefined
      ? "No confirmado"
      : status === "kicked"
        ? "Baneada en Telegram"
        : status === "left"
          ? "Fuera del grupo (ban no confirmado)"
          : "No baneada según Telegram";
    if (!isCerberoExecutionEnabled()) {
      details.warnings = (group.warnings[String(user.user_id)] ?? []).map((warning) => ({
        date: warning.date,
        reason: warning.reason,
        revokedAt: null,
      }));
    }
  } catch (error) {
    console.error(
      `[VERIFIED] No se pudo cargar estado local userId=${user.user_id} groupId=${groupId}:`,
      error,
    );
    details.historyUnavailable?.push("estado o advertencias locales");
  }

  if (isCerberoExecutionEnabled()) {
    const results = await Promise.allSettled([
      getSecurityWarningHistory(groupId, user.user_id),
      getSecurityEventsForUser(groupId, user.user_id, 5),
      getSecurityCommandHistoryForUser(groupId, user.user_id, 5),
    ]);
    if (results[0].status === "fulfilled") {
      details.warnings = results[0].value.map((warning) => ({
        date: warning.date,
        reason: warning.reason,
        revokedAt: warning.revokedAt,
      }));
    } else {
      console.error("[VERIFIED] No se pudo cargar el historial de advertencias:", results[0].reason);
      details.historyUnavailable?.push("advertencias de CERBERO");
    }
    if (results[1].status === "fulfilled") {
      details.events = results[1].value;
    } else {
      console.error("[VERIFIED] No se pudieron cargar los eventos de seguridad:", results[1].reason);
      details.historyUnavailable?.push("eventos de CERBERO");
    }
    if (results[2].status === "fulfilled") {
      details.commands = results[2].value.map((command) => ({
        action: command.action,
        created_at: command.created_at,
        resultState: command.resultState,
        last_error: command.last_error,
      }));
    } else {
      console.error("[VERIFIED] No se pudieron cargar las órdenes de CERBERO:", results[2].reason);
      details.historyUnavailable?.push("órdenes de CERBERO");
    }
  } else {
    details.historyUnavailable?.push("historial centralizado de eventos y órdenes (CERBERO inactivo)");
  }
  if (details.historyUnavailable?.length === 0) {
    delete details.historyUnavailable;
  }
  return { status, details };
}

/**
 * Acciones reales del panel (Usuarios + Moderación).
 * Cada callback se autoriza contra el chat_id del grupo seleccionado.
 */
export const moderationActions = new Composer<MyContext>();

moderationActions.on("callback_query:data", async (ctx) => {
  const parts = ctx.callbackQuery.data.split(":");
  if (parts[0] !== "ma" && parts[0] !== "fa" && parts[0] !== "sa" && parts[0] !== "ia" && parts[0] !== "vu" && parts[0] !== "cfg" && parts[0] !== "us") {
    return; // Callback ajeno: lo gestiona otro controlador.
  }

  const kind = parts[1];
  if (!kind) {
    return;
  }
  const verifiedAddCallback = parts[0] === "vu" && kind === "add";
  if (verifiedAddCallback) {
    await ctx.answerCallbackQuery();
  }

  const groupId = ctx.session.user.selectedGroupId;
  if (typeof groupId !== "number" || !Number.isInteger(groupId)) {
    if (!verifiedAddCallback) {
      await ctx.answerCallbackQuery(NO_GROUP_SELECTED_MESSAGE);
    }
    return;
  }
  const isAdmin = await isUserAdminOf(ctx, groupId);
  if (!isAdmin) {
    if (!verifiedAddCallback) {
      await ctx.answerCallbackQuery(NO_ADMIN_MESSAGE);
    }
    return;
  }

  if (ctx.from) {
    await recordObservedUser(groupId, ctx.from, { activity: true });
  }

  if (parts[0] === "us") {
    await ctx.answerCallbackQuery();
    if (kind === "scan") {
      try {
        await syncVerifiedAdministrators(ctx.api, groupId);
      } catch (error) {
        console.error(
          `[USERS] No se pudieron sincronizar los estados groupId=${groupId}:`,
          error,
        );
      }
      const count = Object.keys((await getGroupData(groupId)).indexedUsers).length;
      await renderPanel(ctx, buildPromptPanel(`✅ Escaneo completado:\nUsuarios encontrados: ${count}`));
      return;
    }
    try {
      const admins = await ctx.api.getChatAdministrators(groupId);
      for (const admin of admins) {
        if (!admin.user.is_bot) {
          await recordObservedUser(groupId, admin.user, { status: admin.status });
        }
      }
    } catch (error) {
      console.error(`[USERS] No se pudieron actualizar administradores groupId=${groupId}:`, error);
    }
    const verifiedUsers = await getVerifiedUsers(groupId);
    await syncVerifiedUserStates(groupId, verifiedUsers);
    const data = await getGroupData(groupId);
    const verifiedIds = new Set(verifiedUsers.map((user) => user.user_id));
    const now = Math.floor(Date.now() / 1000);
    const users = Object.values(data.indexedUsers).filter((user) => {
      if (kind === "new") return Boolean(user.joinedAt && now - user.joinedAt <= 7 * 86400);
      if (kind === "active") return Boolean(user.lastSeen && now - user.lastSeen <= 7 * 86400);
      if (kind === "inactive") return !user.lastSeen || now - user.lastSeen > 30 * 86400;
      if (kind === "admins") return user.status === "creator" || user.status === "administrator";
      if (kind === "verified") return verifiedIds.has(user.id);
      return true;
    }).sort((a, b) => (a.name || a.username || String(a.id)).localeCompare(b.name || b.username || String(b.id)));
    await renderPanel(ctx, buildUsersPanel(
      users,
      0,
      ctx.session.user.selectedGroupTitle,
      verifiedIds,
    ));
    return;
  }

  if (parts[0] === "cfg") {
    const data = await getGroupData(groupId);
    switch (kind) {
      case "config_view":
        await ctx.answerCallbackQuery();
        await renderPanel(ctx, buildPromptPanel(
          `⚙️ Configuración de ${ctx.session.user.selectedGroupTitle ?? "grupo"}\n\n` +
          `Anti-spam: ${data.antiSpam.enabled ? "activo" : "inactivo"}\n` +
          `Enlaces: ${data.antiSpam.blockLinks ? "bloqueados" : "permitidos"}\n` +
          `Multimedia repetida: ${data.antiSpam.detectAutomatedBehavior ? "activa" : "inactiva"}\n` +
          `Nuevos usuarios: ${data.newUsers.enabled ? "activo" : "inactivo"}\n` +
          `Recurrencia: ${data.promotion.recurrenceMuteMinutes.join(", ")} minutos\n` +
          `Emergencia: ${data.illegalContent.enabled ? "activa" : "inactiva"}\n` +
          `Menciones: ${data.antiSpam.maxMentionsPerMessage}\n` +
          `CERBERO: ${isCerberoExecutionEnabled() ? "habilitado globalmente" : "modo local"}`,
        ));
        return;
      case "verified_view":
        let tagReviews: VerifiedTagReview[];
        try {
          tagReviews = await listVerifiedTagReviews(groupId);
        } catch (error) {
          console.error(`[VERIFIED_TAG] No se pudo cargar configuración groupId=${groupId}:`, error);
          await ctx.answerCallbackQuery({
            text: "No se pudieron cargar las revisiones de etiquetas. Comprueba que la migración 011 esté aplicada.",
            show_alert: true,
          });
          return;
        }
        await ctx.answerCallbackQuery();
        await renderPanel(ctx, buildVerifiedTitleConfigPanel(
          data.verifiedTitles,
          data.autoDetectVerifiedTitles,
          data.autoRemoveVerifiedWhenTitleRemoved,
          ctx.session.user.selectedGroupTitle,
          data.verifiedMemberTags,
          data.verifiedTagSyncEnabled,
          tagReviews.filter((review) => review.status === "pending").length,
        ));
        return;
      case "verified_tags_edit":
        ctx.session.user.pendingAction = { kind: "verifiedMemberTags", groupId };
        ctx.session.user.pendingSince = Date.now();
        await ctx.answerCallbackQuery();
        await renderPanel(ctx, buildPromptPanel(
          "🏷️ Escribe las etiquetas de miembro reconocidas separadas por comas (ejemplo: Verificada). No se aceptan emojis; la detección seguirá apagada hasta que la actives.",
        ));
        return;
      case "verified_tags_toggle":
        if (!data.verifiedTagSyncEnabled && data.verifiedMemberTags.length === 0) {
          await ctx.answerCallbackQuery({
            text: "Configura al menos una etiqueta antes de activar la detección.",
            show_alert: true,
          });
          return;
        }
        if (!data.verifiedTagSyncEnabled) {
          try {
            const botMember = await ctx.api.getChatMember(groupId, ctx.me.id);
            if (botMember.status !== "administrator") {
              await ctx.answerCallbackQuery({
                text: "ZEUS debe ser administrador del grupo para recibir actualizaciones chat_member.",
                show_alert: true,
              });
              return;
            }
          } catch (error) {
            console.error(`[VERIFIED_TAG] No se pudo verificar el estado del bot groupId=${groupId}:`, error);
            await ctx.answerCallbackQuery({
              text: "No se pudo confirmar que ZEUS sea administrador. La detección no se activó.",
              show_alert: true,
            });
            return;
          }
        }
        let currentTagReviews: VerifiedTagReview[];
        try {
          currentTagReviews = await listVerifiedTagReviews(groupId);
        } catch (error) {
          console.error(`[VERIFIED_TAG] No se pudieron cargar revisiones groupId=${groupId}:`, error);
          await ctx.answerCallbackQuery({
            text: "No se pudieron cargar las revisiones. Comprueba que la migración 011 esté aplicada.",
            show_alert: true,
          });
          return;
        }
        data.verifiedTagSyncEnabled = !data.verifiedTagSyncEnabled;
        await saveGroupData(groupId, data);
        await ctx.answerCallbackQuery(
          data.verifiedTagSyncEnabled
            ? "Detección de etiquetas activada para este grupo."
            : "Detección de etiquetas desactivada para este grupo.",
        );
        await renderPanel(ctx, buildVerifiedTitleConfigPanel(
          data.verifiedTitles,
          data.autoDetectVerifiedTitles,
          data.autoRemoveVerifiedWhenTitleRemoved,
          ctx.session.user.selectedGroupTitle,
          data.verifiedMemberTags,
          data.verifiedTagSyncEnabled,
          currentTagReviews.filter((review) => review.status === "pending").length,
        ));
        return;
      case "verified_titles_edit":
        ctx.session.user.pendingAction = { kind: "verifiedTitles", groupId };
        await ctx.answerCallbackQuery();
        await renderPanel(ctx, buildPromptPanel("✏️ Escribe los títulos separados por comas (ejemplo: Verificada, Modelo, Oficial)."));
        return;
      case "verified_detect_toggle":
        data.autoDetectVerifiedTitles = !data.autoDetectVerifiedTitles;
        await saveGroupData(groupId, data);
        await ctx.answerCallbackQuery(data.autoDetectVerifiedTitles ? "✅ Detección activada." : "⛔ Detección desactivada.");
        break;
      case "verified_remove_toggle":
        data.autoRemoveVerifiedWhenTitleRemoved = !data.autoRemoveVerifiedWhenTitleRemoved;
        await saveGroupData(groupId, data);
        await ctx.answerCallbackQuery(data.autoRemoveVerifiedWhenTitleRemoved ? "✅ Retirada activada." : "⛔ Retirada desactivada.");
        break;
      case "verified_sync":
        try {
          const sync = await syncVerifiedAdministrators(ctx.api, groupId);
          await ctx.answerCallbackQuery(
            `✅ Sincronizadas ${sync.administratorsSynchronized} administradoras y ${sync.verifiedUsersSynchronized} verificaciones activas.`,
          );
        } catch (error) {
          console.error(`[VERIFIED_SYNC] Error en sincronización manual groupId=${groupId}:`, error);
          await ctx.answerCallbackQuery("⛔ No se pudo sincronizar.");
        }
        break;
      case "mentions_edit":
        ctx.session.user.pendingAction = { kind: "configMentions", groupId };
        await ctx.answerCallbackQuery();
        await renderPanel(ctx, buildPromptPanel("💬 Escribe el máximo de menciones permitidas por mensaje (0-50)."));
        return;
      case "antispam_toggle":
        data.antiSpam.enabled = !data.antiSpam.enabled;
        await saveGroupData(groupId, data);
        await ctx.answerCallbackQuery("✅ Configuración actualizada.");
        break;
      case "links_toggle":
        data.antiSpam.blockLinks = !data.antiSpam.blockLinks;
        await saveGroupData(groupId, data);
        await ctx.answerCallbackQuery("✅ Configuración actualizada.");
        break;
      case "multimedia_toggle":
        data.antiSpam.detectAutomatedBehavior = !data.antiSpam.detectAutomatedBehavior;
        await saveGroupData(groupId, data);
        await ctx.answerCallbackQuery("✅ Configuración multimedia actualizada.");
        break;
      case "new_users_toggle":
        data.newUsers.enabled = !data.newUsers.enabled;
        await saveGroupData(groupId, data);
        await ctx.answerCallbackQuery("✅ Configuración de nuevos usuarios actualizada.");
        break;
      case "recurrence_cycle": {
        const choices = [15, 60, 240, 1440];
        const current = data.promotion.recurrenceMuteMinutes;
        const index = choices.findIndex((value) => value === current[0]);
        data.promotion.recurrenceMuteMinutes = choices.slice(
          (index + 1 + choices.length) % choices.length,
        );
        await saveGroupData(groupId, data);
        await ctx.answerCallbackQuery(
          `✅ Recurrencia: ${data.promotion.recurrenceMuteMinutes.join(", ")} min.`,
        );
        break;
      }
      case "emergency_toggle":
        data.illegalContent.enabled = !data.illegalContent.enabled;
        await saveGroupData(groupId, data);
        await ctx.answerCallbackQuery("✅ Configuración de emergencia actualizada.");
        break;
      case "cerbero_sync":
        try {
          await ensureCerberoBinding(groupId);
          await ctx.answerCallbackQuery("✅ Configuración Cerbero sincronizada.");
        } catch {
          await ctx.answerCallbackQuery("⛔ No se pudo sincronizar Cerbero para este grupo.");
        }
        break;
      case "cerbero_toggle":
      case "cerbero_media_toggle":
        try {
          const securityConfig = await getSecurityConfig(groupId);
          const field = kind === "cerbero_toggle" ? "enabled" : "media_protection";
          await updateSecurityConfig(groupId, {
            [field]: !securityConfig[field],
          }, String(ctx.update.update_id));
          await ctx.answerCallbackQuery(
            "⏳ Configuración enviada a Cerbero; pendiente de ejecución.",
          );
        } catch {
          await ctx.answerCallbackQuery("⛔ No se pudo actualizar la configuración Cerbero.");
        }
        break;
      case "auto_view":
        await ctx.answerCallbackQuery();
        await renderPanel(ctx, buildAutomaticMessagePanel(data.automaticMessage, ctx.session.user.selectedGroupTitle));
        return;
      case "auto_edit":
        ctx.session.user.pendingAction = { kind: "automaticMessage", groupId };
        await ctx.answerCallbackQuery();
        await renderPanel(ctx, buildPromptPanel("📢 Escribe el mensaje automático. Se usará una frecuencia de 60 minutos."));
        return;
      case "auto_toggle":
        if (!data.automaticMessage) {
          await ctx.answerCallbackQuery("Primero crea un mensaje automático.");
          return;
        }
        data.automaticMessage.enabled = !data.automaticMessage.enabled;
        await saveGroupData(groupId, data);
        await automaticMessageScheduler.refreshGroup(groupId);
        await ctx.answerCallbackQuery("✅ Estado actualizado.");
        break;
      case "auto_frequency":
        if (!data.automaticMessage) {
          await ctx.answerCallbackQuery("Primero crea un mensaje automático.");
          return;
        }
        ctx.session.user.pendingAction = { kind: "automaticFrequency", groupId };
        await ctx.answerCallbackQuery();
        await renderPanel(ctx, buildPromptPanel("⏱️ Escribe la frecuencia en minutos (mínimo 1)."));
        return;
      case "auto_delete":
        if (data.automaticMessage?.lastMessageId) {
          try {
            await ctx.api.deleteMessage(groupId, data.automaticMessage.lastMessageId);
          } catch {
            // El mensaje puede haber sido eliminado manualmente.
          }
        }
        data.automaticMessage = undefined;
        await saveGroupData(groupId, data);
        await automaticMessageScheduler.refreshGroup(groupId);
        await ctx.answerCallbackQuery("✅ Mensaje automático eliminado.");
        break;
      case "auto_send":
        {
          const result = await automaticMessageScheduler.sendNow(groupId);
          await ctx.answerCallbackQuery(
            result.ok
              ? "✅ Mensaje enviado."
              : result.error instanceof Error
                ? result.error.message
                : "No se pudo enviar.",
          );
        }
        break;
      default:
        await ctx.answerCallbackQuery("Acción no reconocida.");
        return;
    }
    const section = kind.startsWith("auto_")
          ? buildAutomaticMessagePanel(data.automaticMessage, ctx.session.user.selectedGroupTitle)
          : buildSubmenuPanel(configSectionFor(kind), ctx.session.user.selectedGroupTitle) ??
            buildMainPanel(ctx.session.user.selectedGroupTitle);
    await renderPanel(ctx, section);
    return;
  }

  if (parts[0] === "vu") {
    const groupTitle = ctx.session.user.selectedGroupTitle;
    if (kind === "candidates") {
      const page = Number(parts[2] ?? 0);
      if (!Number.isInteger(page) || page < 0) {
        await ctx.answerCallbackQuery("Página no válida.");
        return;
      }
      let reviews: VerifiedTagReview[];
      try {
        reviews = await listVerifiedTagReviews(groupId);
      } catch (error) {
        console.error(`[VERIFIED_TAG] No se pudieron cargar candidatas groupId=${groupId}:`, error);
        await ctx.answerCallbackQuery({
          text: "No se pudieron cargar las candidatas. Comprueba que la migración 011 esté aplicada.",
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      await renderPanel(
        ctx,
        buildVerifiedTagCandidatesPanel(reviews, page, groupTitle),
      );
      return;
    }
    if (kind === "review") {
      const decision = parts[2];
      const userId = Number(parts[3]);
      if (
        (decision !== "approve" && decision !== "reject") ||
        !Number.isSafeInteger(userId) ||
        userId <= 0
      ) {
        await ctx.answerCallbackQuery("Acción o usuario no válido.");
        return;
      }
      let review: VerifiedTagReview | undefined;
      try {
        review = await getVerifiedTagReview(groupId, userId);
      } catch (error) {
        console.error(`[VERIFIED_TAG] No se pudo preparar revisión groupId=${groupId} userId=${userId}:`, error);
        await ctx.answerCallbackQuery({
          text: "No se pudo cargar la revisión.",
          show_alert: true,
        });
        return;
      }
      const reviewable =
        review?.status === "pending" ||
        (decision === "approve" &&
          (review?.status === "revoked_tag" ||
            review?.status === "approving"));
      if (!review || !reviewable) {
        await ctx.answerCallbackQuery({
          text: "La candidata ya no está pendiente de revisión.",
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      await renderPanel(
        ctx,
        buildVerifiedTagReviewConfirmPanel(review, decision, groupTitle),
      );
      return;
    }
    if (kind === "review-confirm") {
      const decision = parts[2];
      const userId = Number(parts[3]);
      if (
        (decision !== "approve" && decision !== "reject") ||
        !Number.isSafeInteger(userId) ||
        userId <= 0 ||
        !ctx.from
      ) {
        await ctx.answerCallbackQuery({
          text: "Acción, usuario o administrador no válido.",
          show_alert: true,
        });
        return;
      }
      const actorUserId = ctx.from.id;

      if (decision === "reject") {
        try {
          const rejected = await withVerifiedTagReviewLock(
            groupId,
            userId,
            async () => {
              if (!(await isUserAdminOf(ctx, groupId))) {
                throw new Error("UNAUTHORIZED");
              }
              const current = await getVerifiedTagReview(groupId, userId);
              if (!current || current.status !== "pending") return undefined;
              return decideVerifiedTagReview({
                groupId,
                userId,
                decision: "rejected",
                actorUserId,
              });
            },
          );
          if (!rejected) {
            await ctx.answerCallbackQuery({
              text: "La candidata ya fue procesada.",
              show_alert: true,
            });
            return;
          }
          await ctx.answerCallbackQuery(
            "Candidata rechazada; no se modificó la verificación.",
          );
          try {
            const reviews = await listVerifiedTagReviews(groupId);
            await renderPanel(
              ctx,
              buildVerifiedTagCandidatesPanel(reviews, 0, groupTitle),
            );
          } catch (error) {
            console.error(`[VERIFIED_TAG] No se pudo actualizar el panel groupId=${groupId}:`, error);
            await ctx.reply("La decisión se guardó, pero no se pudo actualizar el panel.");
          }
        } catch (error) {
          const unauthorized =
            error instanceof Error && error.message === "UNAUTHORIZED";
          console.error(`[VERIFIED_TAG] No se pudo rechazar candidata groupId=${groupId} userId=${userId}:`, error);
          await ctx.answerCallbackQuery({
            text: unauthorized
              ? NO_ADMIN_MESSAGE
              : "No se pudo guardar el rechazo. Comprueba el estado antes de reintentar.",
            show_alert: true,
          });
        }
        return;
      }

      let result: VerifiedTagApprovalResult;
      try {
        const groupData = await getGroupData(groupId);
        result = await approveVerifiedTagCandidate({
          api: ctx.api,
          groupId,
          userId,
          actorUserId,
          recognizedTags: groupData.verifiedMemberTags,
          authorize: () => isUserAdminOf(ctx, groupId),
        });
      } catch (error) {
        console.error(`[VERIFIED_TAG] Falló aprobación groupId=${groupId} userId=${userId}:`, error);
        await ctx.answerCallbackQuery({
          text:
            error instanceof VerifiedTagApprovalError
              ? error.message
              : "No se pudo completar la revisión. Comprueba el estado antes de reintentar.",
          show_alert: true,
        });
        return;
      }
      if (result.status === "uncertain") {
        await ctx.answerCallbackQuery({
          text: result.message,
          show_alert: true,
        });
        return;
      }
      if (result.status === "already-verified") {
        let reviews: VerifiedTagReview[];
        try {
          reviews = await listVerifiedTagReviews(groupId);
        } catch (error) {
          console.error(`[VERIFIED_TAG] No se pudo recargar candidatas groupId=${groupId}:`, error);
          await ctx.answerCallbackQuery({
            text: "La verificación existente no se modificó, pero no se pudo cargar la lista.",
            show_alert: true,
          });
          return;
        }
        await ctx.answerCallbackQuery({
          text: "La persona ya está verificada; no se cambiaron sus permisos.",
          show_alert: true,
        });
        try {
          await renderPanel(
            ctx,
            buildVerifiedTagCandidatesPanel(reviews, 0, groupTitle),
          );
        } catch (error) {
          console.error(`[VERIFIED_TAG] No se pudo presentar candidatas groupId=${groupId}:`, error);
          await ctx.reply("La revisión se completó, pero no se pudo actualizar el panel.");
        }
        return;
      }
      await ctx.answerCallbackQuery(
        "Candidata aprobada y verificación guardada mediante el registro de ZEUS.",
      );
      try {
        await renderPanel(
          ctx,
          buildVerifiedUserPanel(result.user, groupTitle, "member"),
        );
      } catch (error) {
        console.error(`[VERIFIED_TAG] No se pudo presentar verificación groupId=${groupId} userId=${userId}:`, error);
        await ctx.reply("La verificación quedó guardada, pero no se pudo actualizar el panel.");
      }
      return;
    }
    if (kind === "add") {
      ctx.session.user.pendingAction = { kind: "verifiedAdd", groupId };
      ctx.session.user.pendingSince = Date.now();
      await renderPanel(
        ctx,
        buildPromptPanel(
          "👑 Escribe el @username exacto si ZEUS ya observó a esa persona en este grupo, o su Telegram user ID. No uses el nombre visible.",
        ),
      );
      return;
    }
    if (kind === "list") {
      await ctx.answerCallbackQuery();
      const users = await getVerifiedUsers(groupId);
      await syncVerifiedUserStates(groupId, users);
      await renderPanel(ctx, buildVerifiedUsersPanel(users, groupTitle));
      return;
    }
    if (kind === "revoked-list") {
      try {
        const page = Number(parts[2] ?? 0);
        if (!Number.isInteger(page) || page < 0) {
          await ctx.answerCallbackQuery("Página no válida.");
          return;
        }
        const users = await getRevokedVerifiedUsers(groupId);
        await ctx.answerCallbackQuery();
        await renderPanel(ctx, buildRevokedVerifiedUsersPanel(users, groupTitle, page));
      } catch (error) {
        console.error(`[VERIFIED] No se pudieron cargar los revocados groupId=${groupId}:`, error);
        await ctx.answerCallbackQuery({
          text: "No se pudieron cargar los registros revocados.",
          show_alert: true,
        });
      }
      return;
    }
    if (kind === "cancel") {
      const pending = ctx.session.user.pendingAction;
      if (pending?.kind === "verifiedAddConfirm" && pending.groupId === groupId) {
        ctx.session.user.pendingAction = undefined;
        ctx.session.user.pendingSince = undefined;
      }
      await ctx.answerCallbackQuery("Operación cancelada.");
      await renderPanel(ctx, buildVerifiedUsersPanel(await getVerifiedUsers(groupId), groupTitle));
      return;
    }
    if (kind === "confirm") {
      const userId = Number(parts[2]);
      const pending = ctx.session.user.pendingAction;
      if (
        !Number.isSafeInteger(userId) ||
        userId <= 0 ||
        pending?.kind !== "verifiedAddConfirm" ||
        pending.groupId !== groupId ||
        pending.userId !== userId
      ) {
        await ctx.answerCallbackQuery({
          text: "La confirmación expiró. Vuelve a iniciar el alta.",
          show_alert: true,
        });
        return;
      }
      let member;
      try {
        member = await getVerifiedGroupMember(ctx.api, groupId, userId);
      } catch (error) {
        if (error instanceof VerifiedUserRegistrationError) {
          if (error.code === "TELEGRAM_ERROR") {
            console.error(
              `[VERIFIED] Telegram no pudo validar userId=${userId}:`,
              error.cause,
            );
          }
          await ctx.answerCallbackQuery({
            text: error.message,
            show_alert: true,
          });
          return;
        }
        console.error(`[VERIFIED] Error inesperado validando userId=${userId}:`, error);
        await ctx.answerCallbackQuery({
          text: "No se pudo validar la identidad en Telegram. No se guardó el alta.",
          show_alert: true,
        });
        return;
      }

      const displayName = [member.user.first_name, member.user.last_name]
        .filter(Boolean)
        .join(" ");
      let synchronizedUser: VerifiedUser;
      let wasAlreadyVerified = false;
      try {
        const existing = await getVerifiedUser(groupId, userId);
        wasAlreadyVerified = Boolean(existing);
        synchronizedUser = existing
          ? await updateVerifiedUser(groupId, userId, {
              username: member.user.username,
              displayName,
            })
          : await addVerifiedUser({
              groupId,
              userId,
              username: member.user.username ?? pending.username,
              displayName: displayName || pending.displayName,
              createdBy: ctx.from?.id ?? 0,
            });
      } catch (error) {
        console.error(`[VERIFIED] No se pudo guardar en Supabase userId=${userId}:`, error);
        await ctx.answerCallbackQuery({
          text: "No se pudo guardar la verificación en Supabase. No se confirmó el alta; puedes volver a intentarlo.",
          show_alert: true,
        });
        return;
      }

      try {
        await markUserVerified(
          groupId,
          userId,
          member.user.username ?? pending.username,
          displayName || pending.displayName,
        );
      } catch (error) {
        console.error(
          `[VERIFIED] Guardado en Supabase, pero falló la sincronización local userId=${userId}:`,
          error,
        );
        await ctx.answerCallbackQuery({
          text: "Se guardó en Supabase, pero falló la sincronización local. Vuelve a confirmar para reintentar.",
          show_alert: true,
        });
        return;
      }

      ctx.session.user.pendingAction = undefined;
      ctx.session.user.pendingSince = undefined;
      await ctx.answerCallbackQuery(
        wasAlreadyVerified
          ? "La verificación quedó guardada y sincronizada."
          : "Usuaria añadida como verificada.",
      );
      try {
        await renderPanel(
          ctx,
          buildVerifiedUserPanel(synchronizedUser, groupTitle, member.status),
        );
      } catch (error) {
        console.error(
          `[VERIFIED] El alta quedó guardada, pero no se pudo actualizar el panel userId=${userId}:`,
          error,
        );
      }
      return;
    }
    if (kind === "view") {
      const userId = Number(parts[2]);
      if (!Number.isSafeInteger(userId) || userId <= 0) {
        await ctx.answerCallbackQuery("Usuario no válido.");
        return;
      }
      const user = await getVerifiedUser(groupId, userId);
      if (!user) {
        await ctx.answerCallbackQuery("Verificada no encontrada.");
        return;
      }
      const { status, details } = await loadVerifiedProfileDetails(ctx, groupId, user);
      await ctx.answerCallbackQuery();
      await renderPanel(ctx, buildVerifiedUserPanel(user, groupTitle, status, details));
      return;
    }
    if (kind === "revoke-confirm" || kind === "revoke") {
      const userId = Number(parts[2]);
      const user = Number.isSafeInteger(userId) && userId > 0
        ? await getVerifiedUser(groupId, userId)
        : undefined;
      if (!user) {
        await ctx.answerCallbackQuery({ text: "La verificación ya no está activa.", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery();
      await renderPanel(ctx, buildVerifiedActionConfirmPanel(user, "revoke", groupTitle));
      return;
    }
    if (kind === "revoke-apply") {
      const userId = Number(parts[2]);
      try {
        if (!Number.isSafeInteger(userId) || userId <= 0) {
          await ctx.answerCallbackQuery({ text: "Usuario no válido.", show_alert: true });
          return;
        }
        const user = await getVerifiedUser(groupId, userId);
        if (!user) {
          await ctx.answerCallbackQuery({
            text: "La verificación ya no está activa.",
            show_alert: true,
          });
          return;
        }
        await revokeVerifiedUser(groupId, userId);
        await unmarkUserVerified(groupId, userId);
        await ctx.answerCallbackQuery({
          text: "Verificación revocada. No se modificaron sanciones ni la membresía.",
          show_alert: true,
        });
        await renderPanel(ctx, buildVerifiedUsersPanel(await getVerifiedUsers(groupId), groupTitle));
      } catch (error) {
        console.error(`[VERIFIED] No se pudo revocar userId=${userId}:`, error);
        await ctx.answerCallbackQuery({
          text: "No se pudo revocar la verificación.",
          show_alert: true,
        });
      }
      return;
    }
    if (kind === "reactivate-confirm" || kind === "reactivate-apply") {
      const userId = Number(parts[2]);
      if (!Number.isSafeInteger(userId) || userId <= 0) {
        await ctx.answerCallbackQuery({ text: "Usuario no válido.", show_alert: true });
        return;
      }
      try {
        const user = await getVerifiedUserRecord(groupId, userId);
        if (!user || (user.verified && !user.revoked_at)) {
          await ctx.answerCallbackQuery({
            text: user ? "El registro ya está activo." : "Registro revocado no encontrado.",
            show_alert: true,
          });
          return;
        }
        if (kind === "reactivate-confirm") {
          await ctx.answerCallbackQuery();
          await renderPanel(ctx, buildVerifiedActionConfirmPanel(user, "reactivate", groupTitle));
          return;
        }
        const expectedSnapshot = parts[3];
        if (!expectedSnapshot || verifiedPermissionsSnapshot(user.permissions) !== expectedSnapshot) {
          await ctx.answerCallbackQuery({
            text: "Los permisos del registro cambiaron. Revisa y confirma de nuevo.",
            show_alert: true,
          });
          await renderPanel(ctx, buildVerifiedActionConfirmPanel(user, "reactivate", groupTitle));
          return;
        }
        const member = await getVerifiedGroupMember(ctx.api, groupId, userId);
        await addVerifiedUser({
          groupId,
          userId,
          username: member.user.username ?? user.username ?? undefined,
          displayName:
            [member.user.first_name, member.user.last_name].filter(Boolean).join(" ") ||
            user.display_name ||
            undefined,
          createdBy: ctx.from?.id ?? 0,
          permissions: user.permissions,
        });
        try {
          await markUserVerified(
            groupId,
            userId,
            member.user.username ?? user.username ?? undefined,
            [member.user.first_name, member.user.last_name].filter(Boolean).join(" ") ||
              user.display_name ||
              undefined,
          );
        } catch (syncError) {
          console.error(`[VERIFIED] Reactivada en Supabase sin sync local userId=${userId}:`, syncError);
          await ctx.answerCallbackQuery({
            text: "La verificación se reactivó en Supabase, pero falló la sincronización local.",
            show_alert: true,
          });
          return;
        }
        await ctx.answerCallbackQuery({
          text: "Verificación reactivada con los permisos confirmados. Las sanciones no se alteraron.",
          show_alert: true,
        });
        const activeUser = await getVerifiedUser(groupId, userId);
        if (!activeUser) throw new Error("La verificación no apareció activa después de reactivarla.");
        const { status, details } = await loadVerifiedProfileDetails(ctx, groupId, activeUser);
        await renderPanel(
          ctx,
          buildVerifiedUserPanel(activeUser, groupTitle, status, details),
        );
      } catch (error) {
        console.error(`[VERIFIED] No se pudo reactivar userId=${userId}:`, error);
        await ctx.answerCallbackQuery({
          text: "No se pudo reactivar. Comprueba el estado antes de volver a intentarlo.",
          show_alert: true,
        });
      }
      return;
    }
    if (kind === "revoke-permissions") {
      const userId = Number(parts[2]);
      try {
        if (!Number.isSafeInteger(userId) || userId <= 0) {
          await ctx.answerCallbackQuery({ text: "Usuario no válido.", show_alert: true });
          return;
        }
        const verified = await getVerifiedUser(groupId, userId);
        if (!verified) {
          await ctx.answerCallbackQuery({
            text: "La usuaria ya no está verificada.",
            show_alert: true,
          });
          return;
        }

        const member = await ctx.api.getChatMember(groupId, userId);
        if (member.status === "creator") {
          await ctx.answerCallbackQuery({
            text: "No se pueden revocar permisos al propietario del grupo.",
            show_alert: true,
          });
          return;
        }
        if (member.user.is_bot || member.user.id === ctx.me.id) {
          await ctx.answerCallbackQuery({
            text: "No se pueden modificar permisos de bots.",
            show_alert: true,
          });
          return;
        }
        if (member.status !== "administrator") {
          await ctx.answerCallbackQuery({
            text: "La usuaria ya no es administradora. Su verificación se conserva.",
            show_alert: true,
          });
          return;
        }

        const protectedUser =
          (await isSystemOwner(userId)) ||
          (await isSecurityProtectedUser(groupId, userId));
        const botMember = await ctx.api.getChatMember(groupId, ctx.me.id);
        const botCanPromote =
          botMember.status === "administrator" &&
          "can_promote_members" in botMember &&
          botMember.can_promote_members;
        if (
          !canRevokeVerifiedAdministrator({
            status: member.status,
            isBot: member.user.is_bot,
            isVerified: true,
            isProtected: protectedUser,
            botCanPromote,
          })
        ) {
          await ctx.answerCallbackQuery({
            text: protectedUser
              ? "La usuaria está protegida y no se modificarán sus permisos."
              : "ZEUS no tiene permisos suficientes para retirar permisos administrativos.",
            show_alert: true,
          });
          return;
        }

        await ctx.api.promoteChatMember(groupId, userId, {
          is_anonymous: false,
          can_manage_chat: false,
          can_delete_messages: false,
          can_manage_video_chats: false,
          can_restrict_members: false,
          can_promote_members: false,
          can_change_info: false,
          can_invite_users: false,
          can_post_stories: false,
          can_edit_stories: false,
          can_delete_stories: false,
          can_post_messages: false,
          can_edit_messages: false,
          can_pin_messages: false,
          can_manage_topics: false,
        });
        const updatedMember = await ctx.api.getChatMember(groupId, userId);
        if (updatedMember.status === "administrator" || updatedMember.status === "creator") {
          throw new Error("Telegram mantuvo el estado administrativo del usuario.");
        }
        await recordObservedUser(groupId, updatedMember.user, {
          status: updatedMember.status,
        });
        await syncVerifiedUserStates(groupId, await getVerifiedUsers(groupId));
        await ctx.answerCallbackQuery({
          text: "Permisos administrativos retirados. La usuaria sigue verificada.",
          show_alert: true,
        });
        await renderPanel(
          ctx,
          buildVerifiedUserPanel(verified, groupTitle, updatedMember.status),
        );
      } catch (error) {
        console.error(`[VERIFIED] No se pudieron revocar permisos userId=${userId}:`, error);
        await ctx.answerCallbackQuery({
          text: "No se pudieron retirar los permisos; la verificación no fue modificada.",
          show_alert: true,
        });
      }
      return;
    }
    if (kind === "toggle") {
      const userId = Number(parts[2]);
      const permission = parts[3] as keyof VerifiedUserPermissions;
      const user = await getVerifiedUser(groupId, userId);
      if (
        !user ||
        !(permission in user.permissions) ||
        permission === "can_send_links" ||
        permission === "bypass_promotion_filter"
      ) {
        await ctx.answerCallbackQuery("Verificada no encontrada.");
        return;
      }
      const desired = !user.permissions[permission];
      await ctx.answerCallbackQuery();
      await renderPanel(
        ctx,
        buildVerifiedPermissionConfirmPanel(user, permission, desired, groupTitle),
      );
      return;
    }
    if (kind === "permission-apply") {
      const userId = Number(parts[2]);
      const permission = parts[3] as keyof VerifiedUserPermissions;
      const valueFlag = parts[4];
      const previousValueFlag = parts[5];
      const allowedPermissions: Array<keyof VerifiedUserPermissions> = [
        "can_post",
        "can_send_media",
        "bypass_antispam",
        "bypass_illegal_filter",
        "bypass_automatic_deletion",
      ];
      if (
        !Number.isSafeInteger(userId) ||
        userId <= 0 ||
        !allowedPermissions.includes(permission) ||
        (valueFlag !== "0" && valueFlag !== "1") ||
        (previousValueFlag !== "0" && previousValueFlag !== "1")
      ) {
        await ctx.answerCallbackQuery({ text: "Cambio de permiso no válido.", show_alert: true });
        return;
      }
      const value = valueFlag === "1";
      const user = await getVerifiedUser(groupId, userId);
      if (!user) {
        await ctx.answerCallbackQuery({ text: "La verificación ya no está activa.", show_alert: true });
        return;
      }
      if (user.permissions[permission] !== (previousValueFlag === "1")) {
        await ctx.answerCallbackQuery({
          text: "El permiso cambió desde la confirmación. Revisa el nuevo estado.",
          show_alert: true,
        });
        await renderPanel(
          ctx,
          buildVerifiedPermissionConfirmPanel(user, permission, value, groupTitle),
        );
        return;
      }
      try {
        if (user.permissions[permission] === value) {
          await ctx.answerCallbackQuery({
            text: "El permiso ya tiene ese estado; no se cambió nada.",
            show_alert: true,
          });
        } else {
          await updateVerifiedUser(groupId, userId, {
            permissions: { [permission]: value },
          });
          await ctx.answerCallbackQuery({
            text: "Permiso actualizado explícitamente.",
            show_alert: true,
          });
        }
        const updated = await getVerifiedUser(groupId, userId);
        if (!updated) throw new Error("La verificación no está activa tras actualizar el permiso.");
        const { status, details } = await loadVerifiedProfileDetails(ctx, groupId, updated);
        await renderPanel(ctx, buildVerifiedUserPanel(updated, groupTitle, status, details));
      } catch (error) {
        console.error(`[VERIFIED] No se pudo actualizar permiso userId=${userId}:`, error);
        await ctx.answerCallbackQuery({
          text: "No se pudo guardar el permiso. Comprueba su estado antes de reintentar.",
          show_alert: true,
        });
      }
      return;
    }
    if (kind === "kick-confirm" || kind === "kick-apply") {
      const userId = Number(parts[2]);
      const user = Number.isSafeInteger(userId) && userId > 0
        ? await getVerifiedUserRecord(groupId, userId)
        : undefined;
      if (!user) {
        await ctx.answerCallbackQuery({ text: "Usuario no válido.", show_alert: true });
        return;
      }
      if (kind === "kick-confirm") {
        await ctx.answerCallbackQuery();
        await renderPanel(ctx, buildVerifiedActionConfirmPanel(user, "kick", groupTitle));
        return;
      }
      const who = user.display_name ?? user.username ?? String(userId);
      if (isCerberoExecutionEnabled()) {
        const queued = await delegateSecurityCommand({
          groupId,
          action: "KICK_USER",
          targetUserId: userId,
          idempotencyKey: String(ctx.update.update_id),
          payload: { requester_id: ctx.from?.id, requester_name: ctx.from?.first_name },
        });
        await ctx.answerCallbackQuery({
          text: queued.ok
            ? `⏳ Orden de expulsión enviada a Cerbero (${queued.commandId}); aún no está confirmada.`
            : `⛔ ${queued.error}`,
          show_alert: true,
        });
        return;
      }
      const banned = await banUser(ctx, groupId, userId, who);
      if (!banned.ok) {
        await ctx.answerCallbackQuery({ text: banned.error, show_alert: true });
        return;
      }
      const unbanned = await unbanUser(ctx, groupId, userId, who);
      if (!unbanned.ok) {
        await ctx.answerCallbackQuery({
          text: "El usuario fue retirado, pero el desbaneo falló y sigue baneado. Revisa su estado.",
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery({
        text: "Usuario expulsado; el desbaneo posterior permite que vuelva a unirse.",
        show_alert: true,
      });
      const refreshed = await getVerifiedUserRecord(groupId, userId);
      if (refreshed) {
        const { status, details } = await loadVerifiedProfileDetails(ctx, groupId, refreshed);
        await renderPanel(ctx, buildVerifiedUserPanel(refreshed, groupTitle, status, details));
      }
      return;
    }
    if (kind === "mute-indefinite-confirm" || kind === "mute-indefinite") {
      const userId = Number(parts[2]);
      const user = Number.isSafeInteger(userId) && userId > 0
        ? await getVerifiedUserRecord(groupId, userId)
        : undefined;
      if (!user) {
        await ctx.answerCallbackQuery({ text: "Usuario no válido.", show_alert: true });
        return;
      }
      if (kind === "mute-indefinite-confirm") {
        await ctx.answerCallbackQuery();
        await renderPanel(
          ctx,
          buildVerifiedActionConfirmPanel(user, "mute-indefinite", groupTitle),
        );
        return;
      }
      if (isCerberoExecutionEnabled()) {
        const queued = await delegateSecurityCommand({
          groupId,
          action: "MUTE_USER",
          targetUserId: userId,
          idempotencyKey: String(ctx.update.update_id),
          payload: { requester_id: ctx.from?.id, requester_name: ctx.from?.first_name },
        });
        await ctx.answerCallbackQuery({
          text: queued.ok
            ? `⏳ Silencio indefinido enviado a Cerbero (${queued.commandId}); aún no está confirmado.`
            : `⛔ ${queued.error}`,
          show_alert: true,
        });
        return;
      }
      const result = await muteUser(ctx, groupId, userId, undefined, user.display_name ?? user.username ?? undefined);
      await ctx.answerCallbackQuery({
        text: result.ok ? "Usuario silenciado indefinidamente." : result.error,
        show_alert: true,
      });
      if (result.ok) {
        const { status, details } = await loadVerifiedProfileDetails(ctx, groupId, user);
        await renderPanel(ctx, buildVerifiedUserPanel(user, groupTitle, status, details));
      }
      return;
    }
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
      ctx.session.user.pendingSince = Date.now();
      await ctx.answerCallbackQuery();
      await renderPanel(
        ctx,
        buildPromptPanel(
          "🧪 *PROBAR MENSAJE*\n\nEnvía el texto que quieres analizar. No se publicará en el grupo ni se aplicará moderación.",
        ),
      );
      return;
    }
    if (
      parts[0] === "fa" &&
      (kind === "stats" ||
        kind === "buying" ||
        kind === "selling" ||
        kind === "links" ||
        kind === "verified")
    ) {
      const data = await getGroupData(groupId);
      const verifiedCount =
        kind === "verified" ? (await getVerifiedUsers(groupId)).length : 0;
      await ctx.answerCallbackQuery();
      await renderPanel(
        ctx,
        buildPromotionInfoPanel(kind, data.promotion, verifiedCount, title),
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
        const result = await removeInactiveUser(
          ctx,
          groupId,
          userId,
          String(ctx.update.update_id),
        );
        await ctx.answerCallbackQuery(
          result === "removed"
            ? "✅ Usuario expulsado."
            : result === "queued"
              ? "⏳ Orden enviada a Cerbero; aún no se ha confirmado la expulsión."
              : "⛔ No se pudo expulsar.",
        );
        await renderPanel(ctx, buildInactivityPanel((await getGroupData(groupId)).inactivity, title));
        return;
      }
      if (kind === "confirm") {
        const users = await getInactiveUsers(ctx, groupId);
        let removed = 0;
        let queued = 0;
        let skipped = 0;
        let errors = 0;
        for (const user of users) {
          const result = await removeInactiveUser(ctx, groupId, user.id);
          if (result === "removed") removed += 1;
          else if (result === "queued") queued += 1;
          else if (result === "skipped") skipped += 1;
          else errors += 1;
        }
        await ctx.answerCallbackQuery(
          queued > 0
            ? `⏳ ${queued} órdenes enviadas; las expulsiones no están confirmadas todavía.`
            : `✅ Limpieza completada: ${removed} expulsados.`,
        );
        await renderPanel(
          ctx,
          buildInactivityPanel((await getGroupData(groupId)).inactivity, title),
        );
        console.log(`[INACTIVITY] groupId=${groupId} removed=${removed} queued=${queued} skipped=${skipped} errors=${errors}`);
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
            (data.antiSpam.maxMentionsPerMessage ?? 5) === 5 ? 10 : 5;
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
      try {
        const admins = await ctx.api.getChatAdministrators(groupId);
        for (const admin of admins) {
          if (!admin.user.is_bot) {
            await recordObservedUser(groupId, admin.user, { status: admin.status });
          }
        }
      } catch (error) {
        console.error(`[USERS PANEL] No se pudieron actualizar administradores groupId=${groupId}:`, error);
      }
      const verifiedUsers = await getVerifiedUsers(groupId);
      await syncVerifiedUserStates(groupId, verifiedUsers);
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
      await renderPanel(
        ctx,
        buildUsersPanel(
          users,
          page,
          groupTitle,
          new Set(verifiedUsers.map((user) => user.user_id)),
        ),
      );
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
      if (isCerberoExecutionEnabled()) {
        const queued = await delegateSecurityCommand({
          groupId,
          action: "UNWARN_USER",
          targetUserId: userId,
          idempotencyKey: String(ctx.update.update_id),
          payload: {
            requester_id: ctx.from?.id,
            requester_name: ctx.from?.first_name,
          },
        });
        await ctx.answerCallbackQuery({
          text: queued.ok
            ? `⏳ Quitar advertencia enviado a Cerbero (${queued.commandId}).`
            : `⛔ ${queued.error}`,
          show_alert: true,
        });
        await renderUserCard(ctx, groupId, userId, groupTitle);
        return;
      }
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
      if (isCerberoExecutionEnabled()) {
        const queued = await delegateSecurityCommand({
          groupId,
          action: "UNWARN_ALL",
          targetUserId: userId,
          idempotencyKey: String(ctx.update.update_id),
          payload: {
            requester_id: ctx.from?.id,
            requester_name: ctx.from?.first_name,
          },
        });
        await ctx.answerCallbackQuery({
          text: queued.ok
            ? `⏳ Quitar todas las advertencias enviado a Cerbero (${queued.commandId}).`
            : `⛔ ${queued.error}`,
          show_alert: true,
        });
        await renderUserCard(ctx, groupId, userId, groupTitle);
        return;
      }
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
      const warnings = isCerberoExecutionEnabled()
        ? await getSecurityWarningHistory(groupId, userId)
        : data.warnings[String(userId)] ?? [];
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
      if (isCerberoExecutionEnabled()) {
        const queued = await delegateSecurityCommand({
          groupId,
          action: "MUTE_USER",
          targetUserId: userId,
          idempotencyKey: String(ctx.update.update_id),
          payload: {
            duration_minutes: minutes,
            reason: "Acción manual desde Zeus",
          },
        });
        await ctx.answerCallbackQuery({
          text: queued.ok
            ? `⏳ Silencio enviado a Cerbero durante ${minutes} min.`
            : `⛔ ${queued.error}`,
          show_alert: true,
        });
        await renderUserCard(ctx, groupId, userId, groupTitle);
        return;
      }
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
      if (isCerberoExecutionEnabled()) {
        const queued = await delegateSecurityCommand({
          groupId,
          action: "UNMUTE_USER",
          targetUserId: userId,
          idempotencyKey: String(ctx.update.update_id),
        });
        await ctx.answerCallbackQuery({
          text: queued.ok ? "⏳ Desmute enviado a Cerbero." : `⛔ ${queued.error}`,
          show_alert: true,
        });
        await renderUserCard(ctx, groupId, userId, groupTitle);
        return;
      }
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
      if (isCerberoExecutionEnabled()) {
        const queued = await delegateSecurityCommand({
          groupId,
          action: "BAN_USER",
          targetUserId: userId,
          idempotencyKey: String(ctx.update.update_id),
          payload: { reason: "Acción manual desde Zeus" },
        });
        await ctx.answerCallbackQuery({
          text: queued.ok ? "⏳ Ban enviado a Cerbero." : `⛔ ${queued.error}`,
          show_alert: true,
        });
        await renderUserCard(ctx, groupId, userId, groupTitle);
        return;
      }
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
      if (isCerberoExecutionEnabled()) {
        const queued = await delegateSecurityCommand({
          groupId,
          action: "UNBAN_USER",
          targetUserId: userId,
          idempotencyKey: String(ctx.update.update_id),
        });
        await ctx.answerCallbackQuery({
          text: queued.ok ? "⏳ Desban enviado a Cerbero." : `⛔ ${queued.error}`,
          show_alert: true,
        });
        await renderUserCard(ctx, groupId, userId, groupTitle);
        return;
      }
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
      if (isCerberoExecutionEnabled()) {
        const data = await getGroupData(groupId);
        const messageIds = data.recentMessages.slice(-count);
        const queued = await delegateSecurityCommand({
          groupId,
          action: "CLEAN_MESSAGES",
          idempotencyKey: String(ctx.update.update_id),
          payload: {
            message_ids: messageIds,
            requester_id: ctx.from?.id,
            requester_name: ctx.from?.first_name,
          },
        });
        await ctx.answerCallbackQuery(
          queued.ok
            ? `⏳ Limpieza enviada a Cerbero (${queued.commandId}).`
            : `⛔ ${queued.error}`,
        );
        await renderPanel(
          ctx,
          buildCleanupPanel(
            !queued.ok || messageIds.length === 0
              ? "🤔 No hay mensajes recientes registrados para limpiar."
              : `⏳ ${messageIds.length} mensajes enviados a Cerbero.`,
          ),
        );
        return;
      }
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