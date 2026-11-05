import { InlineKeyboard } from "grammy";
import {
  AfroditaBridgeUnavailableError,
  enqueueAfroditaGlobalCommand,
  enqueueAfroditaCommand,
  getAfroditaGlobalControl,
  getLatestAfroditaGlobalCommand,
  getAfroditaState,
  listAfroditaEvents,
  listAfroditaStates,
  type AfroditaEventRow,
  type AfroditaGlobalCommand,
  type AfroditaGlobalControlRow,
  type AfroditaStateRow,
} from "../services/afrodita-bridge.js";
import { isEffectiveOwner } from "../services/system-owner.js";
import type { MyContext } from "../types.js";
import { renderPanel } from "./render.js";
import { MenuAction, type Panel } from "./panels.js";

/**
 * Sección 🌸 AFRODITA del panel privado de ZEUS.
 *
 * Panel centralizado de administración de AFRODITA: resumen, publicaciones,
 * encuestas, menciones, grupos, programación, historial y configuración.
 * Toda operación de escritura comprueba la propiedad (isEffectiveOwner) en el
 * backend antes de encolar la orden hacia AFRODITA vía Supabase.
 */

export const AFRODITA_SECTION = "afrodita";

const NO_GROUP_TEXT =
  "Primero selecciona el grupo que quieres administrar con el botón " +
  "«🔄 Cambiar grupo» del panel principal.";

const CATEGORY_LABELS: Record<string, string> = {
  verified_promotion: "Promociones verificadas",
  commercial_poll: "Encuestas comerciales",
  seasonal_campaign: "Campañas estacionales",
  community_reply: "Respuestas comunitarias",
};

const PAGE_SIZE_GROUPS = 6;
const PAGE_SIZE_EVENTS = 8;
const PAGE_SIZE_SCHEDULE = 3;

interface SnapshotSettings {
  enabled?: boolean;
  scheduledEnabled?: boolean;
  activityEnabled?: boolean;
  scheduleTimes?: string[];
  maxPerDay?: number;
  minIntervalMs?: number;
  publishedToday?: number;
  lastPublishedAt?: number;
  history?: { id?: string; at?: number; status?: string }[];
}

export interface AfroditaSnapshot {
  enabled?: boolean;
  activityPaused?: boolean;
  timeZone?: string;
  quietUntil?: number;
  messageCount?: number;
  pollCount?: number;
  lastPollTopic?: string;
  lastPollAt?: number;
  pollVotes?: Record<string, number>;
  replyTopicCounts?: Record<string, number>;
  commercialRequests?: Record<string, number>;
  usefulReplies?: number;
  messagesSincePromotion?: number;
  recentPromotedUserIds?: unknown[];
  authorizedProfiles?: Record<string, unknown>;
  publications?: Record<string, SnapshotSettings>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 200 ? value : undefined;
}

function asCountMap(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (!record) return {};
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record)) {
    const count = asNumber(entry);
    if (count !== undefined) result[key] = count;
  }
  return result;
}

/** Convierte la fila de Supabase en un snapshot defensivo. */
export function snapshotFromRow(row: AfroditaStateRow): AfroditaSnapshot {
  const state = asRecord(row.state) ?? {};
  const publications: Record<string, SnapshotSettings> = {};
  const rawPublications = asRecord(state.publications);
  if (rawPublications) {
    for (const [category, raw] of Object.entries(rawPublications)) {
      const settings = asRecord(raw);
      if (!settings) continue;
      const rawTimes = Array.isArray(settings.scheduleTimes)
        ? settings.scheduleTimes
        : [];
      const rawHistory = Array.isArray(settings.history)
        ? settings.history
        : [];
      const maxPerDay = asNumber(settings.maxPerDay);
      const minIntervalMs = asNumber(settings.minIntervalMs);
      const publishedToday = asNumber(settings.publishedToday);
      const lastPublishedAt = asNumber(settings.lastPublishedAt);
      publications[category] = {
        ...(typeof settings.enabled === "boolean"
          ? { enabled: settings.enabled }
          : {}),
        ...(typeof settings.scheduledEnabled === "boolean"
          ? { scheduledEnabled: settings.scheduledEnabled }
          : {}),
        ...(typeof settings.activityEnabled === "boolean"
          ? { activityEnabled: settings.activityEnabled }
          : {}),
        scheduleTimes: rawTimes.filter(
          (time): time is string => typeof time === "string",
        ),
        ...(maxPerDay !== undefined ? { maxPerDay } : {}),
        ...(minIntervalMs !== undefined ? { minIntervalMs } : {}),
        ...(publishedToday !== undefined ? { publishedToday } : {}),
        ...(lastPublishedAt !== undefined ? { lastPublishedAt } : {}),
        history: rawHistory.flatMap((entry) => {
          const historyEntry = asRecord(entry);
          if (!historyEntry) return [];
          const id = asString(historyEntry.id);
          const at = asNumber(historyEntry.at);
          if (id === undefined || at === undefined) return [];
          const status = asString(historyEntry.status);
          return [{ id, at, ...(status !== undefined ? { status } : {}) }];
        }),
      };
    }
  }
  const enabled = typeof state.enabled === "boolean" ? state.enabled : undefined;
  const activityPaused =
    typeof state.activityPaused === "boolean" ? state.activityPaused : undefined;
  const timeZone = asString(state.timeZone);
  const quietUntil = asNumber(state.quietUntil);
  const messageCount = asNumber(state.messageCount);
  const pollCount = asNumber(state.pollCount);
  const lastPollTopic = asString(state.lastPollTopic);
  const lastPollAt = asNumber(state.lastPollAt);
  const usefulReplies = asNumber(state.usefulReplies);
  const messagesSincePromotion = asNumber(state.messagesSincePromotion);
  const authorizedProfiles = asRecord(state.authorizedProfiles);
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(activityPaused !== undefined ? { activityPaused } : {}),
    ...(timeZone !== undefined ? { timeZone } : {}),
    ...(quietUntil !== undefined ? { quietUntil } : {}),
    ...(messageCount !== undefined ? { messageCount } : {}),
    ...(pollCount !== undefined ? { pollCount } : {}),
    ...(lastPollTopic !== undefined ? { lastPollTopic } : {}),
    ...(lastPollAt !== undefined ? { lastPollAt } : {}),
    pollVotes: asCountMap(state.pollVotes),
    replyTopicCounts: asCountMap(state.replyTopicCounts),
    commercialRequests: asCountMap(state.commercialRequests),
    ...(usefulReplies !== undefined ? { usefulReplies } : {}),
    ...(messagesSincePromotion !== undefined ? { messagesSincePromotion } : {}),
    ...(Array.isArray(state.recentPromotedUserIds)
      ? { recentPromotedUserIds: state.recentPromotedUserIds }
      : {}),
    ...(authorizedProfiles ? { authorizedProfiles } : {}),
    publications,
  };
}

/** Elimina caracteres que rompen Markdown y limita la longitud. */
function clean(value: string, maxLength = 60): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/[_*[\]()~`>#+\-=|{}.!]/gu, "")
    .slice(0, maxLength);
}

function formatTimestamp(value: number | string | undefined): string {
  if (value === undefined) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleString("es-ES", { timeZone: "UTC" }) + " UTC";
}

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? clean(category, 40);
}

function yesNo(value: boolean | undefined): string {
  return value ? "🟢 sí" : "🔴 no";
}

/** Callbacks de la sección (prefijo único `menu:*` para el router). */
export const AfroditaAction = {
  home: MenuAction.sub(AFRODITA_SECTION),
  view: (view: string, page?: number): string =>
    page === undefined
      ? MenuAction.action(AFRODITA_SECTION, view)
      : MenuAction.action(AFRODITA_SECTION, `${view}:${page}`),
  ask: (id: string): string => MenuAction.action(AFRODITA_SECTION, `ask:${id}`),
  do: (id: string): string => MenuAction.action(AFRODITA_SECTION, `do:${id}`),
};

/** ¿Pertenece este callback a la sección AFRODITA? */
export function isAfroditaPanelAction(action: {
  kind?: string;
  section?: string;
  item?: string;
}): boolean {
  return (
    (action.kind === "sub" || action.kind === "action") &&
    action.section === AFRODITA_SECTION
  );
}

function buildNavRow(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⬅️ Volver", AfroditaAction.home)
    .text("🏠 Inicio", MenuAction.main);
}

function sectionHeader(title: string, groupTitle?: string): string {
  const header = `🌸 *AFRODITA — ${title}*`;
  return groupTitle
    ? `${header}\nGrupo: ${clean(groupTitle)}`
    : header;
}

function noStatePanel(groupTitle?: string): Panel {
  return {
    text:
      `${sectionHeader("SIN DATOS", groupTitle)}\n\n` +
      "AFRODITA aún no ha publicado el estado de este grupo en Supabase. " +
      "Se sincroniza automáticamente cada minuto mientras AFRODITA esté activa.",
    keyboard: buildNavRow(),
  };
}

/**1. Resumen general de la integración. */
export function buildAfroditaSummaryPanel(
  input: {
    rows: AfroditaStateRow[];
    selectedState?: AfroditaStateRow;
    groupTitle?: string;
    control?: AfroditaGlobalControlRow;
    latestCommand?: AfroditaGlobalCommand;
  },
): Panel {
  const { rows, selectedState, groupTitle, control, latestCommand } = input;
  const latest = rows[0];
  const snapshot = selectedState ? snapshotFromRow(selectedState) : undefined;
  const pending = latestCommand?.status === "pending";
  const running = control?.mode === "running";
  const lines = [
    sectionHeader("RESUMEN", groupTitle),
    "",
    `Estado general: ${pending ? "🟡 PROCESANDO" : running ? "🟢 ACTIVA" : "🔴 PAUSADA"}`,
  ];
  if (pending) {
    lines.push(
      `Orden de ${latestCommand.command === "pause" ? "pausa" : "reanudación"} pendiente. Esperando confirmación de AFRODITA.`,
    );
  } else if (!running) {
    lines.push("Todas las actividades automáticas están detenidas.");
  }
  if (latestCommand?.status === "failed") {
    lines.push(
      `La última orden falló: ${clean((latestCommand.last_error ?? "error no informado").replace(/_/gu, " "), 100)}.`,
    );
  }
  lines.push(
    `Grupos sincronizados: ${rows.length}`,
    `Última sincronización global: ${formatTimestamp(latest?.updated_at)}`,
    `Último heartbeat de AFRODITA: ${formatTimestamp(control?.heartbeat_at)}`,
  );
  if (selectedState && snapshot) {
    lines.push(
      "",
      `Estado del grupo: ${snapshot.enabled ? "🟢 activa" : "🔴 pausada"}` +
        `${snapshot.activityPaused ? " (pausa de actividad)" : ""}`,
      `Zona horaria: ${clean(snapshot.timeZone ?? "UTC", 40)}`,
      `Mensajes observados: ${snapshot.messageCount ?? 0}`,
      `Encuestas publicadas: ${snapshot.pollCount ?? 0}`,
      `Perfiles autorizados: ${Object.keys(snapshot.authorizedProfiles ?? {}).length}`,
      `Estado de la instantánea: ${formatTimestamp(selectedState.updated_at)}`,
    );
  } else {
    lines.push(
      "",
      "Este grupo aún no tiene instantánea de AFRODITA en Supabase.",
    );
  }
  const keyboard = new InlineKeyboard();
  if (pending) {
    keyboard.text("⏳ Procesando · Actualizar", AfroditaAction.view("resumen")).row();
  } else {
    keyboard
      .text(
        running ? "⏸️ PAUSAR AFRODITA" : "▶️ REANUDAR AFRODITA",
        AfroditaAction.ask(running ? "global-pause" : "global-resume"),
      )
      .row();
  }
  keyboard
    .text("📰 Publicaciones", AfroditaAction.view("publicaciones"))
    .row()
    .text("📊 Encuestas", AfroditaAction.view("encuestas"))
    .row()
    .text("💬 Menciones", AfroditaAction.view("menciones"))
    .row()
    .text("👥 Grupos", AfroditaAction.view("grupos"))
    .row()
    .text("🗓️ Programación", AfroditaAction.view("programacion"))
    .row()
    .text("🕘 Historial", AfroditaAction.view("historial"))
    .row()
    .text("⚙️ Configuración", AfroditaAction.view("configuracion"))
    .row()
    .text("🔄 Actualizar", AfroditaAction.home)
    .text("🏠 Inicio", MenuAction.main);
  return { text: `${lines.join("\n")}`, keyboard };
}

/** 2. Publicaciones: categorías + recientes. */
export function buildAfroditaPublicationsPanel(
  input: { snapshot: AfroditaSnapshot; groupTitle?: string; page: number },
): Panel {
  const { snapshot, groupTitle, page } = input;
  const categories = Object.keys(snapshot.publications ?? {});
  const pageSize = PAGE_SIZE_EVENTS;
  // Las 4 categorías de ajustes siempre caben; la paginación aplica al
  // historial reciente de publicaciones.
  const allHistory = categories.flatMap((category) =>
    (snapshot.publications?.[category]?.history ?? []).map((entry) => ({
      category,
      ...entry,
    })),
  ).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const historyPage = Math.min(page, Math.max(0, Math.ceil(allHistory.length / pageSize) - 1));
  const pageHistory = allHistory.slice(historyPage * pageSize, historyPage * pageSize + pageSize);
  const lines = [sectionHeader("PUBLICACIONES", groupTitle), ""];
  if (categories.length === 0) {
    lines.push("Sin datos de categorías todavía.");
  }
  for (const category of categories) {
    const settings = snapshot.publications?.[category] ?? {};
    lines.push(
      `*${clean(categoryLabel(category), 40)}*`,
      `Activa: ${yesNo(settings.enabled)} · Programación: ${yesNo(settings.scheduledEnabled)}`,
      `Hoy: ${settings.publishedToday ?? 0}/${settings.maxPerDay ?? "—"} · ` +
        `Horarios: ${(settings.scheduleTimes ?? []).join(", ") || "sin programación"}`,
      `Última: ${formatTimestamp(settings.lastPublishedAt)}`,
      "",
    );
  }
  lines.push("*Recientes:*");
  if (pageHistory.length === 0) {
    lines.push("Sin publicaciones registradas en la instantánea.");
  }
  for (const entry of pageHistory) {
    lines.push(
      `• ${formatTimestamp(entry.at)} — ${clean(categoryLabel(entry.category), 32)} — ${clean(entry.status ?? "—", 20)}`,
    );
  }
  const keyboard = new InlineKeyboard();
  if (historyPage > 0) {
    keyboard.text("⬅️ Anterior", AfroditaAction.view("publicaciones", historyPage - 1));
  }
  if ((historyPage + 1) * pageSize < allHistory.length) {
    keyboard.text("Siguiente ➡️", AfroditaAction.view("publicaciones", historyPage + 1));
  }
  keyboard
    .row()
    .text("🔄 Actualizar", AfroditaAction.view("publicaciones", historyPage))
    .row()
    .text("⬅️ Volver", AfroditaAction.home)
    .text("🏠 Inicio", MenuAction.main);
  return { text: lines.join("\n"), keyboard };
}

/** 3. Encuestas: votos agregados y últimas encuestas. */
export function buildAfroditaPollsPanel(
  input: {
    snapshot: AfroditaSnapshot;
    groupTitle?: string;
    recentPolls: AfroditaEventRow[];
    hasMore: boolean;
    page: number;
  },
): Panel {
  const { snapshot, groupTitle, recentPolls, hasMore, page } = input;
  const votes = snapshot.pollVotes ?? {};
  const totalVotes = Object.values(votes).reduce((sum, value) => sum + value, 0);
  const lines = [
    sectionHeader("ENCUESTAS", groupTitle),
    "",
    `Encuestas publicadas: ${snapshot.pollCount ?? 0}`,
    `Votos agregados: ${totalVotes}`,
    `Último tema: ${clean(snapshot.lastPollTopic || "—", 30)}`,
    `Última encuesta: ${formatTimestamp(snapshot.lastPollAt)}`,
    "",
    "*Votos por tema:*",
  ];
  const topics = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  if (topics.length === 0) lines.push("Sin votos registrados.");
  for (const [topic, count] of topics) {
    lines.push(`• ${clean(topic, 30)}: ${count}`);
  }
  lines.push("", "*Últimas encuestas:*");
  if (recentPolls.length === 0) lines.push("Sin eventos de encuesta aún.");
  for (const event of recentPolls) {
    const payload = event.payload ?? {};
    const count = typeof payload.pollCount === "number" ? payload.pollCount : "?";
    const topic = typeof payload.lastPollTopic === "string"
      ? payload.lastPollTopic
      : "—";
    lines.push(
      `• ${formatTimestamp(event.created_at)} — #${count} — ${clean(topic, 30)}`,
    );
  }
  const keyboard = new InlineKeyboard();
  if (page > 0) keyboard.text("⬅️ Anterior", AfroditaAction.view("encuestas", page - 1));
  if (hasMore) keyboard.text("Siguiente ➡️", AfroditaAction.view("encuestas", page + 1));
  keyboard
    .row()
    .text("🔄 Actualizar", AfroditaAction.view("encuestas", page))
    .row()
    .text("⬅️ Volver", AfroditaAction.home)
    .text("🏠 Inicio", MenuAction.main);
  return { text: lines.join("\n"), keyboard };
}

/** 4. Menciones: actividad dirigida, respuestas y promociones con mención. */
export function buildAfroditaMentionsPanel(
  input: { snapshot: AfroditaSnapshot; groupTitle?: string },
): Panel {
  const { snapshot, groupTitle } = input;
  const replies = snapshot.replyTopicCounts ?? {};
  const totalReplies = Object.values(replies).reduce((sum, v) => sum + v, 0);
  const requests = snapshot.commercialRequests ?? {};
  const totalRequests = Object.values(requests).reduce((sum, v) => sum + v, 0);
  const promoted = Array.isArray(snapshot.recentPromotedUserIds)
    ? snapshot.recentPromotedUserIds.length
    : 0;
  const lines = [
    sectionHeader("MENCIONES", groupTitle),
    "",
    `Respuestas a menciones: ${totalReplies}`,
    `Consultas comerciales reconocidas: ${totalRequests}`,
    `Respuestas útiles: ${snapshot.usefulReplies ?? 0}`,
    `Mensajes desde última promoción: ${snapshot.messagesSincePromotion ?? 0}`,
    `Promociones recientes (con mención de perfil): ${promoted}`,
    `Perfiles autorizados: ${Object.keys(snapshot.authorizedProfiles ?? {}).length}`,
    "",
    "*Respuestas por tema:*",
  ];
  const topics = Object.entries(replies).sort((a, b) => b[1] - a[1]);
  if (topics.length === 0) lines.push("Sin respuestas registradas.");
  for (const [topic, count] of topics) {
    if (count <= 0) continue;
    lines.push(`• ${clean(topic, 30)}: ${count}`);
  }
  lines.push("", "*Consultas comerciales:*");
  const requestEntries = Object.entries(requests)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  if (requestEntries.length === 0) lines.push("Sin consultas registradas.");
  for (const [key, count] of requestEntries.slice(0, 8)) {
    lines.push(`• ${clean(key, 30)}: ${count}`);
  }
  const keyboard = new InlineKeyboard()
    .text("🔄 Actualizar", AfroditaAction.view("menciones"))
    .row()
    .text("⬅️ Volver", AfroditaAction.home)
    .text("🏠 Inicio", MenuAction.main);
  return { text: lines.join("\n"), keyboard };
}

/** 5. Grupos sincronizados (paginado). */
export function buildAfroditaGroupsPanel(
  input: { rows: AfroditaStateRow[]; page: number; groupTitle?: string },
): Panel {
  const { rows, page, groupTitle } = input;
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE_GROUPS));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const pageRows = rows.slice(
    currentPage * PAGE_SIZE_GROUPS,
    currentPage * PAGE_SIZE_GROUPS + PAGE_SIZE_GROUPS,
  );
  const lines = [
    sectionHeader("GRUPOS", groupTitle),
    "",
    `Grupos con instantánea: ${rows.length}`,
    `Página ${currentPage + 1}/${pageCount}`,
    "",
  ];
  if (pageRows.length === 0) lines.push("Sin grupos sincronizados todavía.");
  for (const row of pageRows) {
    const snapshot = snapshotFromRow(row);
    lines.push(
      `• ID ${row.chat_id} — ${snapshot.enabled ? "🟢 activa" : "🔴 pausada"} — ` +
        `${formatTimestamp(row.updated_at)}`,
    );
  }
  const keyboard = new InlineKeyboard();
  if (currentPage > 0) {
    keyboard.text("⬅️ Anterior", AfroditaAction.view("grupos", currentPage - 1));
  }
  if (currentPage + 1 < pageCount) {
    keyboard.text("Siguiente ➡️", AfroditaAction.view("grupos", currentPage + 1));
  }
  keyboard
    .row()
    .text("🔄 Actualizar", AfroditaAction.view("grupos", currentPage))
    .row()
    .text("⬅️ Volver", AfroditaAction.home)
    .text("🏠 Inicio", MenuAction.main);
  return { text: lines.join("\n"), keyboard };
}

/** 6. Programación por categoría (paginado) con toggles de horario. */
export function buildAfroditaSchedulePanel(
  input: {
    snapshot: AfroditaSnapshot;
    page: number;
    groupTitle?: string;
  },
): Panel {
  const { snapshot, page, groupTitle } = input;
  const categories = Object.keys(snapshot.publications ?? {});
  const pageCount = Math.max(
    1,
    Math.ceil(categories.length / PAGE_SIZE_SCHEDULE),
  );
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const pageCategories = categories.slice(
    currentPage * PAGE_SIZE_SCHEDULE,
    currentPage * PAGE_SIZE_SCHEDULE + PAGE_SIZE_SCHEDULE,
  );
  const lines = [
    sectionHeader("PROGRAMACIÓN", groupTitle),
    "",
    `Zona horaria: ${clean(snapshot.timeZone ?? "UTC", 40)}`,
    `Página ${currentPage + 1}/${pageCount}`,
    "",
  ];
  if (pageCategories.length === 0) lines.push("Sin categorías registradas.");
  for (const category of pageCategories) {
    const settings = snapshot.publications?.[category] ?? {};
    lines.push(
      `*${clean(categoryLabel(category), 40)}*`,
      `Programación: ${yesNo(settings.scheduledEnabled)} · ` +
        `Actividad: ${yesNo(settings.activityEnabled)}`,
      `Horarios: ${(settings.scheduleTimes ?? []).join(", ") || "sin programación"} · ` +
        `Máx./día: ${settings.maxPerDay ?? "—"}`,
      `Intervalo mínimo: ${
        settings.minIntervalMs !== undefined
          ? Math.round(settings.minIntervalMs / 3_600_000)
          : "—"
      } h`,
      "",
    );
  }
  const keyboard = new InlineKeyboard();
  for (const category of pageCategories) {
    const settings = snapshot.publications?.[category] ?? {};
    keyboard
      .text(
        `${settings.scheduledEnabled ? "⏸ Pausar" : "▶️ Activar"} horario · ${clean(
          categoryLabel(category),
          24,
        )}`,
        AfroditaAction.ask(`sched:${category}`),
      )
      .row();
  }
  if (currentPage > 0) {
    keyboard.text("⬅️ Anterior", AfroditaAction.view("programacion", currentPage - 1));
  }
  if (currentPage + 1 < pageCount) {
    keyboard.text("Siguiente ➡️", AfroditaAction.view("programacion", currentPage + 1));
  }
  keyboard
    .row()
    .text("🔄 Actualizar", AfroditaAction.view("programacion", currentPage))
    .row()
    .text("⬅️ Volver", AfroditaAction.home)
    .text("🏠 Inicio", MenuAction.main);
  return { text: lines.join("\n"), keyboard };
}

/** 7. Historial de eventos de AFRODITA (paginado). */
export function buildAfroditaHistoryPanel(
  input: {
    events: AfroditaEventRow[];
    page: number;
    hasMore: boolean;
    groupTitle?: string;
  },
): Panel {
  const { events, page, hasMore, groupTitle } = input;
  const lines = [
    sectionHeader("HISTORIAL", groupTitle),
    "",
    `Página ${page + 1}`,
    "",
  ];
  if (events.length === 0) lines.push("Sin eventos registrados aún.");
  for (const event of events) {
    const kind = event.kind === "publication"
      ? "📰 publicación"
      : event.kind === "poll"
        ? "📊 encuesta"
        : clean(event.kind, 24);
    const payload = event.payload ?? {};
    const detail =
      typeof payload.category === "string"
        ? categoryLabel(payload.category)
        : typeof payload.status === "string"
          ? payload.status
          : "";
    lines.push(
      `• ${formatTimestamp(event.created_at)} — ${kind}` +
        `${detail ? ` — ${clean(detail, 32)}` : ""} (grupo ${event.chat_id})`,
    );
  }
  const keyboard = new InlineKeyboard();
  if (page > 0) {
    keyboard.text("⬅️ Anterior", AfroditaAction.view("historial", page - 1));
  }
  if (hasMore) {
    keyboard.text("Siguiente ➡️", AfroditaAction.view("historial", page + 1));
  }
  keyboard
    .row()
    .text("🔄 Actualizar", AfroditaAction.view("historial", page))
    .row()
    .text("⬅️ Volver", AfroditaAction.home)
    .text("🏠 Inicio", MenuAction.main);
  return { text: lines.join("\n"), keyboard };
}

/** 8. Configuración con confirmaciones para toda operación. */
export function buildAfroditaSettingsPanel(
  input: { snapshot: AfroditaSnapshot; groupTitle?: string },
): Panel {
  const { snapshot, groupTitle } = input;
  const lines = [
    sectionHeader("CONFIGURACIÓN", groupTitle),
    "",
    `AFRODITA en este grupo: ${snapshot.enabled ? "🟢 habilitada" : "🔴 deshabilitada"}`,
    `Pausa de actividad: ${snapshot.activityPaused ? "🔴 activa" : "🟢 inactiva"}`,
    `Zona horaria: ${clean(snapshot.timeZone ?? "UTC", 40)}`,
    `Silencio hasta: ${formatTimestamp(snapshot.quietUntil || undefined)}`,
    "",
    "*Categorías:*",
  ];
  const keyboard = new InlineKeyboard();
  for (const [category, settings] of Object.entries(snapshot.publications ?? {})) {
    lines.push(
      `• ${clean(categoryLabel(category), 40)}: ${yesNo(settings.enabled)}`,
    );
    keyboard
      .text(
        `${settings.enabled ? "⏸ Pausar" : "▶️ Activar"} · ${clean(
          categoryLabel(category),
          26,
        )}`,
        AfroditaAction.ask(`cat:${category}`),
      )
      .row();
  }
  lines.push(
    "",
    "Toda acción pide confirmación y se aplica en la próxima sincronización " +
      "de AFRODITA (≈1 min).",
  );
  keyboard
    .text("🔄 Actualizar", AfroditaAction.view("configuracion"))
    .row()
    .text("⬅️ Volver", AfroditaAction.home)
    .text("🏠 Inicio", MenuAction.main);
  return { text: lines.join("\n"), keyboard };
}

function buildUnavailablePanel(groupTitle?: string): Panel {
  return {
    text:
      `${sectionHeader("NO DISPONIBLE", groupTitle)}\n\n` +
      "La integración con Supabase no está disponible en este momento. " +
      "Comprueba que SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY estén " +
      "configuradas en el servicio de ZEUS y vuelve a intentarlo.",
    keyboard: buildNavRow(),
  };
}

function buildConfirmPanel(input: {
  title: string;
  description: string;
  confirmAction: string;
  backView: string;
  groupTitle?: string;
}): Panel {
  return {
    text:
      `${sectionHeader("CONFIRMAR", input.groupTitle)}\n\n` +
      `*${clean(input.title, 60)}*\n\n${input.description}\n\n` +
          "Esta acción se encolará para AFRODITA y se aplicará en su próxima " +
      "sincronización.",
    keyboard: new InlineKeyboard()
      .text("✅ Confirmar", input.confirmAction)
      .row()
      .text("⬅️ Cancelar", AfroditaAction.view(input.backView))
      .row()
      .text("🏠 Inicio", MenuAction.main),
  };
}

function parsePage(value: string | undefined): number {
  if (value === undefined) return 0;
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 0 ? page : 0;
}

async function loadSelectedSnapshot(
  ctx: MyContext,
): Promise<
  | { ok: true; snapshot: AfroditaSnapshot; row: AfroditaStateRow }
  | { ok: false; reason: "no_group" | "no_state" }
> {
  const chatId = ctx.session.user.selectedGroupId;
  if (!chatId) return { ok: false, reason: "no_group" };
  const row = await getAfroditaState(chatId);
  if (!row) return { ok: false, reason: "no_state" };
  return { ok: true, snapshot: snapshotFromRow(row), row };
}

/**
 * Enruta cualquier callback de la sección 🌸 AFRODITA.
 * Las vistas exigen cuenta autorizada (garantizado por el router del panel);
 * toda acción `ask:`/`do:` exige además isEffectiveOwner en el backend.
 */
export async function handleAfroditaMenuAction(
  action: { kind?: string; section?: string; item?: string },
  ctx: MyContext,
): Promise<void> {
  ctx.session.user.pendingAction = undefined;
  const item =
    action.kind === "sub" || !action.item ? "resumen" : action.item;
  const groupTitle = ctx.session.user.selectedGroupTitle;
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.answerCallbackQuery("⛔ Sesión no válida.");
    return;
  }

  const isMutation = item.startsWith("ask:") || item.startsWith("do:");
  if (isMutation && !(await isEffectiveOwner(userId))) {
    await ctx.answerCallbackQuery(
      "⛔ Solo la propiedad de ZEUS puede cambiar la configuración de AFRODITA.",
    );
    return;
  }

  const answerAndRender = async (panel: Panel): Promise<void> => {
    await ctx.answerCallbackQuery();
    await renderPanel(ctx, panel);
  };

  try {
    const [view, ...rest] = item.split(":");
    const tail = rest.join(":");

    if (view === "resumen") {
      const [rows, selectedState, control, latestCommand] = await Promise.all([
        listAfroditaStates(),
        ctx.session.user.selectedGroupId
          ? getAfroditaState(ctx.session.user.selectedGroupId)
          : Promise.resolve(undefined),
        getAfroditaGlobalControl(),
        getLatestAfroditaGlobalCommand(),
      ]);
      await answerAndRender(
        buildAfroditaSummaryPanel({
          rows,
          selectedState,
          groupTitle,
          control,
          latestCommand,
        }),
      );
      return;
    }

    if (view === "grupos") {
      const rows = await listAfroditaStates();
      await answerAndRender(
        buildAfroditaGroupsPanel({ rows, page: parsePage(tail), groupTitle }),
      );
      return;
    }

    if (view === "historial") {
      const page = parsePage(tail);
      const events = await listAfroditaEvents({
        page,
        pageSize: PAGE_SIZE_EVENTS + 1,
      });
      const hasMore = events.length > PAGE_SIZE_EVENTS;
      await answerAndRender(
        buildAfroditaHistoryPanel({
          events: events.slice(0, PAGE_SIZE_EVENTS),
          page,
          hasMore,
          groupTitle,
        }),
      );
      return;
    }

    if (view === "ask" && /^(?:global-pause|global-resume)$/u.test(tail)) {
      await renderAskConfirmation(ctx, tail, undefined, groupTitle);
      return;
    }

    if (view === "do" && /^(?:global-pause|global-resume)$/u.test(tail)) {
      await executeAfroditaAction(ctx, tail);
      return;
    }

    // Las siguientes vistas necesitan el estado del grupo seleccionado.
    const loaded = await loadSelectedSnapshot(ctx);
    if (!loaded.ok) {
      if (loaded.reason === "no_group") {
        await ctx.answerCallbackQuery(NO_GROUP_TEXT);
        return;
      }
      await answerAndRender(noStatePanel(groupTitle));
      return;
    }
    const { snapshot } = loaded;

    if (view === "publicaciones") {
      await answerAndRender(
        buildAfroditaPublicationsPanel({
          snapshot,
          groupTitle,
          page: parsePage(tail),
        }),
      );
      return;
    }

    if (view === "encuestas") {
      const page = parsePage(tail);
      const polls = await listAfroditaEvents({
        chatId: ctx.session.user.selectedGroupId,
        kind: "poll",
        page,
        pageSize: PAGE_SIZE_EVENTS + 1,
      });
      await answerAndRender(
        buildAfroditaPollsPanel({
          snapshot,
          groupTitle,
          recentPolls: polls.slice(0, PAGE_SIZE_EVENTS),
          hasMore: polls.length > PAGE_SIZE_EVENTS,
          page,
        }),
      );
      return;
    }

    if (view === "menciones") {
      await answerAndRender(
        buildAfroditaMentionsPanel({ snapshot, groupTitle }),
      );
      return;
    }

    if (view === "programacion") {
      await answerAndRender(
        buildAfroditaSchedulePanel({
          snapshot,
          page: parsePage(tail),
          groupTitle,
        }),
      );
      return;
    }

    if (view === "configuracion") {
      await answerAndRender(
        buildAfroditaSettingsPanel({ snapshot, groupTitle }),
      );
      return;
    }

    if (view === "ask") {
      await renderAskConfirmation(ctx, tail, snapshot, groupTitle);
      return;
    }

    if (view === "do") {
      await executeAfroditaAction(ctx, tail, snapshot);
      return;
    }

    await ctx.answerCallbackQuery("⚠️ Sección no reconocida.");
  } catch (error) {
    if (error instanceof AfroditaBridgeUnavailableError) {
      await answerAndRender(buildUnavailablePanel(groupTitle));
      return;
    }
    console.error(
      `[AFRODITA PANEL] Error manejando ${item} ` +
        `(${error instanceof Error ? error.name : "unknown"}).`,
    );
    await ctx.answerCallbackQuery(
      "⚠️ No se pudo completar la operación. Inténtalo de nuevo.",
    );
  }
}

/** Pantallas de confirmación para toda operación (ask:*). */
async function renderAskConfirmation(
  ctx: MyContext,
  target: string,
  snapshot: AfroditaSnapshot | undefined,
  groupTitle?: string,
): Promise<void> {
  const [kind, ...parts] = target.split(":");
  const arg = parts.join(":");

  if (kind === "global-pause" || kind === "global-resume") {
    const pausing = kind === "global-pause";
    const panel = buildConfirmPanel({
      title: pausing ? "Pausar AFRODITA por completo" : "Reanudar AFRODITA",
      description: pausing
        ? "Se detendrán las respuestas de IA, encuestas, publicaciones, menciones y campañas automáticas en todos los grupos. La sincronización, el heartbeat y las órdenes de control seguirán activos."
        : "AFRODITA volverá a operar en todos los grupos que sigan habilitados, conservando las configuraciones individuales.",
      confirmAction: AfroditaAction.do(kind),
      backView: "resumen",
      groupTitle,
    });
    await ctx.answerCallbackQuery();
    await renderPanel(ctx, panel);
    return;
  }

  const group = ctx.session.user.selectedGroupId;
  if (!group) {
    await ctx.answerCallbackQuery(NO_GROUP_TEXT);
    return;
  }
  if (kind === "cat" || kind === "sched") {
    if (!snapshot) {
      await ctx.answerCallbackQuery("⚠️ No se pudo cargar la configuración del grupo.");
      return;
    }
    const settings = snapshot.publications?.[arg];
    if (!settings) {
      await ctx.answerCallbackQuery("⚠️ Categoría no reconocida.");
      return;
    }
    const isCat = kind === "cat";
    const currently = isCat ? settings.enabled : settings.scheduledEnabled;
    const panel = buildConfirmPanel({
      title:
        `${currently ? "Pausar" : "Activar"} ${isCat ? "categoría" : "horario"}: ` +
        `${categoryLabel(arg)}`,
      description: isCat
        ? "La categoría dejará de generar publicaciones hasta que se reactive."
        : "La programación por horarios de esta categoría cambiará de estado.",
      confirmAction: AfroditaAction.do(`${kind}:${arg}`),
      backView: isCat ? "configuracion" : "programacion",
      groupTitle,
    });
    await ctx.answerCallbackQuery();
    await renderPanel(ctx, panel);
    return;
  }

  await ctx.answerCallbackQuery("⚠️ Acción no reconocida.");
}

async function buildGlobalSummaryForContext(ctx: MyContext): Promise<Panel> {
  const [rows, selectedState, control, latestCommand] = await Promise.all([
    listAfroditaStates(),
    ctx.session.user.selectedGroupId
      ? getAfroditaState(ctx.session.user.selectedGroupId)
      : Promise.resolve(undefined),
    getAfroditaGlobalControl(),
    getLatestAfroditaGlobalCommand(),
  ]);
  return buildAfroditaSummaryPanel({
    rows,
    selectedState,
    groupTitle: ctx.session.user.selectedGroupTitle,
    control,
    latestCommand,
  });
}

/** Encola la orden confirmada hacia AFRODITA (do:*). */
async function executeAfroditaAction(
  ctx: MyContext,
  target: string,
  snapshot?: AfroditaSnapshot,
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.answerCallbackQuery(NO_GROUP_TEXT);
    return;
  }
  const [kind, ...parts] = target.split(":");
  const arg = parts.join(":");

  if (kind === "global-pause" || kind === "global-resume") {
    const result = await enqueueAfroditaGlobalCommand(
      kind === "global-pause" ? "pause" : "resume",
      userId,
    );
    if (result.unchanged) {
      await ctx.answerCallbackQuery(
        kind === "global-pause"
          ? "AFRODITA ya está pausada."
          : "AFRODITA ya está activa.",
      );
    } else {
      await ctx.answerCallbackQuery(
        result.pending
          ? "⏳ Orden encolada. Procesando; espera la confirmación de AFRODITA."
          : "⚠️ No se pudo encolar la orden.",
      );
    }
    await renderPanel(
      ctx,
      await buildGlobalSummaryForContext(ctx),
    );
    return;
  }

  const group = ctx.session.user.selectedGroupId;
  if (!group || !snapshot) {
    await ctx.answerCallbackQuery(NO_GROUP_TEXT);
    return;
  }

  if (kind === "cat" || kind === "sched") {
    const settings = snapshot.publications?.[arg];
    if (!settings) {
      await ctx.answerCallbackQuery("⚠️ Categoría no reconocida.");
      return;
    }
    const field = kind === "cat" ? "enabled" : "scheduledEnabled";
    const current = kind === "cat" ? settings.enabled : settings.scheduledEnabled;
    await enqueueAfroditaCommand(
      group,
      "set_category",
      { category: arg, field, value: !current },
      userId,
    );
    await ctx.answerCallbackQuery("✅ Orden enviada a AFRODITA.");
    const panel = kind === "cat"
      ? buildAfroditaSettingsPanel({ snapshot, groupTitle: ctx.session.user.selectedGroupTitle })
      : buildAfroditaSchedulePanel({
        snapshot,
        page: 0,
        groupTitle: ctx.session.user.selectedGroupTitle,
      });
    await renderPanel(ctx, panel);
    return;
  }

  await ctx.answerCallbackQuery("⚠️ Acción no reconocida.");
}
