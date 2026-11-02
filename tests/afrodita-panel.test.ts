import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { MyContext } from "../src/types.js";

process.env.OWNER_ID = "900000031";
process.env.ALEXIITA_TELEGRAM_ID = "900000032";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_publishable_dummy-key";

interface CapturedCall {
  url: string;
  method: string;
  body?: unknown;
}

const calls: CapturedCall[] = [];

const stateRow = {
  chat_id: -100500,
  state: {
    enabled: true,
    activityPaused: false,
    timeZone: "UTC",
    messageCount: 42,
    pollCount: 3,
    lastPollTopic: "productos",
    lastPollAt: 1_700_000_000_000,
    pollVotes: { productos: 5, servicios: 2 },
    replyTopicCounts: { productos: 7 },
    commercialRequests: { catalogo: 4 },
    usefulReplies: 9,
    messagesSincePromotion: 12,
    recentPromotedUserIds: [111, 222],
    authorizedProfiles: { "111": { userId: 111 } },
    publications: {
      commercial_poll: {
        enabled: true,
        scheduledEnabled: true,
        activityEnabled: true,
        scheduleTimes: ["11:00", "16:00"],
        maxPerDay: 3,
        minIntervalMs: 14_400_000,
        publishedToday: 1,
        lastPublishedAt: 1_700_000_000_000,
        history: [{ id: "h1", at: 1_700_000_000_000, status: "published" }],
      },
      verified_promotion: {
        enabled: false,
        scheduledEnabled: true,
        activityEnabled: true,
        scheduleTimes: ["12:00"],
        maxPerDay: 2,
        minIntervalMs: 14_400_000,
        publishedToday: 0,
        lastPublishedAt: 0,
        history: [],
      },
    },
  },
  updated_at: "2026-11-02T10:00:00+00:00",
  updated_by: "afrodita",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  let body: unknown;
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = undefined;
    }
  }
  calls.push({ url, method, ...(body !== undefined ? { body } : {}) });

  if (url.includes("/rest/v1/system_owner")) {
    return jsonResponse([{ owner_user_id: 900000031 }]);
  }
  if (url.includes("/rest/v1/afrodita_commands") && method === "POST") {
    return jsonResponse({ id: 7 }, 201);
  }
  if (url.includes("/rest/v1/afrodita_events")) {
    // Devuelve más de una página (9 > PAGE_SIZE_EVENTS) para poder comprobar
    // el botón «Siguiente» de la paginación.
    return jsonResponse(
      Array.from({ length: 9 }, (_, index) => ({
        id: 10 + index,
        chat_id: -100500,
        kind: "poll",
        payload: { pollCount: 3, lastPollTopic: "productos" },
        created_at: "2026-11-02T09:00:00+00:00",
      })),
    );
  }
  if (url.includes("/rest/v1/afrodita_group_state")) {
    if (method === "POST") return jsonResponse({}, 201);
    return jsonResponse([stateRow]);
  }
  return jsonResponse([]);
}) as typeof fetch;

const { parseMenuAction } = await import("../src/menus/index.js");
const {
  isAfroditaPanelAction,
  handleAfroditaMenuAction,
  buildAfroditaSummaryPanel,
  snapshotFromRow,
} = await import("../src/menus/afrodita-panel.js");
const { resetAfroditaBridgeClient } = await import(
  "../src/services/afrodita-bridge.js"
);

after(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

interface Harness {
  ctx: MyContext;
  answers: string[];
  edited: Array<{ text: string; keyboard?: unknown }>;
  replies: Array<{ text: string }>;
}

function createCtx(options: {
  fromId: number;
  selectedGroupId?: number;
  selectedGroupTitle?: string;
}): Harness {
  const answers: string[] = [];
  const edited: Harness["edited"] = [];
  const replies: Harness["replies"] = [];
  const chat = { id: options.fromId, type: "private" as const };
  const ctx = {
    update: { update_id: 1 },
    chat,
    from: { id: options.fromId, is_bot: false, first_name: "Owner" },
    session: {
      user: {
        ...(options.selectedGroupId !== undefined
          ? { selectedGroupId: options.selectedGroupId }
          : {}),
        ...(options.selectedGroupTitle !== undefined
          ? { selectedGroupTitle: options.selectedGroupTitle }
          : {}),
      },
      group: {},
    },
    callbackQuery: {
      id: "cb1",
      data: "menu:action:afrodita:resumen",
      chat_instance: "ci",
      from: { id: options.fromId, is_bot: false, first_name: "Owner" },
      message: { message_id: 500, date: 0, chat },
    },
    answerCallbackQuery: async (text?: string) => {
      answers.push(typeof text === "string" ? text : "");
      return true;
    },
    reply: async (text: string) => {
      replies.push({ text });
      return { message_id: 600 };
    },
    api: {
      editMessageText: async (
        _chatId: number,
        _messageId: number,
        text: string,
        other?: { reply_markup?: unknown },
      ) => {
        edited.push({ text, ...(other?.reply_markup ? { keyboard: other.reply_markup } : {}) });
        return { message_id: 500 };
      },
    },
  } as unknown as MyContext;
  return { ctx, answers, edited, replies };
}

function buttonCallbacks(panel: {
  keyboard: { inline_keyboard: Array<Array<{ callback_data?: string }>> };
}): string[] {
  return panel.keyboard.inline_keyboard
    .flat()
    .map((button) => button.callback_data ?? "")
    .filter(Boolean);
}

test("parseMenuAction admite ítems con dos puntos (paginación y confirmaciones)", () => {
  const action = parseMenuAction("menu:action:afrodita:do:cat:commercial_poll");
  assert.deepEqual(action, {
    kind: "action",
    section: "afrodita",
    item: "do:cat:commercial_poll",
  });
  const page = parseMenuAction("menu:action:afrodita:publicaciones:2");
  assert.deepEqual(page, {
    kind: "action",
    section: "afrodita",
    item: "publicaciones:2",
  });
  // Los ítems de una sola sigla siguen comportándose igual.
  assert.deepEqual(parseMenuAction("menu:action:actividad:resumen"), {
    kind: "action",
    section: "actividad",
    item: "resumen",
  });
});

test("isAfroditaPanelAction reconoce sub y action de la sección", () => {
  assert.equal(isAfroditaPanelAction({ kind: "sub", section: "afrodita" }), true);
  assert.equal(
    isAfroditaPanelAction({ kind: "action", section: "afrodita", item: "resumen" }),
    true,
  );
  assert.equal(isAfroditaPanelAction({ kind: "sub", section: "usuarios" }), false);
  assert.equal(isAfroditaPanelAction({ kind: "groups" }), false);
});

test("el panel principal incluye la entrada 🌸 AFRODITA", async () => {
  const { buildMainPanel } = await import("../src/menus/panels.js");
  const panel = buildMainPanel("Grupo Uno");
  const callbacks = buttonCallbacks(panel as never);
  assert.ok(callbacks.includes("menu:sub:afrodita"));
  assert.match(panel.text, /PANEL DE ADMINISTRACIÓN/u);
});

test("snapshotFromRow convierte defensivamente el estado publicado", () => {
  const snapshot = snapshotFromRow(stateRow as never);
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.pollCount, 3);
  assert.equal(snapshot.pollVotes?.productos, 5);
  assert.equal(snapshot.publications?.commercial_poll?.maxPerDay, 3);
  assert.equal(snapshot.publications?.commercial_poll?.history?.length, 1);
});

test("el resumen muestra las 8 secciones y datos sincronizados", () => {
  const panel = buildAfroditaSummaryPanel({
    rows: [stateRow as never],
    selectedState: stateRow as never,
    groupTitle: "Grupo Uno",
  });
  assert.match(panel.text, /RESUMEN/u);
  assert.match(panel.text, /Grupos sincronizados: 1/u);
  assert.match(panel.text, /Encuestas publicadas: 3/u);
  const callbacks = buttonCallbacks(panel as never);
  for (const view of [
    "publicaciones",
    "encuestas",
    "menciones",
    "grupos",
    "programacion",
    "historial",
    "configuracion",
  ]) {
    assert.ok(
      callbacks.includes(`menu:action:afrodita:${view}`),
      `falta el botón de ${view}`,
    );
  }
  assert.ok(callbacks.includes("menu:main"));
});

test("las vistas sin grupo seleccionado piden elegir grupo", async () => {
  const h = createCtx({ fromId: 900000031 });
  await handleAfroditaMenuAction(
    { kind: "action", section: "afrodita", item: "publicaciones" },
    h.ctx,
  );
  assert.equal(h.answers.length, 1);
  assert.match(h.answers[0] ?? "", /selecciona el grupo/u);
  assert.equal(h.edited.length, 0);
});

test("una cuenta no propietaria no puede ejecutar acciones de mutación", async () => {
  const h = createCtx({
    fromId: 555666777,
    selectedGroupId: -100500,
    selectedGroupTitle: "Grupo Uno",
  });
  await handleAfroditaMenuAction(
    { kind: "action", section: "afrodita", item: "ask:pause" },
    h.ctx,
  );
  assert.equal(h.answers.length, 1);
  assert.match(h.answers[0] ?? "", /Solo la propiedad de ZEUS/u);
  assert.equal(h.edited.length, 0);
});

test("la propiedad puede abrir la confirmación de pausa", async () => {
  const h = createCtx({
    fromId: 900000031,
    selectedGroupId: -100500,
    selectedGroupTitle: "Grupo Uno",
  });
  await handleAfroditaMenuAction(
    { kind: "action", section: "afrodita", item: "ask:pause" },
    h.ctx,
  );
  assert.equal(h.edited.length, 1);
  assert.match(h.edited[0]?.text ?? "", /CONFIRMAR/u);
  assert.match(h.edited[0]?.text ?? "", /Pausar AFRODITA/u);
  const keyboard = h.edited[0]?.keyboard as
    | { inline_keyboard: Array<Array<{ callback_data?: string }>> }
    | undefined;
  const callbacks = keyboard
    ? keyboard.inline_keyboard.flat().map((b) => b.callback_data ?? "")
    : [];
  assert.ok(callbacks.includes("menu:action:afrodita:do:pause"));
});

test("confirmar la pausa encola la orden hacia AFRODITA", async () => {
  calls.length = 0;
  const h = createCtx({
    fromId: 900000031,
    selectedGroupId: -100500,
    selectedGroupTitle: "Grupo Uno",
  });
  await handleAfroditaMenuAction(
    { kind: "action", section: "afrodita", item: "do:pause" },
    h.ctx,
  );
  const insert = calls.find(
    (call) =>
      call.method === "POST" && call.url.includes("/rest/v1/afrodita_commands"),
  );
  assert.ok(insert, "debe insertarse la orden en afrodita_commands");
  assert.deepEqual(insert?.body, {
    chat_id: -100500,
    command: "pause",
    payload: {},
    created_by: 900000031,
  });
  assert.match(h.answers[0] ?? "", /Orden de pausa enviada/u);
  assert.equal(h.edited.length, 1);
});

test("sin credenciales Supabase el panel muestra NO DISPONIBLE", async () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  resetAfroditaBridgeClient();
  try {
    const h = createCtx({
      fromId: 900000031,
      selectedGroupId: -100500,
      selectedGroupTitle: "Grupo Uno",
    });
    await handleAfroditaMenuAction(
      { kind: "action", section: "afrodita", item: "resumen" },
      h.ctx,
    );
    assert.equal(h.edited.length, 1);
    assert.match(h.edited[0]?.text ?? "", /NO DISPONIBLE/u);
  } finally {
    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
    resetAfroditaBridgeClient();
  }
});

test("el historial pagina eventos con botones anterior/siguiente", async () => {
  const h = createCtx({
    fromId: 900000031,
    selectedGroupId: -100500,
    selectedGroupTitle: "Grupo Uno",
  });
  await handleAfroditaMenuAction(
    { kind: "action", section: "afrodita", item: "historial" },
    h.ctx,
  );
  assert.equal(h.edited.length, 1);
  assert.match(h.edited[0]?.text ?? "", /HISTORIAL/u);
  assert.match(h.edited[0]?.text ?? "", /encuesta/u);
  const keyboard = h.edited[0]?.keyboard as
    | { inline_keyboard: Array<Array<{ callback_data?: string }>> }
    | undefined;
  const callbacks = keyboard
    ? keyboard.inline_keyboard.flat().map((b) => b.callback_data ?? "")
    : [];
  assert.ok(callbacks.includes("menu:action:afrodita:historial:1"));
});
