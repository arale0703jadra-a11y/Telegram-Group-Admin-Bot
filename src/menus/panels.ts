import { InlineKeyboard } from "grammy";
import type { AdministrableGroup } from "../utils/groups.js";
import type { IndexedUser, WarningEntry } from "../storage/types.js";
import type { ResolvedUser, UserCardData } from "../utils/users.js";
import type { MyContext } from "../types.js";
import { getGroupData } from "../storage/index.js";

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
  { id: "usuarios", label: "👥 Usuarios" },
  { id: "filtros", label: "🚫 Filtros" },
  { id: "antispam", label: "🛡️ Anti-spam" },
  { id: "inactividad", label: "⏰ Inactividad" },
  { id: "limpieza", label: "👻 Limpieza" },
  { id: "actividad", label: "📊 Actividad" },
  { id: "reglas", label: "📜 Reglas" },
  { id: "bienvenida", label: "👋 Bienvenida" },
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
      { id: "ver", label: "📋 Ver filtros" },
      { id: "agregar", label: "➕ Agregar palabra/frase" },
      { id: "eliminar", label: "➖ Eliminar palabra/frase" },
      { id: "accion", label: "⚙️ Configurar acción" },
      { id: "activar", label: "🔔 Activar/desactivar filtros" },
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
    description: "Detección y limpieza de cuentas eliminadas y sin actividad.",
    items: [
      { id: "detectar", label: "👻 Detectar cuentas eliminadas" },
      { id: "limpiar", label: "🧹 Limpiar cuentas eliminadas" },
      { id: "auto", label: "⚙️ Configuración automática" },
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
  bienvenida: {
    icon: "👋",
    title: "Bienvenida",
    description: "Configura el mensaje de bienvenida del grupo.",
    items: [
      { id: "activar", label: "👋 Activar/desactivar" },
      { id: "editar", label: "✏️ Editar mensaje" },
      { id: "probar", label: "🧪 Probar bienvenida" },
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
    `🕐 Última actividad: ${lastSeen}`;

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