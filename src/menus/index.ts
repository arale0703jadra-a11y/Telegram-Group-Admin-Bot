import { Composer } from "grammy";
import { isUserAdminOf } from "../utils/permissions.js";
import { getAdministrableGroups } from "../utils/groups.js";
import { getActivityGroupData, getGroupData } from "../storage/index.js";
import {
  generateRecoveryKey,
  isSystemOwner,
} from "../services/system-owner.js";
import {
  buildGroupPickerPanel,
  buildMainPanel,
  buildSubmenuPanel,
  buildAntiSpamPanel,
  buildProtectionCenterPanel,
  buildInactivityPanel,
  buildCleanupSettingsPanel,
  buildAutomaticMessagePanel,
  buildUsersPanel,
  buildCommandListPanel,
} from "./panels.js";
import { renderPanel } from "./render.js";
import { recordObservedUser } from "../services/user-registry.js";
import { isAuthorizedPanelUser } from "../security/panel-authorization.js";
import {
  handleActivitySummary,
  isActivityPanelAction,
  presentActivityPanel,
} from "./activity-summary.js";
import type { MyContext } from "../types.js";

const DEVELOPMENT_MESSAGE = "🚧 Esta función está en desarrollo.";
const NO_ADMIN_MESSAGE = "⛔ Ya no eres administrador de ese grupo.";
const NO_GROUP_SELECTED_MESSAGE =
  "Primero selecciona el grupo que quieres administrar.";

type MenuKind = "main" | "home" | "sub" | "action" | "groups" | "group" | "commands";

interface ParsedMenuAction {
  kind: MenuKind;
  section?: string;
  item?: string;
  groupId?: number;
  page?: number;
}

/**
 * Interpreta un callback_data del panel. Devuelve `undefined` si el
 * callback no pertenece a este panel (para no robar callbacks ajenos).
 */
export function parseMenuAction(data: string): ParsedMenuAction | undefined {
  if (!data.startsWith("menu:")) {
    return undefined;
  }
  const parts = data.split(":");
  const kind = parts[1] as MenuKind;

  if (kind === "groups") {
    return { kind };
  }
  if (kind === "group") {
    const groupId = Number(parts[2]);
    return Number.isInteger(groupId) ? { kind: "group", groupId } : undefined;
  }
  if (kind === "commands") {
    const page = Number(parts[2] ?? 0);
    return Number.isSafeInteger(page) && page >= 0
      ? { kind, page }
      : undefined;
  }
  if (kind === "main" || kind === "home") {
    return { kind };
  }
  if (kind === "sub" && parts[2]) {
    return { kind, section: parts[2] };
  }
  if (kind === "action" && parts[2] && parts[3]) {
    return { kind, section: parts[2], item: parts[3] };
  }
  return undefined;
}

async function getGroupTitle(
  ctx: MyContext,
  chatId: number,
): Promise<string | undefined> {
  try {
    const chat = await ctx.api.getChat(chatId);
    return chat.title;
  } catch {
    return undefined;
  }
}

/**
 * Navegación del panel de administración (chat privado).
 *
 * - Autoriza SIEMPRE contra el chat_id del grupo seleccionado.
 * - Las acciones no implementadas muestran el aviso de desarrollo.
 * - La navegación edita el mismo mensaje para no generar spam.
 */
export const menuNavigation = new Composer<MyContext>();

menuNavigation.on("callback_query:data", async (ctx, next) => {
  const callbackData = ctx.callbackQuery.data;
  const action = parseMenuAction(callbackData);
  if (!action) {
    if (callbackData.startsWith("menu:")) {
      await ctx.answerCallbackQuery(
        "⚠️ Este botón ya no es válido. Abre /menu nuevamente.",
      );
      return;
    }
    await next();
    return;
  }

  const isRecoveryStart =
    action.kind === "action" &&
    action.section === "ayuda" &&
    action.item === "recuperar";
  if (
    ctx.chat?.type !== "private" ||
    !ctx.from ||
    (!isRecoveryStart && !(await isAuthorizedPanelUser(ctx.from.id)))
  ) {
    await ctx.answerCallbackQuery(
      isRecoveryStart
        ? "⛔ Disponible solo en el chat privado del bot."
        : "⛔ No autorizado para acceder al panel de ZEUS.",
    );
    return;
  }

  if (action.kind === "action" && action.section === "ayuda") {
    if (action.item === "recuperar") {
      ctx.session.user.pendingAction = { kind: "recoveryKey" };
      await ctx.answerCallbackQuery();
      await ctx.reply("🔐 Envía tu clave de recuperación de un solo uso.");
      return;
    }
    if (action.item === "generar-clave") {
      if (!(await isSystemOwner(ctx.from.id))) {
        await ctx.answerCallbackQuery("⛔ No autorizado.");
        return;
      }
      const key = await generateRecoveryKey(ctx.from.id);
      await ctx.answerCallbackQuery();
      await ctx.reply(
        `🔐 Clave de recuperación de un solo uso:\n\n${key}\n\n` +
        "Guárdala fuera de Telegram. No volveré a mostrarla.",
      );
      return;
    }
  }

  if (action.kind === "groups") {
    ctx.session.user.pendingAction = undefined;
    await ctx.answerCallbackQuery();
    await showGroupPicker(ctx);
    return;
  }

  if (action.kind === "group") {
    const groupId = action.groupId as number;
    if (!(await isUserAdminOf(ctx, groupId))) {
      await ctx.answerCallbackQuery(NO_ADMIN_MESSAGE);
      return;
    }
    const title = (await getGroupTitle(ctx, groupId)) ?? `Grupo ${groupId}`;
    ctx.session.user = {
      selectedGroupId: groupId,
      selectedGroupTitle: title,
      pendingAction: undefined,
    };
    const panel = buildMainPanel(title);
    await ctx.answerCallbackQuery();
    await renderPanel(ctx, panel);
    return;
  }

  const selectedGroupId = ctx.session.user.selectedGroupId;
  if (!selectedGroupId) {
    await ctx.answerCallbackQuery(NO_GROUP_SELECTED_MESSAGE);
    await showGroupPicker(ctx);
    return;
  }

  // Resumen de actividad: módulo completo (paneles + tests) que antes caía
  // en el aviso de "en desarrollo" porque no estaba conectado al router.
  if (isActivityPanelAction(action)) {
    await handleActivitySummary({
      groupId: selectedGroupId,
      groupTitle: ctx.session.user.selectedGroupTitle,
      authorize: () => isUserAdminOf(ctx, selectedGroupId),
      answerCallback: async (message) => {
        await ctx.answerCallbackQuery(message);
      },
      recordUser: async () => {
        if (ctx.from) {
          await recordObservedUser(selectedGroupId, ctx.from, { activity: true });
        }
      },
      loadGroupData: () => getActivityGroupData(selectedGroupId),
      presentPanel: (panel) =>
        presentActivityPanel(panel, {
          edit: async (activityPanel) => {
            const message = ctx.callbackQuery.message;
            const chatId = ctx.chat?.id;
            if (!message || !chatId) {
              return false;
            }
            await ctx.api.editMessageText(
              chatId,
              message.message_id,
              activityPanel.text,
              {
                reply_markup: activityPanel.keyboard,
                parse_mode: "Markdown",
              },
            );
            return true;
          },
          reply: async (activityPanel) => {
            await ctx.reply(activityPanel.text, {
              reply_markup: activityPanel.keyboard,
              parse_mode: "Markdown",
            });
          },
          logError: (message, error) => {
            console.error(`[ACTIVITY PANEL] ${message}`, error);
          },
        }),
      sendError: async (message) => {
        await ctx.reply(message);
      },
      logError: (message, error) => {
        console.error(
          `[ACTIVITY PANEL] ${message} groupId=${selectedGroupId}`,
          error,
        );
      },
    });
    return;
  }

  if (!(await isUserAdminOf(ctx, selectedGroupId))) {
    await ctx.answerCallbackQuery(NO_ADMIN_MESSAGE);
    return;
  }

  if (action.kind === "commands") {
    ctx.session.user.pendingAction = undefined;
    await ctx.answerCallbackQuery();
    await renderPanel(
      ctx,
      buildCommandListPanel(action.page ?? 0, ctx.session.user.selectedGroupTitle),
    );
    return;
  }

  if (action.kind === "action") {
    await ctx.answerCallbackQuery(DEVELOPMENT_MESSAGE);
    return;
  }

  // Navegar a otra sección cancela cualquier operación en espera.
  ctx.session.user.pendingAction = undefined;

  const title = ctx.session.user.selectedGroupTitle;
  let panel;
  if (action.kind === "sub" && action.section === "usuarios") {
    const data = await getGroupData(selectedGroupId);
    const users = Object.values(data.indexedUsers).sort((a, b) =>
      (a.name || a.username || String(a.id)).localeCompare(
        b.name || b.username || String(b.id),
      ),
    );
    console.log(
      `[USERS PANEL] groupId=${selectedGroupId} observedUsers=${users.length}`,
    );
    panel = buildUsersPanel(users, 0, title);
  } else if (action.kind === "sub" && action.section === "proteccion") {
    const data = await getGroupData(selectedGroupId);
    panel = buildProtectionCenterPanel(
      data.emergency,
      data.antiRaid.emergencyMinutes,
      title,
    );
  } else if (action.kind === "sub" && action.section === "antispam") {
    panel = buildAntiSpamPanel(
      (await getGroupData(selectedGroupId)).antiSpam,
      title,
    );
  } else if (action.kind === "sub" && action.section === "inactividad") {
    panel = buildInactivityPanel(
      (await getGroupData(selectedGroupId)).inactivity,
      title,
    );
  } else if (action.kind === "sub" && action.section === "limpieza") {
    panel = buildCleanupSettingsPanel(
      (await getGroupData(selectedGroupId)).cleanup,
      title,
    );
  } else if (action.kind === "sub" && action.section === "mensajes-recurrentes") {
    panel = buildAutomaticMessagePanel(
      (await getGroupData(selectedGroupId)).automaticMessage,
      title,
    );
  } else {
    panel =
      action.kind === "sub" && action.section
        ? buildSubmenuPanel(action.section, title)
        : buildMainPanel(title);
  }

  if (!panel) {
    await ctx.answerCallbackQuery("❌ Sección no encontrada.");
    return;
  }

  await ctx.answerCallbackQuery();
  await renderPanel(ctx, panel);
});

async function showGroupPicker(ctx: MyContext): Promise<void> {
  const groups = await getAdministrableGroups(ctx);
  const picker = buildGroupPickerPanel(groups);
  await renderPanel(ctx, picker);
}