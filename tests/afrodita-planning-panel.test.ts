import assert from "node:assert/strict";
import test from "node:test";
import type { InlineKeyboard } from "grammy";
import {
  afroditaPlanningOverview,
  buildAfroditaGroupsPanel,
  buildAfroditaSchedulePanel,
  buildAfroditaSettingsPanel,
  buildAfroditaSummaryPanel,
  lastPublicationAtOfSnapshot,
  snapshotFromRow,
} from "../src/menus/afrodita-panel.js";
import type { AfroditaStateRow } from "../src/services/afrodita-bridge.js";

const NOW = Date.UTC(2026, 10, 5, 10, 0); //05-nov-202610:00 UTC
const FUTURE = NOW + 2 * 3600_000;
const PAST = NOW - 3600_000;
const ISO = "2026-11-05T09:00:00.000Z";

/** Snapshot completo (con los campos nuevos de conversación y planificación). */
const modernState = {
  enabled: true,
  timeZone: "UTC",
  conversationEnabled: true,
  conversationReplies: 7,
  conversationExcludedVerified: 3,
  conversationExcludedAdmin: 2,
  conversationErrors: 1,
  publications: {
    commercial_poll: {
      enabled: true,
      scheduledEnabled: true,
      activityEnabled: true,
      scheduleTimes: ["11:00", "16:00", "21:00"],
      maxPerDay: 8,
      minIntervalMs: 90 * 60_000,
      publishedToday: 1,
      lastPublishedAt: PAST,
      nextScheduledAt: FUTURE,
      history: [
        { id: "p1", at: PAST, status: "published" },
        { id: "p2", at: PAST - 1_000, status: "failed" },
      ],
    },
    verified_promotion: {
      enabled: true,
      scheduledEnabled: true,
      activityEnabled: true,
      scheduleTimes: ["12:00", "20:00"],
      maxPerDay: 2,
      minIntervalMs: 4 * 3600_000,
      publishedToday: 0,
      lastPublishedAt: PAST - 7_200_000,
      history: [{ id: "v1", at: PAST - 7_200_000, status: "published" }],
    },
  },
};

/** Snapshot ANTIGUO: sin campos de conversación ni nextScheduledAt. */
const legacyState = {
  enabled: true,
  timeZone: "UTC",
  messageCount: 2,
  publications: {
    commercial_poll: {
      enabled: true,
      scheduledEnabled: true,
      activityEnabled: true,
      scheduleTimes: ["11:00", "16:00", "21:00"],
      maxPerDay: 8,
      minIntervalMs: 90 * 60_000,
      publishedToday: 0,
      lastPublishedAt: 0,
      history: [],
    },
  },
};

function row(
  state: Record<string, unknown>,
  chatId = -100555001,
): AfroditaStateRow {
  return { chat_id: chatId, state, updated_at: ISO, updated_by: "afrodita" };
}

function callbacks(panel: {
  keyboard: InlineKeyboard;
}): string[] {
  return panel.keyboard.inline_keyboard
    .flat()
    .map((button) =>
      "callback_data" in button && typeof button.callback_data === "string"
        ? button.callback_data
        : "",
    );
}

test("1. el resumen incluye las próximas publicaciones", () => {
  const lines = afroditaPlanningOverview([row(modernState)], NOW);
  const upcoming = lines.find((line) =>
    line.startsWith("Próximas publicaciones:"),
  );
  assert.ok(upcoming, "línea de próximas publicaciones presente");
  assert.ok(upcoming.includes("encuestas"), "incluye la próxima encuesta");
  assert.ok(
    upcoming.includes("Promociones verificadas"),
    "incluye la próxima ancla de promociones",
  );
});

test("2. el resumen incluye la última publicación", () => {
  const lines = afroditaPlanningOverview([row(modernState)], NOW);
  const last = lines.find((line) => line.startsWith("Última publicación:"));
  assert.ok(last, "línea de última publicación presente");
  assert.ok(!last.includes("ninguna"), "hay una publicación real que reportar");
  assert.equal(
    lastPublicationAtOfSnapshot(snapshotFromRow(row(modernState))),
    PAST,
    "la última publicación corresponde al evento más reciente",
  );
});

test("3. el resumen muestra el estado de la conversación IA", () => {
  const lines = afroditaPlanningOverview([row(modernState)], NOW);
  assert.ok(lines.includes("Conversación IA: habilitada"));
  const disabled = afroditaPlanningOverview([row(legacyState)], NOW);
  assert.ok(disabled.includes("Conversación IA: deshabilitada"));

  const summary = buildAfroditaSummaryPanel({
    rows: [row(modernState)],
    control: {
      id: "global",
      mode: "running",
      updated_at: ISO,
      updated_by: "afrodita",
      heartbeat_at: ISO,
    },
  });
  assert.match(summary.text, /Conversación IA: habilitada/u);
});

test("4. el resumen muestra el contador de respuestas", () => {
  const lines = afroditaPlanningOverview([row(modernState)], NOW);
  assert.ok(lines.includes("Respuestas conversacionales: 7"));
});

test("5. el resumen muestra los usuarios excluidos", () => {
  const lines = afroditaPlanningOverview([row(modernState)], NOW);
  assert.ok(
    lines.includes("Excluidos: verificados 3 · administradores 2"),
    "excluidos por verificación y administración reportados",
  );
});

test("6. el resumen muestra los errores de publicación y conversación", () => {
  const lines = afroditaPlanningOverview([row(modernState)], NOW);
  assert.ok(
    lines.includes("Errores: publicaciones fallidas 1 · conversación 1"),
    "errores de ambas funciones reportados",
  );
  const clean = afroditaPlanningOverview([row(legacyState)], NOW);
  assert.ok(clean.includes("Errores: publicaciones fallidas 0 · conversación 0"));
});

test("7. es compatible con snapshots antiguos sin los campos nuevos", () => {
  // legacyState no tiene conversation* ni nextScheduledAt: no debe lanzar.
  const lines = afroditaPlanningOverview([row(legacyState)], NOW);
  assert.ok(lines.includes("Conversación IA: deshabilitada"));
  assert.ok(lines.includes("Respuestas conversacionales: 0"));
  assert.ok(lines.includes("Excluidos: verificados 0 · administradores 0"));
  assert.ok(lines.includes("Última publicación: ninguna"));
  const upcoming = lines.find((line) =>
    line.startsWith("Próximas publicaciones:"),
  );
  assert.ok(upcoming, "sigue calculando anclas desde scheduleTimes");
  assert.ok(!upcoming.includes("encuestas "), "sin nextScheduledAt no promete encuesta");

  const summary = buildAfroditaSummaryPanel({ rows: [row(legacyState)] });
  assert.match(summary.text, /Estado general: 🔴 PAUSADA/u);
  const snapshot = snapshotFromRow(row(legacyState));
  assert.equal(snapshot.conversationEnabled, undefined);
  assert.equal(lastPublicationAtOfSnapshot(snapshot), 0);
});

test("8. existe exactamente un único control global de pausa/reanudación", () => {
  const running = buildAfroditaSummaryPanel({
    rows: [row(modernState)],
    control: {
      id: "global",
      mode: "running",
      updated_at: ISO,
      updated_by: "afrodita",
      heartbeat_at: ISO,
    },
  });
  const globalButtons = callbacks(running).filter((cb) =>
    cb.includes("ask:global-"),
  );
  assert.equal(globalButtons.length, 1, "un sólo botón global");
  assert.ok(globalButtons[0]?.includes("ask:global-pause"));
});

test("9. no hay controles individuales de pausa por grupo, categoría o actividad", () => {
  const snapshot = snapshotFromRow(row(modernState));
  const panels = [
    buildAfroditaSummaryPanel({
      rows: [row(modernState)],
      control: {
        id: "global",
        mode: "running",
        updated_at: ISO,
        updated_by: "afrodita",
        heartbeat_at: ISO,
      },
    }),
    buildAfroditaSchedulePanel({ snapshot, page: 0 }),
    buildAfroditaSettingsPanel({ snapshot }),
    buildAfroditaGroupsPanel({
      rows: [row(modernState)],
      page: 0,
      control: {
        id: "global",
        mode: "running",
        updated_at: ISO,
        updated_by: "afrodita",
        heartbeat_at: ISO,
      },
    }),
  ];
  for (const panel of panels) {
    for (const cb of callbacks(panel)) {
      assert.ok(!cb.includes("ask:cat:") && !cb.includes("do:cat:"), cb);
      assert.ok(!cb.includes("ask:sched:") && !cb.includes("do:sched:"), cb);
    }
    for (const button of panel.keyboard.inline_keyboard.flat()) {
      const label = "text" in button ? button.text : "";
      if (/^(⏸ Pausar|▶️ Activar)/u.test(label)) {
        assert.fail(`botón individual de pausa: ${label}`);
      }
    }
  }
});

