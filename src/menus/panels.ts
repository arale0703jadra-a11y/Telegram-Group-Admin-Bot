import { InlineKeyboard } from "grammy";
import type { AdministrableGroup } from "../utils/groups.js";
import {
  ILLEGAL_PROTECTED_CATEGORIES,
} from "../storage/initial.js";
import type {
  IllegalContentConfig,
  AntiSpamConfig,
  EmergencyConfig,
  CleanupConfig,
  AutomaticMessageConfig,
  InactivityConfig,
  IndexedUser,
  PromotionConfig,
  WarningEntry,
} from "../storage/types.js";
import type { ResolvedUser, UserCardData } from "../utils/users.js";
import type { MyContext } from "../types.js";
import { getGroupData } from "../storage/index.js";
import {
  BUYING_SIGNAL_EXAMPLES,
  SELLING_SIGNAL_EXAMPLES,
} from "../filters/detector.js";
import type { ActivityStats } from "../services/activity.js";
import type { VerifiedTagReview } from "../services/verified-tag-reviews.js";
import type {
  VerifiedUser,
  VerifiedUserPermissions,
} from "../services/verified-users.js";

export interface Panel {
  text: string;
  keyboard: InlineKeyboard;
}

/**
 * Esquema de callback_data del panel.
 *   menu:main / menu:home        -> panel principal
 *   menu:sub:<seccion>           -> abre un submenú
 *   menu:action:<seccion>:<id>   -> acción aún en desarrollo
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

export const EmergencyAction = {
  toggle: "ep:toggle",
  duration: "ep:duration",
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
  verifiedList: (page: number): string => `${FILTER_PREFIX}:verified_list:${page}`,
  verifiedMute: (userId: number): string => `${FILTER_PREFIX}:verified_mute:${userId}`,
  verifiedBan: (userId: number): string => `${FILTER_PREFIX}:verified_ban:${userId}`,
  verifiedRevoke: (userId: number): string => `${FILTER_PREFIX}:verified_revoke:${userId}`,
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

export const CleanupAction = {
  toggle: "cl:toggle",
};

export const AutomaticMessageAction = {
  home: "am:home",
  configure: "am:configure",
  toggle: "am:toggle",
  interval: "am:interval",
  sendNow: "am:send-now",
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
  /** Callback_data alternativo. Si no existe, se muestra "en desarrollo". */
  cb?: string;
}

/**
 * Categorías del panel principal, en el orden solicitado.
 */
const CATEGORIES: MenuItem[] = [
  { id: "proteccion", label: "🛡️ Centro de Protección" },
  { id: "verificadas", label: "👑 Verificadas", cb: FilterAction.verified },
  { id: "mensajes-recurrentes", label: "🔁 Mensajes Recurrentes", cb: AutomaticMessageAction.home },
  { id: "usuarios", label: "👥 Usuarios" },
  { id: "filtros", label: "🚫 Filtros" },
  { id: "antispam", label: "🛡️ Anti-spam" },
  { id: "inactividad", label: "⏰ Inactividad" },
  { id: "limpieza", label: "👻 Limpieza" },
  { id: "actividad", label: "📊 Actividad" },
  { id: "reglas", label: "📜 Reglas" },
  { id: "config", label: "⚙️ Configuración" },
  { id: "ayuda", label: "❓ Ayuda" },
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
      { id: "accion", label: "⚙️ Configurar acción" },
      { id: "activar", label: "🔔 Activar/desactivar filtros", cb: FilterAction.toggle },
      { id: "ilegal", label: "🔴 Filtro de contenido ilegal", cb: FilterAction.illegal },
    ],
  },
  antispam: {
    icon: "🛡️",
    title: "Anti-spam",
    description: "Protección contra spam, enlaces y flujo de mensajes.",
    items: [
      { id: "activar", label: "🛡️ Activar/desactivar" },
      { id: "sensibilidad", label: "⚙️ Configurar sensibilidad" },
      { id: "enlaces", label: "🔗 Control de enlaces" },
      { id: "repetidos", label: "📩 Control de mensajes repetidos" },
      { id: "flood", label: "⚡ Control de flood" },
    ],
  },
  inactividad: {
    icon: "⏰",
    title: "Inactividad",
    description: "Detecta y gestiona usuarios inactivos del grupo.",
    items: [
      { id: "activar", label: "⏰ Activar/desactivar" },
      { id: "periodo", label: "📅 Configurar período" },
      { id: "inactivos", label: "👥 Ver usuarios inactivos" },
      { id: "limpiar", label: "🧹 Limpiar inactivos" },
    ],
  },
  limpieza: {
    icon: "👻",
    title: "Limpieza",
    description: "Borra avisos de servicio automáticamente y purga mensajes recientes.",
    items: [
      { id: "configuracion", label: "⚙️ Configurar limpieza" },
    ],
  },
  actividad: {
    icon: "📊",
    title: "Actividad",
    description: "Estadísticas y registro de eventos del grupo.",
    items: [
      { id: "estadisticas", label: "📈 Estadísticas del grupo" },
      { id: "activos", label: "👥 Usuarios más activos" },
      { id: "mensajes", label: "📨 Mensajes registrados" },
      { id: "moderacion", label: "🛡️ Acciones de moderación" },
      { id: "eventos", label: "📋 Registro de eventos" },
    ],
  },
  reglas: {
    icon: "📜",
    title: "Reglas",
    description: "Gestiona las reglas publicadas del grupo.",
    items: [
      { id: "ver", label: "📜 Ver reglas" },
      { id: "editar", label: "✏️ Editar reglas" },
      { id: "publicar", label: "📌 Publicar reglas" },
      { id: "eliminar", label: "🗑️ Eliminar reglas" },
    ],
  },
  config: {
    icon: "⚙️",
    title: "Configuración",
    description: "Ajustes generales y avanzados del bot en este grupo.",
    items: [
      { id: "grupo", label: "🌐 Configuración del grupo" },
      { id: "moderacion", label: "🛡️ Configuración de moderación" },
      { id: "admins", label: "👥 Administradores" },
      { id: "notificaciones", label: "🔔 Notificaciones" },
      { id: "avanzado", label: "⚙️ Configuración avanzada" },
    ],
  },
  ayuda: {
    icon: "❓",
    title: "Ayuda",
    description: "Información sobre el panel y los permisos del bot.",
    items: [
      { id: "comandos", label: "📖 Ver comandos" },
      { id: "permisos", label: "🛡️ Sobre permisos" },
    ],
  },
};

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
    keyboard.text(category.label, category.cb ?? MenuAction.sub(category.id));
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

export function buildProtectionCenterPanel(
  emergency: EmergencyConfig,
  durationMinutes: number,
  groupTitle?: string,
): Panel {
  const active =
    emergency.active &&
    (emergency.expiresAt === undefined || emergency.expiresAt > Date.now());
  const expiry = active && emergency.expiresAt
    ? new Date(emergency.expiresAt).toLocaleString("es-ES")
    : undefined;
  const keyboard = new InlineKeyboard()
    .text(
      active ? "🔴 Desactivar modo de emergencia" : "🟢 Activar modo de emergencia",
      EmergencyAction.toggle,
    )
    .row()
    .text(`⏱️ Duración: ${durationMinutes} min`, EmergencyAction.duration)
    .row()
    .add(...buildNavRow().inline_keyboard.flat());

  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n` +
      "🛡️ *Centro de Protección Avanzada*\n\n" +
      `Modo de emergencia: *${active ? "ACTIVO" : "inactivo"}*\n` +
      (expiry ? `Caduca automáticamente: ${expiry}\n` : "") +
      `Duración configurable al activarlo: ${durationMinutes} minutos.\n\n` +
      "Durante una emergencia, los miembros con menos de 48 horas desde su ingreso " +
      "tendrán restringidos enlaces, invitaciones, stickers, GIFs y multimedia. Las restricciones " +
      "de Telegram caducan junto con el modo; la activación también se produce " +
      "automáticamente al detectar una oleada si Anti-Raid está habilitado.\n\n" +
      "ZEUS necesita permisos para restringir miembros y borrar mensajes para " +
      "aplicar todas las medidas.",
    keyboard,
  };
}

export function buildCleanupSettingsPanel(
  cleanup: CleanupConfig,
  groupTitle?: string,
  note?: string,
): Panel {
  const keyboard = new InlineKeyboard()
    .text(
      cleanup.autoDeleteServiceMessages
        ? "🔔 Auto-eliminación de avisos: activada"
        : "🔕 Auto-eliminación de avisos: desactivada",
      CleanupAction.toggle,
    )
    .row()
    .text("🧹 Purgar últimos 10", ModAction.cleanup(10))
    .text("🧹 Purgar últimos 25", ModAction.cleanup(25))
    .row()
    .text("🧹 Purgar últimos 50", ModAction.cleanup(50))
    .text("🧹 Purgar últimos 100", ModAction.cleanup(100))
    .row()
    .add(...buildNavRow().inline_keyboard.flat());

  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n` +
      "👻 *LIMPIEZA*\n\n" +
      "Los mensajes de servicio detectables (incorporaciones, salidas y otros avisos de Telegram) " +
      "se eliminan automáticamente cuando el bot tiene permiso.\n\n" +
      "La purga manual solo puede borrar los mensajes recientes que ZEUS haya registrado y que " +
      "Telegram todavía permita eliminar." +
      (note ? `\n\n${note}` : ""),
    keyboard,
  };
}

export function buildAutomaticMessagePanel(
  config: AutomaticMessageConfig | undefined,
  groupTitle?: string,
  note?: string,
): Panel {
  const enabled = config?.enabled === true;
  const intervalMinutes = config?.intervalMinutes ?? 60;
  const message = config?.message || "No hay mensaje configurado.";
  const preview = message.length > 300 ? `${message.slice(0, 297)}…` : message;
  const keyboard = new InlineKeyboard()
    .text(enabled ? "⏸️ Desactivar" : "▶️ Activar", AutomaticMessageAction.toggle)
    .text(`⏱️ Cada ${intervalMinutes} min`, AutomaticMessageAction.interval)
    .row()
    .text("✏️ Configurar texto", AutomaticMessageAction.configure)
    .text("📨 Enviar ahora", AutomaticMessageAction.sendNow)
    .row()
    .add(...buildNavRow().inline_keyboard.flat());
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n` +
      "🔁 *MENSAJES RECURRENTES*\n\n" +
      `Estado: *${enabled ? "activo" : "inactivo"}*\n` +
      `Intervalo: ${intervalMinutes} minutos\n` +
      `Mensaje: ${preview}` +
      (note ? `\n\n${note}` : ""),
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
  if (id === "ayuda") {
    return buildHelpPanel(groupTitle);
  }
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
  keyboard.add(...buildNavRow().inline_keyboard.flat());

  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n` +
      `📍 *Sección: ${def.icon} ${def.title}*\n\n` +
      `${def.description}\n\n` +
      "Selecciona una opción:",
    keyboard,
  };
}

function buildHelpPanel(groupTitle?: string): Panel {
  const keyboard = new InlineKeyboard()
    .text("🔐 Generar Recovery Key", MenuAction.action("ayuda", "generar-clave"))
    .row()
    .text("🔐 Recuperar System Owner", MenuAction.action("ayuda", "recuperar"))
    .row()
    .add(...buildNavRow().inline_keyboard.flat());
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n❓ *AYUDA Y COMANDOS*\n\n` +
      "🚨 Emergencias\n" +
      "La recuperación de System Owner solo debe usarse si perdiste el acceso a la cuenta propietaria.\n\n" +
      "🔐 Recovery Key: genera una clave de un solo uso con /zeus-generar-recuperacion.\n" +
      "🔐 Recuperar System Owner: envía /zeus-recuperar y luego la clave desde el chat privado del bot.\n\n" +
      "Para eliminar un mensaje responde a él con:\n   /borrar\n\n" +
      "/mute, /unmute, /ban, /unban y /kick no están implementados en el grupo.",
    keyboard,
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
    .text(enabled ? "🧠 Detección inteligente 🟢" : "🧠 Detección inteligente 🔴", FilterAction.toggle)
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
      "Analiza intención de compra y venta; solo bloquea ventas no verificadas.",
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
    .text("⬅️ Volver a promociones", FilterAction.home)
    .row()
    .add(...buildNavRow().inline_keyboard.flat());

  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n` +
      "⚙️ *CONFIGURACIÓN DE PROMOCIONES*\n\n" +
      "Las palabras personalizadas son señales contextuales, no reglas de venta por sí solas.\n" +
      `Señales contextuales configuradas: ${config.dictionary.length}`,
    keyboard,
  };
}

export function buildPromotionInfoPanel(
  section: "stats" | "buying" | "selling" | "links" | "verified",
  config: PromotionConfig,
  groupTitle?: string,
): Panel {
  const heading: Record<typeof section, string> = {
    stats: "📊 *ESTADÍSTICAS DE PROMOCIONES*",
    buying: "🛒 *SEÑALES DE COMPRA*",
    selling: "💰 *SEÑALES DE VENTA*",
    links: "🔗 *ANÁLISIS DE ENLACES*",
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
        `Promociones bloqueadas: ${stats.blocked}\n` +
        `SELLING permitido por verificación: ${stats.allowedVerified}\n\n` +
        "Los falsos positivos no tienen actualmente un mecanismo de reporte.";
      break;
    }
    case "buying":
      body =
        "Estas estructuras indican búsqueda o intención de compra y no se moderan:\n\n" +
        BUYING_SIGNAL_EXAMPLES.map((signal) => `• ${signal}`).join("\n");
      break;
    case "selling":
      body =
        "La venta requiere una acción de oferta propia y contexto de producto/servicio:\n\n" +
        SELLING_SIGNAL_EXAMPLES.map((signal) => `• ${signal}`).join("\n");
      break;
    case "links":
      body =
        "Los enlaces son una señal adicional y por sí solos no se eliminan por el detector de promociones.\n\n" +
        "Patrones reconocidos: http://, https://, www., t.me/ y telegram.me/.\n" +
        "Las capas independientes Anti-spam y contenido ilegal mantienen sus propias reglas.";
      break;
    case "verified": {
      const count = Object.values(config.verifiedUsers).filter(Boolean).length;
      body =
        `Verificadas reconocidas por la configuración actual del grupo: ${count}.\n\n` +
        "Una SELLING de una persona verificada se permite. BUYING, NEUTRAL y AMBIGUOUS se permiten independientemente de la verificación.";
      break;
    }
  }
  return {
    text: `${formatGroupHeader(groupTitle)}\n\n${heading[section]}\n\n${body}`,
    keyboard: new InlineKeyboard()
      .text("⬅️ Volver", FilterAction.home)
      .row()
      .add(...buildNavRow().inline_keyboard.flat()),
  };
}

export function buildVerifiedModelsPanel(
  users: VerifiedUser[],
  page = 0,
  groupTitle?: string,
  recognizedTags: string[] = [],
  tagDetectionEnabled = false,
): Panel {
  const pageSize = 5;
  const pageCount = Math.max(1, Math.ceil(users.length / pageSize));
  const currentPage = Math.max(0, Math.min(page, pageCount - 1));
  const pageUsers = users.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const keyboard = new InlineKeyboard();

  for (const user of pageUsers) {
    const userId = String(user.user_id);
    keyboard
      .text(`🔇 24 h · ${userId}`, FilterAction.verifiedMute(user.user_id))
      .text(`⛔ · ${userId}`, FilterAction.verifiedBan(user.user_id))
      .text(`❌ · ${userId}`, FilterAction.verifiedRevoke(user.user_id))
      .row();
  }

  if (pageCount > 1) {
    if (currentPage > 0) {
      keyboard.text("⬅️ Anterior", FilterAction.verifiedList(currentPage - 1));
    }
    keyboard.text(`${currentPage + 1}/${pageCount}`, FilterAction.verifiedList(currentPage));
    if (currentPage + 1 < pageCount) {
      keyboard.text("Siguiente ➡️", FilterAction.verifiedList(currentPage + 1));
    }
    keyboard.row();
  }
  keyboard
    .text(
      tagDetectionEnabled ? "🔴 Pausar detección" : "🟢 Activar detección",
      "cfg:verified_tags_toggle",
    )
    .text("✏️ Etiquetas", "vu:edit")
    .row()
    .text("⬅️ Volver a promociones", FilterAction.home)
    .row()
    .add(...buildNavRow().inline_keyboard.flat());

  const list = pageUsers.length
    ? pageUsers.map((user) => {
        const identity = user.display_name || (user.username ? `@${user.username}` : `ID ${user.user_id}`);
        return `• ${escapeLegacyMarkdown(identity)} — ID ${user.user_id}`;
      }).join("\n")
    : "No hay usuarias verificadas activas en este grupo.";

  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n👑 *VERIFICADAS*\n\n` +
      `Detección de marcas: ${tagDetectionEnabled ? "activa" : "inactiva"}\n` +
      `Marcas configuradas: ${recognizedTags.join(", ") || "ninguna"}\n\n` +
      `${list}\n\n` +
      "🔇 Silenciar durante 24 horas · ⛔ Banear · ❌ Quitar verificación" +
      (pageCount > 1 ? `\n\nPágina ${currentPage + 1} de ${pageCount}` : ""),
    keyboard,
  };
}

function escapeLegacyMarkdown(value: string): string {
  return value.replace(/([_*`\[\]\\])/g, "\\$1");
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
      `Candidatos manuales: ${config.customDays ?? config.inactivityDays} días\n` +
      `Depuración automática: ${config.enabled ? "21 días, diaria" : "desactivada"}`,
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
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n` +
      `👥 *USUARIOS*\n\n` +
      `Usuarios detectados (página ${currentPage + 1}/${pageCount}):\n${list}`,
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

export function buildActivityPanel(
  stats: ActivityStats,
  groupTitle?: string,
): Panel {
  const keyboard = new InlineKeyboard()
    .text("🔄 Actualizar", MenuAction.action("actividad", "actualizar"))
    .row()
    .add(...buildNavRow().inline_keyboard.flat());
  const topUsers = stats.topUsers.length
    ? stats.topUsers
        .slice(0, 5)
        .map((user, index) => `${index + 1}. ${user.name} — ${user.count}`)
        .join("\n")
    : "Sin actividad registrada.";
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n📊 *RESUMEN DE ACTIVIDAD*\n\n` +
      `Mensajes registrados: ${stats.totalMessages.toLocaleString("es-ES")}\n` +
      `Usuarios activos: ${stats.activeUsers.toLocaleString("es-ES")}\n` +
      `Mensajes hoy: ${stats.messagesToday.toLocaleString("es-ES")}\n` +
      `Últimos 7 días: ${stats.messagesLast7Days.toLocaleString("es-ES")}\n` +
      `Últimos 30 días: ${stats.messagesLast30Days.toLocaleString("es-ES")}\n\n` +
      `Usuarios más activos:\n${topUsers}\n\n` +
      "Se conservan como máximo 10.000 mensajes por grupo. Estas estadísticas " +
      "No representan el historial completo del grupo.",
    keyboard,
  };
}

export function buildActivityUnavailablePanel(groupTitle?: string): Panel {
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n⚠️ *Datos de actividad no disponibles*\n\n` +
      "No se muestran estadísticas porque no se pudieron leer los datos locales del grupo.",
    keyboard: new InlineKeyboard()
      .text("🔄 Reintentar", MenuAction.action("actividad", "actualizar"))
      .row()
      .add(...buildNavRow().inline_keyboard.flat()),
  };
}

export const VerifiedAction = {
  revokeConfirm: (userId: number): string => `vu:revoke-confirm:${userId}`,
  revokeApply: (userId: number): string => `vu:revoke:${userId}`,
  reactivateConfirm: (userId: number, permissions: string): string =>
    `vu:reactivate-confirm:${userId}:${permissions}`,
  reactivateApply: (userId: number, permissions: string): string =>
    `vu:reactivate:${userId}:${permissions}`,
  permissionConfirm: (
    userId: number,
    permission: keyof VerifiedUserPermissions,
    value: boolean,
  ): string => `vu:permission-confirm:${userId}:${permission}:${value}`,
  permissionApply: (
    userId: number,
    permission: keyof VerifiedUserPermissions,
    value: boolean,
    expectedValue: boolean,
  ): string =>
    `vu:permission:${userId}:${permission}:${value}:${expectedValue}`,
  toggle: (
    userId: number,
    permission: keyof VerifiedUserPermissions,
  ): string => `vu:toggle:${userId}:${permission}`,
}

export function buildVerifiedLoadErrorPanel(groupTitle?: string): Panel {
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n👑 *VERIFICADAS*\n\n` +
      "No se pudo cargar la lista ahora. Inténtalo de nuevo en unos segundos.",
    keyboard: new InlineKeyboard()
      .text("🔄 Reintentar", FilterAction.verified)
      .row()
      .add(...buildNavRow().inline_keyboard.flat()),
  };
}

export function verifiedPermissionsSnapshot(
  permissions: VerifiedUserPermissions,
): string {
  return [
    permissions.can_post,
    permissions.can_send_media,
    permissions.can_send_links,
    permissions.bypass_antispam,
    permissions.bypass_promotion_filter,
    permissions.bypass_illegal_filter,
    permissions.bypass_automatic_deletion,
  ].map(Number).join("");
}

export interface VerifiedUserPanelHistory {
  groupId: number;
  currentUsername?: string;
  muteState?: string;
  banState?: string;
  warnings?: Array<{ date: string; reason?: string; revokedAt: string | null }>;
  events?: Array<{ eventType: string; createdAt: string; details: Record<string, unknown> }>;
  commands?: Array<{
    action: string;
    created_at: string;
    resultState: string;
    last_error: string | null;
  }>;
}

const VERIFIED_PERMISSION_LABELS: Record<keyof VerifiedUserPermissions, string> = {
  can_post: "Publicaciones",
  can_send_media: "Envío de multimedia",
  can_send_links: "Enlaces ordinarios",
  bypass_antispam: "Exención de anti-spam",
  bypass_promotion_filter: "Libertad promocional",
  bypass_illegal_filter: "Exención de filtro de contenido ilegal",
  bypass_automatic_deletion: "Exención de eliminación automática",
};

function escapeMarkdownV2(value: string): string {
  return value.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

export function buildVerifiedUserPanel(
  user: VerifiedUser,
  groupTitle: string | undefined,
  telegramStatus: string,
  history?: VerifiedUserPanelHistory,
): Panel {
  const identity = history?.currentUsername
    ? `@${escapeMarkdownV2(history.currentUsername)}`
    : user.display_name ?? user.username ?? `ID ${user.user_id}`;
  const memberStatus: Record<string, string> = {
    member: "👤 Miembro; En el grupo",
    administrator: "🛡️ Administrador; En el grupo",
    creator: "👑 Creador; En el grupo",
    restricted: "⚠️ Restringido",
    left: "🚪 Fuera del grupo",
    kicked: "⛔ Expulsado",
    unknown: "❔ Desconocido",
  };
  const permissionLines = Object.entries(VERIFIED_PERMISSION_LABELS)
    .map(([key, label]) => {
      const enabled = user.permissions[key as keyof VerifiedUserPermissions];
      const fixed = key === "can_send_links" || key === "bypass_promotion_filter";
      if (fixed) {
        if (key === "bypass_promotion_filter") {
          return `${label} ${enabled ? "✅" : "❌"} fija`;
        }
        return `${label} ${enabled ? "✅" : "❌"} (no aplicado como permiso independiente)`;
      }
      return `${label}: ${enabled ? "✅ activado" : "❌ desactivado"}`;
    });
  const details = [
    history?.muteState,
    history?.banState,
    ...(history?.warnings ?? []).map(
      (warning) => `Advertencia ${warning.date}${warning.reason ? `: ${warning.reason}` : ""}`,
    ),
    ...(history?.events ?? []).map(
    (event) => `Evento ${escapeMarkdownV2(event.eventType)} (${event.createdAt})`,
    ),
    ...(history?.commands ?? []).map(
      (command) => `Orden ${command.action} [${command.resultState}]` +
        (command.last_error ? `: ${command.last_error}` : ""),
    ),
  ].filter((line): line is string => Boolean(line));
  const keyboard = new InlineKeyboard();
  if (user.verified && user.revoked_at === null) {
    keyboard.text("⛔ Revocar verificación", VerifiedAction.revokeConfirm(user.user_id));
  } else {
    keyboard.text(
      "♻️ Reactivar verificación",
      VerifiedAction.reactivateConfirm(
        user.user_id,
        verifiedPermissionsSnapshot(user.permissions),
      ),
    );
  }
  keyboard.row().add(...buildNavRow().inline_keyboard.flat());
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n👑 *PERFIL VERIFICADO*\n\n` +
      `Usuario: ${identity}\nID: ${user.user_id}\n` +
      (history ? `Grupo ID: ${history.groupId}\n` : "") +
      `Estado Telegram: ${memberStatus[telegramStatus] ?? memberStatus.unknown}\n\n` +
      `${permissionLines.join("\n")}\n\n` +
      (details.length ? `Historial disponible:\n${details.join("\n")}` : "Sin historial adicional disponible."),
    keyboard,
  };
}

export function buildVerifiedActionConfirmPanel(
  user: VerifiedUser,
  action: "revoke" | "reactivate",
  groupTitle?: string,
): Panel {
  const reactivating = action === "reactivate";
  const snapshot = verifiedPermissionsSnapshot(user.permissions);
  const keyboard = new InlineKeyboard().text(
    "✅ Confirmar",
    reactivating
      ? VerifiedAction.reactivateApply(user.user_id, snapshot)
      : VerifiedAction.revokeApply(user.user_id),
  ).text("❌ Cancelar", `vu:user:${user.user_id}`);
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n⚠️ *CONFIRMAR ${reactivating ? "REACTIVACIÓN" : "REVOCACIÓN"}*\n\n` +
      `Usuario ID: ${user.user_id}\n` +
      (reactivating
        ? `Permisos conservados: ${Object.entries(user.permissions).map(([key, value]) => `${key}=${value ? "sí" : "no"}`).join(", ")}.\n\n` +
          "La acción reactivará el perfil; las sanciones no se eliminarán."
        : "El perfil dejará de estar verificado."),
    keyboard,
  };
}

export function buildVerifiedPermissionConfirmPanel(
  user: VerifiedUser,
  permission: keyof VerifiedUserPermissions,
  value: boolean,
  groupTitle?: string,
): Panel {
  const keyboard = new InlineKeyboard()
    .text(
      "✅ Confirmar",
      VerifiedAction.permissionApply(
        user.user_id,
        permission,
        value,
        user.permissions[permission],
      ),
    )
    .text("❌ Cancelar", `vu:user:${user.user_id}`);
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n⚙️ *CONFIRMAR CAMBIO DE PERMISO*\n\n` +
      `Usuario ID: ${user.user_id}\n${VERIFIED_PERMISSION_LABELS[permission]}\n` +
      `Nuevo estado: ${value ? "activado" : "desactivado"}`,
    keyboard,
  };
}

export function buildRevokedVerifiedUsersPanel(
  users: VerifiedUser[],
  groupTitle: string | undefined,
  page: number,
): Panel {
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(users.length / pageSize));
  const current = Math.min(Math.max(0, page), pageCount - 1);
  const visible = users.slice(current * pageSize, (current + 1) * pageSize);
  const keyboard = new InlineKeyboard();
  for (const user of visible) {
    keyboard
      .text(
        `♻️ ${user.display_name ?? user.username ?? `ID ${user.user_id}`}`,
        VerifiedAction.reactivateConfirm(
          user.user_id,
          verifiedPermissionsSnapshot(user.permissions),
        ),
      )
      .row();
  }
  if (current > 0) keyboard.text("◀️ Anterior", `vu:revoked-list:${current - 1}`);
  if (current < pageCount - 1) keyboard.text("Siguiente ▶️", `vu:revoked-list:${current + 1}`);
  keyboard.row().text("⬅️ Volver", `vu:list`);
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n📋 *VERIFICACIONES REVOCADAS*\n\n` +
      `Página ${current + 1} de ${pageCount}\n` +
      (visible.length
        ? visible.map((user) => `• ${user.display_name ?? user.username ?? `ID ${user.user_id}`} — ID ${user.user_id}`).join("\n")
        : "No hay verificaciones revocadas."),
    keyboard,
  };
}

export function buildVerifiedTagCandidatesPanel(
  reviews: VerifiedTagReview[],
  page: number,
  groupTitle?: string,
): Panel {
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(reviews.length / pageSize));
  const current = Math.min(Math.max(0, page), pageCount - 1);
  const visible = reviews.slice(current * pageSize, (current + 1) * pageSize);
  const keyboard = new InlineKeyboard();
  for (const review of visible) {
    const name = review.display_name ?? review.username ?? `ID ${review.user_id}`;
    keyboard.text(`👤 ${name}`, `vu:review:${review.user_id}`).row();
    if (review.status === "pending") {
      keyboard
        .text("✅ Aprobar", `vu:review:approve:${review.user_id}`)
        .text("❌ Rechazar", `vu:review:reject:${review.user_id}`)
        .row();
    } else if (review.status === "revoked_tag") {
      keyboard
        .text("♻️ Revisar reactivación", `vu:review:approve:${review.user_id}`)
        .text("❌ Rechazar", `vu:review:reject:${review.user_id}`)
        .row();
    }
  }
  if (current > 0) keyboard.text("◀️ Anterior", `vu:review-list:${current - 1}`);
  if (current < pageCount - 1) keyboard.text("Siguiente ▶️", `vu:review-list:${current + 1}`);
  keyboard.row().text("⬅️ Volver", FilterAction.verified);
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n🧾 *REVISIÓN DE ETIQUETAS VERIFICADAS*\n\n` +
      (visible.length
        ? visible.map((review) =>
            `• ${review.display_name ?? review.username ?? `ID ${review.user_id}`} — ` +
            `${review.status}; etiqueta: ${review.observed_tag ?? "ninguna"}`,
          ).join("\n")
        : "No hay candidatas ni discrepancias."),
    keyboard,
  };
}

export function buildVerifiedTagReviewConfirmPanel(
  review: VerifiedTagReview,
  action: "approve" | "reject",
  groupTitle?: string,
): Panel {
  const message = action === "approve"
    ? review.status === "revoked_tag"
      ? "Para reactivar esta verificación, ZEUS volverá a comprobar que la etiqueta nativa actual de Telegram coincide con la configuración."
      : "La aprobación manual activará la verificación después de confirmar que la cuenta sigue en el grupo."
    : "La candidata será rechazada y la coincidencia observada no concederá permisos.";
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n⚠️ *CONFIRMAR REVISIÓN*\n\n` +
      `Usuario: ${review.display_name ?? review.username ?? `ID ${review.user_id}`}\n` +
      `ID: ${review.user_id}\nEstado: ${review.status}\n` +
      `Señal observada: ${review.observed_tag ?? "ninguna"}\n\n${message}`,
    keyboard: new InlineKeyboard()
      .text(
        "✅ Confirmar",
        `vu:apply:${action}:${review.user_id}`,
      )
      .text("❌ Cancelar", "vu:candidates:0"),
  };
}

export function buildVerifiedTitleConfigPanel(
  recognizedTitles: string[],
  autoDetectTitles: boolean,
  titleSyncEnabled: boolean,
  groupTitle: string | undefined,
  recognizedTags: string[],
  tagSyncEnabled: boolean,
  candidateCount: number,
): Panel {
  return {
    text:
      `${formatGroupHeader(groupTitle)}\n\n👑 *ETIQUETAS DE VERIFICACIÓN*\n\n` +
      `Detección por etiquetas: ${tagSyncEnabled ? "activada" : "desactivada"}\n` +
      `Sincronización de títulos de administradores: ${titleSyncEnabled ? "activada" : "desactivada"}\n` +
      `Detección automática de títulos: ${autoDetectTitles ? "activada" : "desactivada"}\n` +
      `Títulos reconocidos: ${recognizedTitles.join(", ") || "ninguno"}\n` +
      `Etiquetas reconocidas: ${recognizedTags.join(", ") || "ninguna"}\n` +
      `Candidatas pendientes: ${candidateCount}\n\n` +
      "ZEUS compara estas etiquetas con mensajes, captions y nombre/usuario visibles. " +
      "Las biografías no están disponibles mediante Bot API. Una coincidencia solo crea una candidata; " +
      "la aprobación manual confirma la membresía y concede permisos.",
    keyboard: new InlineKeyboard()
      .text(
        tagSyncEnabled ? "🔴 Desactivar detección" : "🟢 Activar detección",
        "cfg:verified_tags_toggle",
      )
      .row()
      .text("✏️ Editar etiquetas", "vu:edit")
      .text("🧾 Revisar candidatas", "vu:candidates:0")
      .row()
      .text("👑 Verificadas actuales", FilterAction.verifiedList(0))
      .row()
      .add(...buildNavRow().inline_keyboard.flat()),
  };
}