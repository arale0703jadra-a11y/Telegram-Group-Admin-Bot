import { Composer } from "grammy";
import { isUserAdminOf } from "../utils/permissions.js";
import { getAdministrableGroups } from "../utils/groups.js";
import { getGroupData } from "../storage/index.js";
import {
  buildGroupPickerPanel,
  buildMainPanel,
  buildSubmenuPanel,
  buildAntiSpamPanel,
  buildInactivityPanel,
  buildUsersPanel,
  buildCerberoPanel,
  buildActivityPanel,
  buildPromptPanel,
  buildHelpEmergenciesPanel,
  buildHelpRecoveryPanel,
} from "./panels.js";
import { renderPanel } from "./render.js";
import type { MyContext } from "../types.js";
import {
  getCerberoStatus,
  getSecurityEvents,
  getSecurityStats,
} from "../services/security-commands.js";
import { calculateActivity } from "../services/activity.js";
import { recordObservedUser } from "../services/user-registry.js";

const NO_ADMIN_MESSAGE = "⛔ Ya no eres administrador de ese grupo.";
const NO_GROUP_SELECTED_MESSAGE =
  "Primero selecciona el grupo que quieres administrar.";

type MenuKind = "main" | "home" | "sub" | "action" | "groups" | "group" | "help";

interface ParsedMenuAction {
  kind: MenuKind;
  section?: string;
  item?: string;
  groupId?: number;
}

/**
 * Interpreta un callback_data del panel. Devuelve `undefined` si el
 * callback no pertenece a este panel (para no robar callbacks ajenos).
 */
function parseMenuAction(data: string): ParsedMenuAction | undefined {
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
  if (kind === "main" || kind === "home") {
    return { kind };
  }
  if (kind === "sub" && parts[2]) {
    return { kind, section: parts[2] };
  }
  if (kind === "action" && parts[2] && parts[3]) {
    return { kind, section: parts[2], item: parts[3] };
  }
  if (kind === "help" && parts[2]) {
    return { kind, item: parts[2] };
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
 * - Los botones visibles siempre apuntan a acciones implementadas.
 * - La navegación edita el mismo mensaje para no generar spam.
 */
export const menuNavigation = new Composer<MyContext>();

menuNavigation.on("callback_query:data", async (ctx, next) => {
  const action = parseMenuAction(ctx.callbackQuery.data);
  if (!action) {
    await next();
    return;
  }

  if (action.kind === "groups") {
    ctx.session.user.pendingAction = undefined;
    await ctx.answerCallbackQuery();
    await showGroupPicker(ctx);
    return;
  }

  if (action.kind === "help") {
    await ctx.answerCallbackQuery();
    if (action.item === "emergencias") {
      await renderPanel(ctx, buildHelpEmergenciesPanel());
      return;
    }
    if (action.item === "recovery") {
      await renderPanel(ctx, buildHelpRecoveryPanel());
      return;
    }
    if (action.item === "recover") {
      ctx.session.user.pendingAction = { kind: "recoveryKey" };
      await renderPanel(
        ctx,
        buildPromptPanel("🔐 Envía tu clave de recuperación de un solo uso."),
      );
      return;
    }
    await renderPanel(ctx, buildMainPanel());
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

  if (!(await isUserAdminOf(ctx, selectedGroupId))) {
    await ctx.answerCallbackQuery(NO_ADMIN_MESSAGE);
    return;
  }
  if (ctx.from) {
    await recordObservedUser(selectedGroupId, ctx.from, { activity: true });
  }

  const title = ctx.session.user.selectedGroupTitle;
  if (action.kind === "action") {
    if (action.section === "cerbero") {
      try {
        const [status, stats, events] = await Promise.all([
          getCerberoStatus(),
          getSecurityStats(selectedGroupId),
          getSecurityEvents(selectedGroupId, 5),
        ]);
        await ctx.answerCallbackQuery();
        await renderPanel(ctx, buildCerberoPanel(status, stats, events, title));
      } catch (error) {
        console.error("[CERBERO PANEL] No se pudo cargar el estado:", error);
        await ctx.answerCallbackQuery("No se pudo consultar Cerbero.");
      }
      return;
    }
    if (action.section === "actividad") {
      const stats = calculateActivity(
        await getGroupData(selectedGroupId),
        selectedGroupId,
      );
      await ctx.answerCallbackQuery();
      await renderPanel(ctx, buildActivityPanel(stats, title));
      return;
    }
    const data = await getGroupData(selectedGroupId);
    const summaries: Record<string, string> = {
      reglas: "Las reglas se consultan desde la configuración local del grupo.",
      config:
        `Anti-spam: ${data.antiSpam.enabled ? "activo" : "inactivo"}\n` +
        `Filtros: ${data.promotion.enabled ? "activos" : "inactivos"}\n` +
        `Inactividad: ${data.inactivity.enabled ? "activa" : "inactiva"}`,
      mensajes: "No hay mensajes automáticos configurados.",
      ayuda: action.item === "comandos"
        ? "Comandos disponibles: /menu, /admin y /start."
        : "El panel exige permisos de administrador verificados por Telegram.",
    };
    await ctx.answerCallbackQuery();
    await renderPanel(
      ctx,
      buildPromptPanel(
        `📋 ${action.section ?? "Configuración"}\n\n` +
          (summaries[action.section ?? ""] ?? "Configuración consultada correctamente."),
      ),
    );
    return;
  }

  // Navegar a otra sección cancela cualquier operación en espera.
  ctx.session.user.pendingAction = undefined;

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