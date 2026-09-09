import { Composer } from "grammy";
import { isUserAdminOf } from "../utils/permissions.js";
import { getAdministrableGroups } from "../utils/groups.js";
import { getGroupData } from "../storage/index.js";
import {
  buildGroupPickerPanel,
  buildMainPanel,
  buildSubmenuPanel,
  buildUsersPanel,
} from "./panels.js";
import { renderPanel } from "./render.js";
import type { MyContext } from "../types.js";

const DEVELOPMENT_MESSAGE = "🚧 Esta función está en desarrollo.";
const NO_ADMIN_MESSAGE = "⛔ Ya no eres administrador de ese grupo.";
const NO_GROUP_SELECTED_MESSAGE =
  "Primero selecciona el grupo que quieres administrar.";

type MenuKind = "main" | "home" | "sub" | "action" | "groups" | "group";

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