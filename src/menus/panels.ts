import { InlineKeyboard } from "grammy";
import type { AdministrableGroup } from "../utils/groups.js";
import {
  ILLEGAL_PROTECTED_CATEGORIES,
} from "../storage/initial.js";
import type {
  IllegalContentConfig,
  AntiSpamConfig,
  InactivityConfig,
  IndexedUser,
  PromotionConfig,
  WarningEntry,
  AutomaticMessageConfig,
} from "../storage/types.js";
import type { ActivityStats } from "../services/activity.js";
import type { ResolvedUser, UserCardData } from "../utils/users.js";
import type { MyContext } from "../types.js";
import { getGroupData } from "../storage/index.js";
import {
  BUYING_SIGNAL_EXAMPLES,
  SELLING_SIGNAL_EXAMPLES,
} from "../filters/detector.js";
import type { VerifiedUser, VerifiedUserPermissions } from "../services/verified-users.js";
import { buildUserStatusBadges } from "../services/verified-user-policy.js";

export interface Panel {
  text: string;
  keyboard: InlineKeyboard;
}

/**
 * Esquema de callback_data del panel.
 *   menu:main / menu:home        -> panel principal
 *   menu:sub:<seccion>           -> abre un submenú
 *   menu:action:<seccion>:<id>   -> acción de sección
 *   menu:groups                  -> selector de grupos
 *   menu:group:<chat_id>         -> selecciona un grupo
 *
 * Las acciones reales de Usuarios y Moderación usan el prefijo `ma:`.
 */
const MENU_PREFIX = "menu";

export const MenuAction = {
  main: `${MENU_PREFIX}:main`,
  home: `${MENU_PREFIX}:home`,
  sub: (id: string): string => `${MENU_PREFIX}:sub:${id}`,
  action: (section: string, id: string): string =>
    `${MENU_PREFIX}:action:${section}:${id}`,
  groups: `${MENU_PREFIX}:groups`,
  group: (chatId: number): string => `${MENU_PREFIX}:group:${chatId}`,
  help: (section: string): string => `${MENU_PREFIX}:help:${section}`,
};

/**
 * Acciones reales del panel (Usuarios + Moderación).
 */
const MA = "ma";
export const ModAction = {
  search: `${MA}:search`,
  users: (page: number): string => `${MA}:users:${page}`,
  warnMenu: `${MA}:warnmenu`,
  muteSel: `${MA}:mutesel`,
  unmuteSel: `${MA}:unmutesel`,
  banPrompt: `${MA}:banprompt`,
  unbanList: `${MA}:unbanlist`,
  clean: `${MA}:clean`,
  deleteHelp: `${MA}:deletehelp`,
  cancel: `${MA}:cancel`,
  info: (userId: number): string => `${MA}:info:${userId}`,
  warn: (userId: number): string => `${MA}:warn:${userId}`,
  unwarn: (userId: number): string => `${MA}:unwarn:${userId}`,
  unwarnAll: (userId: number): string => `${MA}:unwarnall:${userId}`,
  confirmUnwarnAll: (userId: number): string => `${MA}:confirmunwarnall:${userId}`,
  viewWarnings: (userId: number): string => `${MA}:viewwarnings:${userId}`,
  mute: (userId: number): string => `${MA}:mute:${userId}`,
  muteAt: (userId: number, minutes: number): string =>
    `${MA}:muteat:${userId}:${minutes}`,
  muteCustom: (userId: number): string => `${MA}:mutecustom:${userId}`,
  unmute: (userId: number): string => `${MA}:unmute:${userId}`,
  banConfirm: (userId: number): string => `${MA}:banconfirm:${userId}`,
  ban: (userId: number): string => `${MA}:ban:${userId}`,
  unban: (userId: number): string => `${MA}:unban:${userId}`,
  cleanup: (count: number): string => `${MA}:cleanup:${count}`,
};

const FILTER_PREFIX = "fa";
export const FilterAction = {
  home: `${FILTER_PREFIX}:home`,
  add: `${FILTER_PREFIX}:add`,
  cancel: `${FILTER_PREFIX}:cancel`,
  stats: `${FILTER_PREFIX}:stats`,
  test: `${FILTER_PREFIX}:test`,
  buying: `${FILTER_PREFIX}:buying`,
  selling: `${FILTER_PREFIX}:selling`,
  links: `${FILTER_PREFIX}:links`,
  verified: `${FILTER_PREFIX}:verified`,
  settings: `${FILTER_PREFIX}:settings`,
  deletePage: (page: number): string => `${FILTER_PREFIX}:deletepage:${page}`,
  delete: (index: number, page: number): string =>
    `${FILTER_PREFIX}:delete:${index}:${page}`,
  confirm: `${FILTER_PREFIX}:confirm`,
  viewPage: (page: number): string => `${FILTER_PREFIX}:view:${page}`,
  toggle: `${FILTER_PREFIX}:toggle`,
  illegal: `${FILTER_PREFIX}:illegal`,
  illegalToggle: `${FILTER_PREFIX}:illegal_toggle`,
  illegalAdd: `${FILTER_PREFIX}:illegal_add`,
  illegalList: (page: number): string => `${FILTER_PREFIX}:illegal_list:${page}`,
  illegalDelete: (index: number, page: number): string =>
    `${FILTER_PREFIX}:illegal_delete:${index}:${page}`,
  illegalConfirm: `${FILTER_PREFIX}:illegal_confirm`,
  illegalConfig: `${FILTER_PREFIX}:illegal_config`,
  illegalEvents: `${FILTER_PREFIX}:illegal_events`,
};

export const AntiSpamAction = {
  toggle: "sa:toggle",
  mentions: "sa:mentions",
  links: "sa:links",
  repeated: "sa:repeated",
  automated: "sa:automated",
};

export const InactivityAction = {
  toggle: "ia:toggle",
  list: (page: number): string => `ia:list:${page}`,
  config: "ia:config",
  clean: "ia:clean",
  confirm: "ia:confirm",
  user: (id: number): string => `ia:user:${id}`,
  remove: (id: number): string => `ia:remove:${id}`,
  cancel: "ia:cancel",
};

export const VerifiedAction = {
  add: "vu:add",
  confirmAdd: (userId: number): string => `vu:confirm:${userId}`,
  cancelAdd: "vu:cancel",
  revoke: (userId: number): string => `vu:revoke:${userId}`,
  revokePermissions: (userId: number): string => `vu:revoke-permissions:${userId}`,
  toggle: (userId: number, permission: keyof VerifiedUserPermissions): string =>
    `vu:toggle:${userId}:${permission}`,
};

export const UserAction = {
  all: "us:all",
  new: "us:new",
  active: "us:active",
  inactive: "us:inactive",
  admins: "us:admins",
  verified: "us:verified",
  scan: "us:scan",
};

const PANEL_TITLE = "🛡️ *PANEL DE ADMINISTRACIÓN*";

/**
 * Elimina caracteres de Markdown del título para no romper el formato.
 */
function sanitizeGroupTitle(title: string): string {
  return title.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "");
}

function formatGroupHeader(groupTitle?: string): string {
  if (!groupTitle) {
    return PANEL_TITLE;
  }
  return `${PANEL_TITLE}\n\nGrupo seleccionado: ${sanitizeGroupTitle(groupTitle)}`;
}

function formatUserName(user: ResolvedUser): string {
  if (user.username) {
    return `@${user.username}`;
  }
  return user.name || `ID ${user.id}`;
}

interface MenuItem {
  id: string;
  label: string;
  /** Callback_data de la acción implementada para este botón. */
  cb?: string;
}

/**
 * Categorías del panel principal, en el orden solicitado.
 */
const CATEGORIES: MenuItem[] = [
{ id: "usuarios", label: "👥 Usuarios" },
{ id: "filtros", label: "🚫 Filtros" },
{ id: "antispam", label: "🛡️ Anti-spam" },
{ id: "inactividad", label: "⏰ Inactividad" },
{ id: "limpieza", label: "🧹 Limpieza" },
{ id: "actividad", label: "📊 Actividad" },
{ id: "config", label: "⚙️ Configuración" },
{ id: "cerbero", label: "🛡️ Seguridad Cerbero" },
{ id: "verificadas", label: "👑 Verificadas" },
{ id: "mensajes", label: "📢 Mensajes automáticos" },
{ id: "ayuda", label: "🆘 Ayuda" },
];

interface SubmenuDef {
  icon: string;
  title: string;
  description: string;
  items: MenuItem[];
}

/**
 * Definición de todos los submenús.
 * Las acciones de Usuarios y Moderación ya están cableadas a funciones reales.
 */
const SUBMENUS: Record<string, SubmenuDef> = {
  usuarios: {
    icon: "👥",
    title: "Usuarios",
    description: "Buscar, advertir, silenciar y banear miembros.",
    items: [
      { id: "buscar", label: "🔎 Buscar usuario", cb: ModAction.search },
      { id: "lista", label: "👥 Usuarios detectados", cb: ModAction.users(0) },
      { id: "todos", label: "📋 Todos", cb: UserAction.all },
      { id: "nuevos", label: "🆕 Nuevos", cb: UserAction.new },
      { id: "activos", label: "🟢 Activos", cb: UserAction.active },
      { id: "inactivos", label: "⚪ Inactivos", cb: UserAction.inactive },
      { id: "admins", label: "🛡️ Administradores", cb: UserAction.admins },
      { id: "verificadas", label: "👑 Verificadas", cb: UserAction.verified },
      { id: "escanear", label: "🔄 Escanear grupo", cb: UserAction.scan },
      { id: "baneados", label: "🚫 Usuarios baneados", cb: ModAction.unbanList },
    ],
  },
  filtros: {
    icon: "🚫",
    title: "Filtros",
    description: "Control de palabras y frases prohibidas.",
    items: [
      { id: "promociones", label: "🛡️ Detección de promociones", cb: FilterAction.home },
      { id: "ver", label: "📋 Ver filtros", cb: FilterAction.viewPage(0) },
      { id: "agregar", label: "➕ Agregar palabra/frase", cb: FilterAction.add },
      {
        id: "eliminar",
        label: "🗑️ Eliminar palabra/frase",
        cb: FilterAction.deletePage(0),
      },
      { id: "activar", label: "🔔 Activar/desactivar filtros", cb: FilterAction.toggle },
      { id: "ilegal", label: "🔴 Filtro de contenido ilegal", cb: FilterAction.illegal },
    ],
  },
  antispam: {
    icon: "🛡️",
    title: "Anti-spam",
    description: "Protección contra spam, enlaces y flujo de mensajes.",
    items: [
      { id: "activar", label: "🛡️ Activar/desactivar", cb: AntiSpamAction.toggle },
      { id: "menciones", label: "👥 Máx. menciones", cb: AntiSpamAction.mentions },
      { id: "enlaces", label: "🔗 Control de enlaces", cb: AntiSpamAction.links },
      { id: "repetidos", label: "📩 Control de mensajes repetidos", cb: AntiSpamAction.repeated },
      { id: "automatico", label: "🤖 Detección automática", cb: AntiSpamAction.automated },
    ],
  },
  inactividad: {
    icon: "⏰",
    title: "Inactividad",
    description: "Detecta y gestiona usuarios inactivos del grupo.",
    items: [
      { id: "activar", label: "⏰ Activar/desactivar", cb: InactivityAction.toggle },
      { id: "periodo", label: "📅 Configurar período", cb: InactivityAction.config },
      { id: "inactivos", label: "👥 Ver usuarios inactivos", cb: InactivityAction.list(0) },
      { id: "limpiar", label: "🧹 Limpiar inactivos", cb: InactivityAction.clean },
    ],
  },
  limpieza: {
    icon: "🧹",
    title: "Limpieza",
    description: "Elimina mensajes recientes que ZEUS puede localizar.",
    items: [
      { id: "limpiar", label: "🧹 Limpiar mensajes recientes", cb: ModAction.clean },
      { id: "ayuda", label: "ℹ️ Límites de limpieza", cb: ModAction.deleteHelp },
    ],
  },
  actividad: {
    icon: "📊",
    title: "Actividad",
    description: "Consulta la actividad observada del grupo.",
    items: [
      { id: "resumen", label: "📊 Resumen", cb: MenuAction.action("actividad", "resumen") },
      { id: "actualizar", label: "🔄 Actualizar", cb: MenuAction.action("actividad", "actualizar") },
    ],
  },
  config: {
    icon: "⚙️",
    title: "Configuración",
    description: "Consulta la configuración activa del grupo.",
    items: [
      { id: "ver", label: "⚙️ Ver configuración", cb: "cfg:config_view" },
      { id: "antispam", label: "🛡️ Alternar anti-spam", cb: "cfg:antispam_toggle" },
      { id: "enlaces", label: "🔗 Alternar enlaces", cb: "cfg:links_toggle" },
      { id: "multimedia", label: "🖼️ Alternar multimedia repetida", cb: "cfg:multimedia_toggle" },
      { id: "nuevos", label: "👋 Alternar nuevos usuarios", cb: "cfg:new_users_toggle" },
      { id: "recurrencia", label: "🔁 Cambiar recurrencia", cb: "cfg:recurrence_cycle" },
      { id: "emergencia", label: "🚨 Alternar emergencia", cb: "cfg:emergency_toggle" },
      { id: "menciones", label: "💬 Cambiar límite de menciones", cb: "cfg:mentions_edit" },
      { id: "cerbero_estado", label: "🛡️ Alternar protección Cerbero", cb: "cfg:cerbero_toggle" },
      { id: "cerbero_media", label: "🖼️ Alternar multimedia Cerbero", cb: "cfg:cerbero_media_toggle" },
      { id: "cerbero", label: "🛡️ Sincronizar configuración Cerbero", cb: "cfg:cerbero_sync" },
      { id: "verified", label: "👑 Configurar Verificadas", cb: "cfg:verified_view" },
    ],
  },
  mensajes: {
    icon: "📢",
    title: "Mensajes automáticos",
    description: "Consulta el estado de los mensajes automáticos del grupo.",
    items: [
      { id: "estado", label: "📢 Ver estado", cb: "cfg:auto_view" },
      { id: "crear", label: "➕ Crear/editar mensaje", cb: "cfg:auto_edit" },
      { id: "activar", label: "🟢 Activar/desactivar", cb: "cfg:auto_toggle" },
      { id: "frecuencia", label: "⏱️ Cambiar frecuencia", cb: "cfg:auto_frequency" },
      { id: "eliminar", label: "🗑️ Eliminar mensaje", cb: "cfg:auto_delete" },
      { id: "ahora", label: "📨 Enviar ahora", cb: "cfg:auto_send" },
    ],
  },
  verificadas: {
    icon: "👑",
    title: "Verificadas",
    description: "Usuarios de confianza y excepciones internas por grupo.",
    items: [
      { id: "lista", label: "👑 Ver verificadas", cb: "vu:list" },
      { id: "agregar", label: "➕ Agregar verificada", cb: VerifiedAction.add },
    ],
  },
  cerbero: {
    icon: "🛡️",
    title: "Seguridad Cerbero",
    description: "Estado, estadísticas y eventos del ejecutor de seguridad.",
    items: [
      { id: "estado", label: "📡 Estado del bot", cb: MenuAction.action("cerbero", "estado") },
      { id: "estadisticas", label: "📊 Estadísticas últimas 24h", cb: MenuAction.action("cerbero", "estadisticas") },
      { id: "eventos", label: "📋 Últimos eventos", cb: MenuAction.action("cerbero", "eventos") },
    ],
  },
  ayuda: {
    icon: "🆘",
    title: "Ayuda",
    description: "Accesos rápidos para emergencias y recuperación.",
    items: [
      { id: "emergencias", label: "🚨 Emergencias", cb: MenuAction.help("emergencias") },
      { id: "recovery", label: "🔐 Recovery Key", cb: MenuAction.help("recovery") },
    ],
  },
};

export function buildHelpEmergenciesPanel(): Panel {
  return {
    text:
      "🆘 *AYUDA*\n\n" +
      "🚨 *Emergencias*\n\n" +
      "/menu — Abrir el panel administrativo.\n" +
      "/borrar — Eliminar un mensaje respondiendo a él.\n" +
      "Los comandos /mute, /unmute, /ban, /unban y /kick no están implementados como comandos independientes; sus acciones están disponibles desde el panel.\n\n" +
      "Los comandos de administración requieren permisos de administrador cuando corresponda.",
    keyboard: new InlineKeyboard()
      .text("⬅️ Volver", MenuAction.sub("ayuda")),
  };
}

export function buildHelpRecoveryPanel(): Panel {
  return {
    text:
      "🆘 *AYUDA*\n\n" +
      "🔐 *Recovery Key*\n\n" +
      "La Recovery Key sirve exclusivamente para recuperar el System Owner si pierdes el acceso a tu cuenta de Telegram.\n\n" +
      "No sirve para administrar grupos ni concede permisos de Telegram. Es de un solo uso.\n\n" +
      "Puedes crear o recuperar una cuenta nueva de Telegram, abrir Zeus desde esa cuenta y seleccionar “Recuperar System Owner”. Después introduce la Recovery Key para transferir el System Owner a la nueva cuenta. La clave utilizada queda consumida.",
    keyboard: new InlineKeyboard()
      .text("🔐 Recuperar System Owner", MenuAction.help("recover"))
      .row()
      .text("⬅️ Volver", MenuAction.sub("ayuda")),
  };
}

export function buildAutomaticMessagePanel(
  config: AutomaticMessageConfig | undefined,
  groupTitle?: string,
): Panel {
  const keyboard = new InlineKeyboard()
    .text("✏️ Crear/editar", "cfg:auto_edit").row()
    .text("🟢 Activar/desactivar", "cfg:auto_toggle").row()
    .text("⏱️ Cambiar frecuencia", "cfg:auto_frequency").row()
    .text("📨 Enviar ahora", "cfg:auto_send").row()
    .text("🗑️ Eliminar", "cfg:auto_delete").row()
    .add(...buildNavRow().inline_keyboard.flat());
  const body = config
    ? `📢 ${config.message}\n\nEstado: ${config.enabled ? "activo" : "inactivo"}\nFrecuencia: ${config.intervalMinutes ?? "no definida"} min`
    : "No hay mensaje automático configurado.";
  return { text: `${formatGroupHeader(groupTitle)}\n\n${body}`, keyboard };
}

export function buildVerifiedTitleConfigPanel(
  _titles: string[],
  _autoDetect: boolean,
  _autoRemove: boolean,
  groupTitle?: string,
): Panel {
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n⚙️ *VERIFICADAS*\n\n` +
      "La verificación se reconoce únicamente desde el registro activo de ZEUS.\n" +
      "Los títulos administrativos de Telegram no añaden ni revocan verificaciones.\n\n" +
      "La sincronización actualiza los estados de administrador observados.",
    keyboard: new InlineKeyboard()
      .text("🔄 Sincronizar ahora", "cfg:verified_sync").row()
      .add(...buildNavRow().inline_keyboard.flat()),
  };
}

/**
 * Fila de navegación común: siempre permite salir del submenú.
 * En esta fase "Volver" e "Inicio" llevan al panel principal.
 */
function buildNavRow(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⬅️ Volver", MenuAction.main)
    .text("🏠 Inicio", MenuAction.home);
}

/**
 * Panel principal con todas las categorías.
 * En el chat privado muestra el grupo actualmente seleccionado.
 */
export function buildMainPanel(groupTitle?: string): Panel {
  const keyboard = new InlineKeyboard();
  for (const category of CATEGORIES) {
    keyboard.text(category.label, MenuAction.sub(category.id));
    keyboard.row();
  }

  keyboard.text("🔄 Cambiar grupo", MenuAction.groups);

  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n` +
      "Selecciona una categoría para gestionar el grupo:\n\n" +
      "ℹ️ Solo los administradores del grupo pueden usar este panel.",
    keyboard,
  };
}

export function buildActivityPanel(
  stats: ActivityStats,
  groupTitle?: string,
): Panel {
  const topUsers = stats.topUsers.length
    ? stats.topUsers
        .map((user, index) => `${index + 1}. ${user.name}${user.username ? ` (@${user.username})` : ""}: ${user.count}`)
        .join("\n")
    : "Sin actividad registrada.";
  const last7 = stats.byDay7.map((day) => `${day.label}: ${day.count}`).join("\n");
  const last30 = stats.byDay30.map((day) => `${day.label}: ${day.count}`).join("\n");
  const peak = [...stats.byHour].sort((a, b) => b.count - a.count)[0];
  const previous = stats.messagesPrevious7Days;
  const trend = stats.messagesLast7Days > previous
    ? "📈 En aumento"
    : stats.messagesLast7Days < previous
      ? "📉 En descenso"
      : "➡️ Estable";
  const keyboard = new InlineKeyboard()
    .text("🔄 Actualizar", MenuAction.action("actividad", "actualizar")).row()
    .text("⬅️ Volver", MenuAction.sub("actividad"))
    .text("🏠 Inicio", MenuAction.home);
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n` +
      `📊 *Actividad del grupo*\n\n` +
      `Mensajes registrados: ${stats.totalMessages}\n` +
      `Usuarios activos: ${stats.activeUsers}\n` +
      `Hoy: ${stats.messagesToday}\n` +
      `Últimos 7 días: ${stats.messagesLast7Days}\n` +
      `Últimos 30 días: ${stats.messagesLast30Days}\n` +
      `Tendencia semanal: ${trend}\n` +
      `Hora pico: ${peak && peak.count > 0 ? `${String(peak.hour).padStart(2, "0")}:00 (${peak.count})` : "Sin datos"}\n\n` +
      `👥 *Usuarios más activos*\n${topUsers}\n\n` +
      `📅 *Últimos 7 días*\n${last7}\n\n` +
      `🗓️ *Últimos 30 días*\n${last30}`,
    keyboard,
  };
}

/**
 * Submenú de una categoría dada.
 * Devuelve `undefined` si la sección no existe.
 */
export function buildSubmenuPanel(
  id: string,
  groupTitle?: string,
): Panel | undefined {
  const def = SUBMENUS[id];
  if (!def) {
    return undefined;
  }

  const keyboard = new InlineKeyboard();
  for (const item of def.items) {
    keyboard.text(
      item.label,
      item.cb ?? MenuAction.action(id, item.id),
    );
    keyboard.row();
  }
  if (id === "ayuda") {
    keyboard.text("⬅️ Volver", MenuAction.main);
  } else {
    keyboard.add(...buildNavRow().inline_keyboard.flat());
  }

  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n` +
      `📍 *Sección: ${def.icon} ${def.title}*\n\n` +
      `${def.description}\n\n` +
      "Selecciona una opción:",
    keyboard,
  };
}

export function buildCerberoPanel(
  status: {
    status: string;
    version?: string;
    lastHeartbeatAt?: string;
  } | undefined,
  stats: {
    deletedMessages: number;
    mutedUsers: number;
    bannedUsers: number;
    kickedUsers: number;
    alerts: number;
  },
  events: Array<{
    eventType: string;
    details: Record<string, unknown>;
    createdAt: string;
  }>,
  groupTitle?: string,
): Panel {
  const online = status?.status === "online" &&
    Boolean(status.lastHeartbeatAt) &&
    Date.now() - Date.parse(status.lastHeartbeatAt as string) <= 120000;
  const lastHeartbeat = status?.lastHeartbeatAt
    ? new Date(status.lastHeartbeatAt).toLocaleString("es-ES")
    : "Sin conexión registrada";
  const eventText = events.length === 0
    ? "Sin eventos recientes."
    : events.map((event) =>
        `• ${event.eventType} · ${new Date(event.createdAt).toLocaleString("es-ES")}`,
      ).join("\n");
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n` +
      "🛡️ *SEGURIDAD CERBERO*\n\n" +
      `Estado: ${online ? "🟢 Online" : "🔴 Offline"}\n` +
      `Versión: ${status?.version ?? "desconocida"}\n` +
      `Última conexión: ${lastHeartbeat}\n\n` +
      "📊 *Últimas 24 horas*\n" +
      `🗑 Mensajes eliminados: ${stats.deletedMessages}\n` +
      `🔇 Usuarios muteados: ${stats.mutedUsers}\n` +
      `🚫 Baneos: ${stats.bannedUsers}\n` +
      `👢 Expulsiones: ${stats.kickedUsers}\n` +
      `⚠️ Alertas: ${stats.alerts}\n\n` +
      "📋 *Últimos eventos*\n" +
      eventText,
    keyboard: buildNavRow(),
  };
}

/**
 * Selector de grupos administrables (chat privado, multi-grupo).
 */
export function buildGroupPickerPanel(groups: AdministrableGroup[]): Panel {
  const keyboard = new InlineKeyboard();
  for (const group of groups) {
    const label = group.title || `Grupo ${group.id}`;
    keyboard.text(label.length > 32 ? `${label.slice(0, 31)}…` : label, MenuAction.group(group.id));
    keyboard.row();
  }

  const text =
    groups.length === 0
      ? `${PANEL_TITLE}\n\n⛔ No tienes ningún grupo administrable con este bot.`
      : `${PANEL_TITLE}\n\n¿Qué grupo quieres administrar?\n\n` +
        "Selecciona el grupo donde quieres aplicar la configuración:";

  return { text, keyboard };
}

function permissionLabel(key: keyof VerifiedUserPermissions): string {
  const labels: Record<keyof VerifiedUserPermissions, string> = {
    can_post: "Publicaciones",
    can_send_media: "Multimedia",
    can_send_links: "Enlaces",
    bypass_antispam: "Anti-spam exento",
    bypass_promotion_filter: "Promoción exenta",
    bypass_illegal_filter: "Contenido ilegal exento",
    bypass_automatic_deletion: "Eliminación automática exenta",
  };
  return labels[key];
}

export function buildVerifiedUsersPanel(users: VerifiedUser[], groupTitle?: string): Panel {
  const keyboard = new InlineKeyboard().text("➕ Agregar verificada", VerifiedAction.add).row();
  for (const user of users) {
    keyboard.text(
      `👑 ${user.username ? `@${user.username}` : user.display_name || `ID ${user.user_id}`}`,
      `vu:view:${user.user_id}`,
    ).row();
  }
  keyboard.add(...buildNavRow().inline_keyboard.flat());
  const list = users.length === 0
    ? "No hay usuarios verificados en este grupo."
    : users.map((user, index) => {
        const name = user.username ? `@${user.username}` : user.display_name || `ID ${user.user_id}`;
        return `${index + 1}. 👑 ${name}\n` +
          `   ID: ${user.user_id}\n` +
          "   Estado: ✅ Verificada\n" +
          `   Registro ZEUS: ${formatVerifiedDate(user.created_at)}`;
      }).join("\n");
  return {
    text: `${formatGroupHeader(groupTitle)}\n\n👑 *VERIFICADAS*\n\n${list}`,
    keyboard,
  };
}

function formatVerifiedDate(value: string): string {
  return new Intl.DateTimeFormat("es-ES", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

export function buildVerifiedAddConfirmPanel(
  user: { id: number; username?: string; name?: string },
  groupTitle?: string,
): Panel {
  const name = user.username
    ? `@${user.username}`
    : user.name || `ID ${user.id}`;
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n` +
      "👑 *CONFIRMAR VERIFICACIÓN*\n\n" +
      `Usuario: ${name}\nID: ${user.id}\n\n` +
      "Confirma que esta es la persona correcta.",
    keyboard: new InlineKeyboard()
      .text("✅ Confirmar", VerifiedAction.confirmAdd(user.id))
      .text("❌ Cancelar", VerifiedAction.cancelAdd),
  };
}

export function buildVerifiedUserPanel(
  user: VerifiedUser,
  groupTitle?: string,
  telegramStatus?: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked",
): Panel {
  const permissionKeys = Object.keys(user.permissions) as Array<keyof VerifiedUserPermissions>;
  const keyboard = new InlineKeyboard();
  for (const key of permissionKeys) {
    keyboard.text(
      `${user.permissions[key] ? "✅" : "❌"} ${permissionLabel(key)}`,
      VerifiedAction.toggle(user.user_id, key),
    ).row();
  }
  keyboard
    .text("♻️ Revocar verificación", VerifiedAction.revoke(user.user_id))
    .row();
  if (telegramStatus === "administrator") {
    keyboard.text("🛡️ Revocar permisos admin", VerifiedAction.revokePermissions(user.user_id)).row();
  }
  keyboard.text("⬅️ Volver", "vu:list");
  const name = user.username ? `@${user.username}` : user.display_name || `ID ${user.user_id}`;
  const adminStatus = telegramStatus === "creator"
    ? "👑 Owner"
    : telegramStatus === "administrator"
      ? "🛡️ Administradora"
      : telegramStatus === "member" || telegramStatus === "restricted"
        ? "👤 Miembro"
        : "❔ No se pudo consultar";
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n👑 *VERIFICADA*\n\n` +
      `${name}\nID: ${user.user_id}\nEstado ZEUS: ✅ Verificada\nEstado Telegram: ${adminStatus}\n` +
      `Registro ZEUS: ${formatVerifiedDate(user.created_at)}\n\n` +
      "Permisos:\n" +
      permissionKeys.map((key) => `• ${permissionLabel(key)} ${user.permissions[key] ? "✅" : "❌"}`).join("\n"),
    keyboard,
  };
}

/**
 * Panel de espera de entrada (buscar usuario, duración personalizada…).
 * Solo muestra un botón para cancelar la operación en curso.
 */
export function buildPromptPanel(text: string): Panel {
  const keyboard = new InlineKeyboard().text("❌ Cancelar", ModAction.cancel);
  return { text, keyboard };
}

export function buildFiltersPanel(
  config: PromotionConfig,
  groupTitle?: string,
): Panel {
  const enabled = config.enabled;
  const keyboard = new InlineKeyboard()
    .text(
      enabled ? "🧠 Detección inteligente 🟢" : "🧠 Detección inteligente 🔴",
      FilterAction.toggle,
    )
    .row()
    .text("📊 Estadísticas", FilterAction.stats)
    .text("🧪 Probar mensaje", FilterAction.test)
    .row()
    .text("🛒 Señales de compra", FilterAction.buying)
    .text("💰 Señales de venta", FilterAction.selling)
    .row()
    .text("🔗 Enlaces", FilterAction.links)
    .text("👑 Verificadas", FilterAction.verified)
    .row()
    .text("⚙️ Configuración", FilterAction.settings)
    .row()
    .add(...buildNavRow().inline_keyboard.flat());

  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n` +
      "🛡️ *DETECCIÓN DE PROMOCIONES*\n\n" +
      `Estado: ${enabled ? "🟢 Activo" : "🔴 Inactivo"}\n` +
      "Separa intención de compra y venta. Solo modera SELLING no verificado.",
    keyboard,
  };
}

export function buildPromotionSettingsPanel(
  config: PromotionConfig,
  groupTitle?: string,
): Panel {
  const enabled = config.enabled;
  const keyboard = new InlineKeyboard()
    .text("➕ Agregar palabra/frase", FilterAction.add)
    .row()
    .text("🗑️ Eliminar palabra/frase", FilterAction.deletePage(0))
    .row()
    .text("📋 Ver palabras", FilterAction.viewPage(0))
    .row()
    .text(
      enabled ? "🔴 Desactivar filtros" : "🟢 Activar filtros",
      FilterAction.toggle,
    )
    .row()
    .text("⬅️ Volver a detección de promociones", FilterAction.home)
    .row()
    .add(...buildNavRow().inline_keyboard.flat());

  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n` +
      "⚙️ *CONFIGURACIÓN DE PROMOCIONES*\n\n" +
      "El diccionario aporta señales contextuales, no determina una venta por sí solo.\n" +
      `Términos contextuales configurados: ${config.dictionary.length}\n` +
      `Estado: ${enabled ? "🟢 Activo" : "🔴 Inactivo"}`,
    keyboard,
  };
}

export function buildPromotionInfoPanel(
  section: "stats" | "buying" | "selling" | "links" | "verified",
  config: PromotionConfig,
  verifiedCount: number,
  groupTitle?: string,
): Panel {
  const headings: Record<typeof section, string> = {
    stats: "📊 *ESTADÍSTICAS DE PROMOCIONES*",
    buying: "🛒 *SEÑALES DE COMPRA*",
    selling: "💰 *SEÑALES DE VENTA*",
    links: "🔗 *ENLACES*",
    verified: "👑 *VERIFICADAS*",
  };
  let body: string;
  switch (section) {
    case "stats": {
      const stats = config.statistics;
      body =
        `Mensajes analizados: ${stats.analyzed}\n` +
        `BUYING: ${stats.buying}\nSELLING: ${stats.selling}\n` +
        `NEUTRAL: ${stats.neutral}\nAMBIGUOUS: ${stats.ambiguous}\n\n` +
        `Promociones eliminadas: ${stats.blocked}\n` +
        `SELLING permitido a verificadas: ${stats.allowedVerified}\n\n` +
        "No existe actualmente un mecanismo para reportar falsos positivos.";
      break;
    }
    case "buying":
      body =
        "La búsqueda o intención de compra se permite:\n\n" +
        BUYING_SIGNAL_EXAMPLES.map((signal) => `• ${signal}`).join("\n");
      break;
    case "selling":
      body =
        "Se exige una acción de oferta propia vinculada a producto/servicio o producto propio con llamada a la acción:\n\n" +
        SELLING_SIGNAL_EXAMPLES.map((signal) => `• ${signal}`).join("\n");
      break;
    case "links":
      body =
        "Un enlace es una señal adicional; no se considera SELLING por sí solo.\n\n" +
        "Patrones promocionales: http://, https://, www., t.me/ y telegram.me/.\n" +
        "Los controles independientes Anti-spam y contenido ilegal mantienen su comportamiento actual.";
      break;
    case "verified":
      body =
        `Verificadas activas en verified_users: ${verifiedCount}.\n\n` +
        "La moderación consulta el registro persistente mediante isVerifiedUser().";
      break;
  }
  return {
    text: `${formatGroupHeader(groupTitle)}\n\n${headings[section]}\n\n${body}`,
    keyboard: new InlineKeyboard()
      .text("⬅️ Volver", FilterAction.home)
      .row()
      .add(...buildNavRow().inline_keyboard.flat()),
  };
}

export function buildAntiSpamPanel(
  config: AntiSpamConfig,
  groupTitle?: string,
): Panel {
  const keyboard = new InlineKeyboard()
    .text(config.enabled ? "🔴 Desactivar" : "🟢 Activar", AntiSpamAction.toggle)
    .row()
    .text("👥 Máx. menciones", AntiSpamAction.mentions)
    .row()
    .text(config.blockLinks ? "🔗 Bloquear enlaces" : "🔗 Permitir enlaces", AntiSpamAction.links)
    .row()
    .text(
      config.detectRepeatedMessages ? "🔁 Repetidos 🟢" : "🔁 Repetidos 🔴",
      AntiSpamAction.repeated,
    )
    .text(
      config.detectAutomatedBehavior ? "🤖 Automático 🟢" : "🤖 Automático 🔴",
      AntiSpamAction.automated,
    )
    .row()
    .add(...buildNavRow().inline_keyboard.flat());

  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n` +
      "🛡️ *ANTI-SPAM*\n\n" +
      `Estado: ${config.enabled ? "🟢 Activado" : "🔴 Desactivado"}\n\n` +
      `🔁 Mensajes repetidos: ${config.detectRepeatedMessages ? "🟢 Activado" : "🔴 Desactivado"}\n` +
      `🔗 Enlaces: ${config.blockLinks ? "🚫 Bloqueados" : "✅ Permitidos"}\n` +
      `👥 Menciones masivas: ${config.maxMentionsPerMessage}\n` +
      "🧹 Spam multimedia: 🟢 Activado\n" +
      `🤖 Detección automática: ${config.detectAutomatedBehavior ? "🟢" : "🔴"}`,
    keyboard,
  };
}

export function buildInactivityPanel(config: InactivityConfig, groupTitle?: string): Panel {
  const keyboard = new InlineKeyboard()
    .text(config.enabled ? "🔴 Desactivar" : "🟢 Activar", InactivityAction.toggle)
    .row()
    .text("👤 Ver usuarios inactivos", InactivityAction.list(0))
    .row()
    .text("🧹 Limpieza de usuarios", InactivityAction.clean)
    .text("⚙️ Configuración", InactivityAction.config)
    .row()
    .add(...buildNavRow().inline_keyboard.flat());
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n⏰ *INACTIVIDAD*\n\n` +
      `Estado: ${config.enabled ? "🟢 Activado" : "🔴 Desactivado"}\n` +
      `Período: ${config.customDays ?? config.inactivityDays} días`,
    keyboard,
  };
}

export function buildInactiveUsersPanel(
  users: Array<{ id: number; name?: string; username?: string; inactiveDays: number }>,
  page: number,
  groupTitle?: string,
): Panel {
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(users.length / pageSize));
  const current = Math.min(Math.max(page, 0), pageCount - 1);
  const visible = users.slice(current * pageSize, (current + 1) * pageSize);
  const keyboard = new InlineKeyboard();
  for (const user of visible) {
    keyboard
      .text(`👤 ${user.name || user.username || `ID ${user.id}`} (${user.inactiveDays} d.)`, InactivityAction.user(user.id))
      .row();
  }
  if (current > 0) keyboard.text("◀️ Anterior", InactivityAction.list(current - 1));
  if (current < pageCount - 1) keyboard.text("Siguiente ▶️", InactivityAction.list(current + 1));
  keyboard.row().text("⬅️ Volver", MenuAction.sub("inactividad"));
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n👤 *USUARIOS INACTIVOS*\n\n` +
      `Página ${current + 1}/${pageCount}\n` +
      (visible.length
        ? visible.map((u) => `• ${u.name || "Sin nombre"} ${u.username ? `@${u.username}` : ""} — ${u.inactiveDays} días`).join("\n")
        : "No hay usuarios inactivos."),
    keyboard,
  };
}

export function buildInactivityConfirmPanel(userId: number, groupTitle?: string): Panel {
  return {
    text: `${formatGroupHeader(groupTitle)}\n\n⚠️ *¿Confirmar expulsión del usuario?*\n\nID: ${userId}`,
    keyboard: new InlineKeyboard()
      .text("✅ Confirmar", InactivityAction.remove(userId))
      .text("❌ Cancelar", InactivityAction.cancel),
  };
}

export function buildInactivityCleanConfirmPanel(groupTitle?: string): Panel {
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n⚠️ *CONFIRMAR LIMPIEZA*\n\n` +
      "Se eliminarán los usuarios que superen el período configurado.",
    keyboard: new InlineKeyboard()
      .text("✅ Confirmar", InactivityAction.confirm)
      .text("❌ Cancelar", InactivityAction.cancel),
  };
}

export function buildFilterListPanel(
  config: PromotionConfig,
  page: number,
  mode: "view" | "delete",
  groupTitle?: string,
): Panel {
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(config.dictionary.length / pageSize));
  const currentPage = Math.min(Math.max(page, 0), pageCount - 1);
  const start = currentPage * pageSize;
  const visible = config.dictionary.slice(start, start + pageSize);
  const keyboard = new InlineKeyboard();

  if (mode === "delete") {
    visible.forEach((term, offset) => {
      keyboard
        .text(`🗑️ ${term}`, FilterAction.delete(start + offset, currentPage))
        .row();
    });
  }

  if (currentPage > 0) {
    keyboard.text(
      "◀️ Anterior",
      mode === "view"
        ? FilterAction.viewPage(currentPage - 1)
        : FilterAction.deletePage(currentPage - 1),
    );
  }
  if (currentPage < pageCount - 1) {
    keyboard.text(
      "Siguiente ▶️",
      mode === "view"
        ? FilterAction.viewPage(currentPage + 1)
        : FilterAction.deletePage(currentPage + 1),
    );
  }
  if (pageCount > 1) {
    keyboard.row();
  }
  keyboard.text("⬅️ Volver", MenuAction.sub("filtros"));

  const list =
    visible.length === 0
      ? "No hay palabras configuradas."
      : visible.map((term, offset) => `${start + offset + 1}. ${term}`).join("\n");
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n` +
      `${mode === "view" ? "📋 *PALABRAS CONFIGURADAS*" : "🗑️ *ELIMINAR FILTRO*"}\n\n` +
      `Página ${currentPage + 1}/${pageCount}\n${list}`,
    keyboard,
  };
}

export function buildFilterConfirmPanel(
  term: string,
  groupTitle?: string,
): Panel {
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n` +
      "🗑️ *¿Eliminar este filtro?*\n\n" +
      `"${term}"`,
    keyboard: new InlineKeyboard()
      .text("✅ Sí, eliminar", FilterAction.confirm)
      .text("❌ Cancelar", FilterAction.cancel),
  };
}

export function buildIllegalPanel(
  config: IllegalContentConfig,
  groupTitle?: string,
): Panel {
  const keyboard = new InlineKeyboard()
    .text(
      config.enabled ? "🔴 Desactivar filtro ilegal" : "🟢 Activar filtro ilegal",
      FilterAction.illegalToggle,
    )
    .row()
    .text("🔒 Lista protegida del sistema", FilterAction.illegal)
    .row()
    .text("📝 Palabras personalizadas", FilterAction.illegalList(0))
    .row()
    .text("➕ Agregar palabra personalizada", FilterAction.illegalAdd)
    .row()
    .text("⚙️ Configuración", FilterAction.illegalConfig)
    .row()
    .text("📊 Eventos detectados", FilterAction.illegalEvents)
    .row()
    .add(...buildNavRow().inline_keyboard.flat());
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n` +
      "🔴 *FILTRO DE CONTENIDO ILEGAL*\n\n" +
      `Estado: ${config.enabled ? "🟢 ACTIVADO" : "🔴 DESACTIVADO"}\n` +
      `🔒 Reglas protegidas: ${ILLEGAL_PROTECTED_CATEGORIES.length} categorías\n` +
      `📝 Palabras personalizadas: ${config.customTerms.length}\n` +
      `📊 Eventos detectados: ${config.events}`,
    keyboard,
  };
}

export function buildIllegalCategoriesPanel(groupTitle?: string): Panel {
  const keyboard = new InlineKeyboard().text("⬅️ Volver", FilterAction.illegal);
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n` +
      "🔒 *LISTA PROTEGIDA DEL SISTEMA*\n\n" +
      ILLEGAL_PROTECTED_CATEGORIES.map((category) => `• ${category}: protegida`).join("\n"),
    keyboard,
  };
}

export function buildIllegalTermsPanel(
  terms: string[],
  page: number,
  groupTitle?: string,
): Panel {
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(terms.length / pageSize));
  const currentPage = Math.min(Math.max(page, 0), pageCount - 1);
  const start = currentPage * pageSize;
  const visible = terms.slice(start, start + pageSize);
  const keyboard = new InlineKeyboard();
  visible.forEach((term, offset) => {
    keyboard
      .text(`🗑️ ${term}`, FilterAction.illegalDelete(start + offset, currentPage))
      .row();
  });
  if (currentPage > 0) {
    keyboard.text("◀️ Anterior", FilterAction.illegalList(currentPage - 1));
  }
  if (currentPage < pageCount - 1) {
    keyboard.text("Siguiente ▶️", FilterAction.illegalList(currentPage + 1));
  }
  if (pageCount > 1) {
    keyboard.row();
  }
  keyboard.text("⬅️ Volver", FilterAction.illegal);
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n` +
      "📝 *PALABRAS PERSONALIZADAS*\n\n" +
      `Página ${currentPage + 1}/${pageCount}\n` +
      (visible.length
        ? visible.map((term, index) => `${start + index + 1}. ${term}`).join("\n")
        : "No hay palabras personalizadas."),
    keyboard,
  };
}

export function buildIllegalConfirmPanel(
  term: string,
  groupTitle?: string,
): Panel {
  return {
    text: `${formatGroupHeader(groupTitle)}\n\n🗑️ *¿Eliminar esta palabra personalizada?*\n\n"${term}"`,
    keyboard: new InlineKeyboard()
      .text("✅ Sí, eliminar", FilterAction.illegalConfirm)
      .text("❌ Cancelar", FilterAction.illegalList(0)),
  };
}

export function buildIllegalInfoPanel(
  config: IllegalContentConfig,
  kind: "config" | "events",
  groupTitle?: string,
): Panel {
  const text =
    kind === "config"
      ? "⚙️ *CONFIGURACIÓN*\n\n🔴 Alta confianza: eliminar y ban automático\n🟠 Sospechoso: eliminar y registrar, sin ban"
      : `📊 *EVENTOS DETECTADOS*\n\nEventos registrados: ${config.events}\n\nEl contenido original no se almacena.`;
  return {
    text: `${formatGroupHeader(groupTitle)}\n\n${text}`,
    keyboard: new InlineKeyboard().text("⬅️ Volver", FilterAction.illegal),
  };
}

/**
 * Ficha completa de un usuario con botones de acción rápida.
 */
export function buildUserCardPanel(data: UserCardData): Panel {
  const {
    user,
    member,
    warnings,
    warnLimit,
    muted,
    mutedUntil,
    banned,
    canMute,
    canBan,
    groupTitle,
    inactivityEligible,
  } = data;
  const who = formatUserName(user);

  let status = "⚠️ No está en el grupo";
  let isAdmin = "No";
  if (member) {
    switch (member.status) {
      case "creator":
        status = "👑 Propietario";
        isAdmin = "Sí (Propietario)";
        break;
      case "administrator":
        status = "🛡️ Administrador";
        isAdmin = "Sí";
        break;
      case "member":
        status = "👤 Miembro";
        break;
      case "restricted":
        status = "🔒 Restringido";
        break;
      case "left":
        status = "↪️ Salió del grupo";
        break;
      case "kicked":
        status = "🔨 Baneado";
        break;
    }

  }
  if (banned && !member) {
    status = "🔨 Baneado";
  }

  const grupo = groupTitle
    ? `Grupo: ${sanitizeGroupTitle(groupTitle)}`
    : `Grupo: ${data.groupId}`;

  let muteInfo = "No";
  if (muted) {
    const untilDate =
      member && "until_date" in member && member.until_date
        ? member.until_date
        : mutedUntil;
    if (!untilDate) {
      muteInfo = "Sí";
    } else {
      const until = new Date(untilDate * 1000);
      const remaining = Math.floor((until.getTime() - Date.now()) / 1000 / 60);
      muteInfo = `Sí (hasta ${until.toLocaleString("es-ES")}, ${remaining} min restantes)`;
    }
  }

  let lastSeen = "No disponible";
  if (user.lastSeen) {
    const date = new Date(user.lastSeen * 1000);
    lastSeen = date.toLocaleString("es-ES", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  const joinedAt = user.joinedAt
    ? new Date(user.joinedAt * 1000).toLocaleDateString("es-ES")
    : "Desconocida";
  const lastActivity = user.lastSeen
    ? lastSeen
    : "Nunca";

  const text =
    `👤 *INFORMACIÓN DEL USUARIO*\n\n` +
    `📛 Nombre: ${user.name || "—"}\n` +
    `🔹 Username: ${user.username ? `@${user.username}` : "Sin username"}\n` +
    `🆔 ID: ${user.id}\n\n` +
    `📍 ${grupo}\n` +
    `📊 Estado: ${status}\n` +
    `🛡️ Administrador: ${isAdmin}\n` +
    `⚠️ Advertencias: ${warnings}/${warnLimit}\n` +
    `🔇 Silenciado: ${muteInfo}\n` +
    `📅 Entrada al grupo: ${joinedAt}\n` +
    `🕐 Última actividad observada por el bot: ${lastActivity}`;

  const keyboard = new InlineKeyboard()
    .text("⚠️ Advertir", ModAction.warn(user.id))
    .text("📋 Historial", ModAction.viewWarnings(user.id))
    .row()
    .text("➖ Quitar última", ModAction.unwarn(user.id))
    .text("🗑️ Quitar todas", ModAction.unwarnAll(user.id))
    .row();

  if (muted) {
    keyboard.text("🔊 Quitar silencio", ModAction.unmute(user.id));
  } else if (canMute) {
    keyboard.text("🔇 Silenciar", ModAction.mute(user.id));
  }
  if (banned) {
    keyboard.text("♻️ Desbanear", ModAction.unban(user.id));
  } else if (canBan) {
    keyboard.text("🔨 Banear", ModAction.banConfirm(user.id));
  }
  if (inactivityEligible) {
    keyboard
      .row()
      .text("🧹 Eliminar del grupo", InactivityAction.remove(user.id));
  }
  keyboard.row().add(...buildNavRow().inline_keyboard.flat());

  return { text, keyboard };
}

export function buildUsersPanel(
  users: IndexedUser[],
  page: number,
  groupTitle?: string,
  verifiedUserIds?: ReadonlySet<number>,
): Panel {
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(users.length / pageSize));
  const currentPage = Math.min(Math.max(page, 0), pageCount - 1);
  const visible = users.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  );
  const keyboard = new InlineKeyboard();

  for (const user of visible) {
    keyboard
      .text(`👤 ${user.name || user.username || `ID ${user.id}`}`, ModAction.info(user.id))
      .row();
  }

  keyboard
    .text("🔎 Buscar usuario", ModAction.search)
    .text("🚫 Usuarios baneados", ModAction.unbanList)
    .row();
  if (pageCount > 1) {
    if (currentPage > 0) {
      keyboard.text("◀️ Anterior", ModAction.users(currentPage - 1));
    }
    if (currentPage < pageCount - 1) {
      keyboard.text("Siguiente ▶️", ModAction.users(currentPage + 1));
    }
    keyboard.row();
  }
  keyboard.add(...buildNavRow().inline_keyboard.flat());

  const list =
    visible.length === 0
      ? "👥 No hay usuarios observados todavía."
      : visible
          .map((user) => `• ${user.name || user.username || `ID ${user.id}`}`)
          .join("\n");
  const details = visible
    .map((user) => {
      const verified = verifiedUserIds?.has(user.id) ?? Boolean(user.verified);
      const role = buildUserStatusBadges(user.status ?? "unknown", verified).join(" · ");
      return `${user.name || user.username || `ID ${user.id}`} — ID ${user.id} · ` +
        `entrada ${user.joinedAt ? new Date(user.joinedAt * 1000).toLocaleDateString("es-ES") : "desconocida"} · ` +
        `actividad ${user.lastSeen ? new Date(user.lastSeen * 1000).toLocaleDateString("es-ES") : "sin datos"} · ` +
        `mensajes ${user.messageCount ?? 0} · ${role}`;
    })
    .join("\n");
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n` +
      `👥 *USUARIOS*\n\n` +
      `Usuarios detectados (página ${currentPage + 1}/${pageCount}):\n${list}\n\n` +
      `Detalles:\n${details || "Sin datos."}`,
    keyboard,
  };
}

export function buildUserSearchResultsPanel(
  users: ResolvedUser[],
): Panel {
  const keyboard = new InlineKeyboard();
  for (const user of users) {
    const label = user.name || (user.username ? `@${user.username}` : `ID ${user.id}`);
    keyboard.text(`👤 ${label}`, ModAction.info(user.id)).row();
  }
  keyboard.text("❌ Cancelar", ModAction.cancel);
  return {
    text:
      "🔎 *RESULTADOS DE BÚSQUEDA*\n\n" +
      "Selecciona el usuario que quieres consultar:",
    keyboard,
  };
}

/**
 * Panel de advertencias de un usuario con botones Advertir/Quitar.
 */
export function buildWarningsPanel(
  user: ResolvedUser,
  warnings: number,
  warnLimit: number,
): Panel {
  const who = formatUserName(user);
  const text =
    `⚠️ *ADVERTENCIAS*\n\n` +
    `Usuario: ${who}\n` +
    `Advertencias actuales: *${warnings}/${warnLimit}*\n\n` +
    `📋 Al alcanzar el límite se aplica la acción configurada para este grupo.`;

  const keyboard = new InlineKeyboard()
    .text("⚠️ Advertir", ModAction.warn(user.id))
    .text("🗑️ Quitar advertencia", ModAction.unwarn(user.id))
    .row()
    .text("📋 Ver advertencias", ModAction.viewWarnings(user.id))
    .text("🧹 Quitar todas", ModAction.unwarnAll(user.id))
    .row()
    .add(...buildNavRow().inline_keyboard.flat());

  return { text, keyboard };
}

/**
 * Menú para elegir la duración del silencio.
 */
export function buildMuteMenuPanel(user: ResolvedUser): Panel {
  const who = formatUserName(user);
  const text =
    `🔇 *SILENCIAR USUARIO*\n\n` +
    `Usuario: ${who}\n` +
    `ID: ${user.id}\n\n` +
    `Elige la duración del silencio:`;

  const MUTE_PRESETS: Array<{ label: string; minutes: number }> = [
    { label: "🔇 10 min", minutes: 10 },
    { label: "🔇 30 min", minutes: 30 },
    { label: "🔇 1 hora", minutes: 60 },
    { label: "🔇 6 horas", minutes: 360 },
    { label: "🔇 12 horas", minutes: 720 },
    { label: "🔇 24 horas", minutes: 1440 },
  ];

  const keyboard = new InlineKeyboard();
  for (let i = 0; i < MUTE_PRESETS.length; i += 1) {
    const preset = MUTE_PRESETS[i];
    keyboard.text(preset.label, ModAction.muteAt(user.id, preset.minutes));
    if (i % 2 === 1) {
      keyboard.row();
    }
  }
  if (MUTE_PRESETS.length % 2 !== 0) {
    keyboard.row();
  }
  keyboard
    .text("⚙️ Personalizado", ModAction.muteCustom(user.id))
    .text("⬅️ Atrás", ModAction.info(user.id));

  return { text, keyboard };
}

/**
 * Confirmación previa antes de banear.
 */
export function buildBanConfirmPanel(
  user: ResolvedUser,
  groupTitle?: string,
): Panel {
  const who = formatUserName(user);
  const textoGrupo = groupTitle
    ? `\n\n📍 Grupo: ${sanitizeGroupTitle(groupTitle)}`
    : "";

  const text =
    `🔨 *CONFIRMAR EXPULSIÓN*\n\n` +
    `Usuario: ${who}\n` +
    `ID: ${user.id}${textoGrupo}\n\n` +
    `Esta acción expulsará al usuario del grupo y no podrá volver hasta que lo desbanees.`;

  const keyboard = new InlineKeyboard()
    .text("🔨 Sí, banear", ModAction.ban(user.id))
    .text("❌ Cancelar", ModAction.info(user.id));

  return { text, keyboard };
}

/**
 * Menú para limpiar mensajes recientes.
 */
export function buildCleanupPanel(note?: string): Panel {
  const keyboard = new InlineKeyboard()
    .text("🧹 Últimos 10", ModAction.cleanup(10))
    .text("🧹 Últimos 25", ModAction.cleanup(25))
    .row()
    .text("🧹 Últimos 50", ModAction.cleanup(50))
    .text("🧹 Últimos 100", ModAction.cleanup(100))
    .row()
    .add(...buildNavRow().inline_keyboard.flat());

  const text =
    `🧹 *LIMPIAR MENSAJES*` +
    (note ? `\n\n${note}` : "") +
    `\n\nElige cuántos de los últimos mensajes que el bot puede localizar quieres eliminar:\n\n` +
    `ℹ️ Solo se borra lo que el bot ha registrado y Telegram permita (mensajes recientes).`;

  return { text, keyboard };
}

/**
 * Explica cómo borrar un mensaje concreto desde el grupo.
 */
export function buildDeleteHelpPanel(): Panel {
  const text =
    `🗑️ *BORRAR MENSAJE*\n\n` +
    `Para borrar un mensaje concreto del grupo:\n\n` +
    `1️⃣ En el grupo, responde al mensaje que quieres borrar.\n` +
    `2️⃣ Escribe:\n\n` +
    `   /borrar\n\n` +
    `El bot eliminará ese mensaje y también tu comando, dejando el grupo limpio.`;

  const keyboard = buildNavRow();
  return { text, keyboard };
}

/**
 * Lista de usuarios baneados registrados por el bot (para desbanear).
 */
export function buildUnbanListPanel(
  banned: IndexedUser[],
  groupTitle?: string,
): Panel {
  const textoGrupo = groupTitle
    ? `\n\nGrupo: ${sanitizeGroupTitle(groupTitle)}`
    : "";

  let list: string;
  if (banned.length === 0) {
    list = "No hay usuarios baneados registrados por el bot.";
  } else {
    list = banned
      .map(
        (user) =>
          `• ${user.name || `ID ${user.id}`}` +
          (user.username ? ` (@${user.username})` : "") +
          ` — [👤 Ver ficha]`,
      )
      .join("\n");
  }

  const text =
    `♻️ *DESBANEAR USUARIOS*${textoGrupo}\n\n${list}`;

  const keyboard = new InlineKeyboard();
  for (const user of banned) {
    keyboard.text(`👤 ${user.name || `ID ${user.id}`}`, ModAction.info(user.id));
    keyboard.row();
  }
  keyboard.add(...buildNavRow().inline_keyboard.flat());

  return { text, keyboard };
}

/**
 * Panel de confirmación para quitar todas las advertencias.
 */
export function buildUnwarnAllConfirmPanel(user: ResolvedUser): Panel {
  const who = formatUserName(user);
  const text =
    `🧹 *CONFIRMAR ELIMINACIÓN*\n\n` +
    `Usuario: ${who}\n` +
    `ID: ${user.id}\n\n` +
    `Esta acción eliminará TODAS las advertencias de este usuario.\n\n` +
    `¿Estás seguro?`;

  const keyboard = new InlineKeyboard()
    .text("✅ Sí, eliminar todas", ModAction.confirmUnwarnAll(user.id))
    .text("❌ Cancelar", ModAction.info(user.id));

  return { text, keyboard };
}

/**
 * Panel para ver todas las advertencias de un usuario.
 */
export function buildViewWarningsPanel(
  warnings: WarningEntry[],
  warnLimit: number,
  userName: string,
  userId: number,
): Panel {
  const history =
    warnings.length === 0
      ? "No hay advertencias registradas."
      : warnings
          .map(
            (warning, index) =>
              `${index + 1}. ${warning.date} — ${warning.adminName}` +
              (warning.reason ? `: ${warning.reason}` : ""),
          )
          .join("\n");
  const text =
    `📋 *HISTORIAL DE ADVERTENCIAS*\n\n` +
    `Usuario: ${userName}\n` +
    `ID: ${userId}\n\n` +
    `Advertencias actuales: *${warnings.length}/${warnLimit}*\n\n` +
    `${history}`;

  const keyboard = buildNavRow();
  return { text, keyboard };
}