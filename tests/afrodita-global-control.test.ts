import assert from "node:assert/strict";
import test from "node:test";
import type { InlineKeyboard } from "grammy";
import {
  buildAfroditaSummaryPanel,
  buildAfroditaSchedulePanel,
  buildAfroditaSettingsPanel,
  buildAfroditaGroupsPanel,
  buildAfroditaPublicationsPanel,
  buildAfroditaPollsPanel,
  buildAfroditaMentionsPanel,
  buildAfroditaHistoryPanel,
  snapshotFromRow,
  type AfroditaSnapshot,
} from "../src/menus/afrodita-panel.js";
import type {
  AfroditaEventRow,
  AfroditaGlobalCommand,
  AfroditaGlobalControlRow,
  AfroditaStateRow,
} from "../src/services/afrodita-bridge.js";

const ISO = "2026-11-05T18:00:00.000Z";

const stateFixture = {
  enabled: true,
  activityPaused: false,
  timeZone: "UTC",
  quietUntil: 0,
  messageCount: 5,
  pollCount: 3,
  authorizedProfiles: {},
  publications: {
    commercial_poll: {
      enabled: true,
      scheduledEnabled: true,
      activityEnabled: true,
      scheduleTimes: ["12:00"],
      maxPerDay: 3,
      minIntervalMs: 60_000,
      publishedToday: 1,
      lastPublishedAt: 0,
      history: [],
    },
    verified_promotion: {
      enabled: true,
      scheduledEnabled: false,
      activityEnabled: true,
      scheduleTimes: [],
      maxPerDay: 2,
      minIntervalMs: 3_600_000,
      publishedToday: 0,
      lastPublishedAt: 0,
      history: [],
    },
  },
};

const row: AfroditaStateRow = {
  chat_id: -1001234,
  state: stateFixture,
  updated_at: ISO,
  updated_by: "afrodita",
};

function control(mode: "running" | "paused"): AfroditaGlobalControlRow {
  return {
    id: "global",
    mode,
    updated_at: ISO,
    updated_by: "afrodita",
    heartbeat_at: ISO,
  };
}

function command(
  commandName: "pause" | "resume",
  status: AfroditaGlobalCommand["status"],
): AfroditaGlobalCommand {
  return {
    id: 7,
    command: commandName,
    status,
    last_error: status === "failed" ? "AFRODITA_CONTROL_WRITE_HTTP_500" : null,
    created_at: ISO,
    applied_at: status === "applied" ? ISO : null,
  };
}

const event: AfroditaEventRow = {
  id: 1,
  chat_id: -1001234,
  kind: "publication",
  payload: { category: "commercial_poll", status: "published" },
  created_at: ISO,
};

function callbacks(panel: { keyboard: InlineKeyboard }): string[] {
  return panel.keyboard.inline_keyboard
    .flat()
    .map((button) =>
      "callback_data" in button && typeof button.callback_data === "string"
        ? button.callback_data
        : "",
    );
}

test("8. una orden pendiente no se presenta como activación confirmada", () => {
  // Pausa pendiente con el ejecutor aún en running:
  const pausePending = buildAfroditaSummaryPanel({
    rows: [row],
    control: control("running"),
    latestCommand: command("pause", "pending"),
  });
  assert.match(pausePending.text, /🟡 PROCESANDO/u);
  assert.ok(
    !pausePending.text.includes("ACTIVA"),
    "no debe afirmar ACTIVA mientras la pausa está pendiente",
  );
  assert.match(pausePending.text, /pendiente/u);
  assert.ok(
    callbacks(pausePending).every((cb) => !cb.includes("ask:global-")),
    "con orden pendiente no se ofrecen nuevas órdenes de control",
  );

  // Reanudación pendiente con el ejecutor aún en pausa:
  const resumePending = buildAfroditaSummaryPanel({
    rows: [row],
    control: control("paused"),
    latestCommand: command("resume", "pending"),
  });
  assert.match(resumePending.text, /🟡 PROCESANDO/u);
  assert.ok(
    !resumePending.text.includes("ACTIVA"),
    "no debe afirmar ACTIVA con la reanudación pendiente",
  );

  // Confirmado por el ejecutor: sí muestra el estado real.
  const confirmed = buildAfroditaSummaryPanel({
    rows: [row],
    control: control("running"),
    latestCommand: command("resume", "applied"),
  });
  assert.match(confirmed.text, /🟢 ACTIVA/u);
  assert.ok(
    callbacks(confirmed).some((cb) => cb.includes("ask:global-pause")),
    "con running confirmado ofrece solo pausar",
  );
});

test("10. el panel ZEUS no ofrece botones individuales de pausa/reanudación", () => {
  const snap: AfroditaSnapshot = snapshotFromRow(row);

  const panels = [
    buildAfroditaSummaryPanel({ rows: [row], control: control("running") }),
    buildAfroditaSchedulePanel({ snapshot: snap, page: 0 }),
    buildAfroditaSettingsPanel({ snapshot: snap }),
    buildAfroditaGroupsPanel({ rows: [row], page: 0, control: control("running") }),
    buildAfroditaPublicationsPanel({ snapshot: snap, page: 0 }),
    buildAfroditaPollsPanel({ snapshot: snap, recentPolls: [], hasMore: false, page: 0 }),
    buildAfroditaMentionsPanel({ snapshot: snap }),
    buildAfroditaHistoryPanel({ events: [event], page: 0, hasMore: false }),
  ];

  let globalControls = 0;
  for (const panel of panels) {
    const cbs = callbacks(panel);
    for (const cb of cbs) {
      assert.ok(
        !cb.includes("ask:cat:") && !cb.includes("do:cat:"),
        `sin toggles de categoría: ${cb}`,
      );
      assert.ok(
        !cb.includes("ask:sched:") && !cb.includes("do:sched:"),
        `sin toggles de horario: ${cb}`,
      );
    }
    for (const button of panel.keyboard.inline_keyboard.flat()) {
      const label = "text" in button ? button.text : "";
      if (/^(⏸ Pausar|▶️ Activar)/u.test(label)) {
        assert.fail(`botón individual de pausa/activación: ${label}`);
      }
    }
    globalControls += cbs.filter((cb) => cb.includes("ask:global-")).length;
  }
  assert.equal(globalControls, 1, "exactamente un único control global (en el resumen)");
});

test("el resumen muestra estado global, ejecutor, sincronización, actividad y errores", () => {
  const panel = buildAfroditaSummaryPanel({
    rows: [row],
    control: control("running"),
    latestCommand: command("pause", "failed"),
    latestEvent: event,
    groupTitle: "Grupo",
  });
  assert.match(panel.text, /Estado general: 🟢 ACTIVA/u);
  assert.match(panel.text, /Estado del ejecutor:/u);
  assert.match(panel.text, /Última sincronización global:/u);
  assert.match(panel.text, /Última actividad:/u);
  assert.match(panel.text, /La última orden falló:/u);

  const paused = buildAfroditaSummaryPanel({
    rows: [row],
    control: control("paused"),
    latestEvent: event,
  });
  assert.match(paused.text, /Estado general: 🔴 PAUSADA/u);
  assert.match(paused.text, /Todas las actividades automáticas están detenidas/u);
});

