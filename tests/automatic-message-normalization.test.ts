import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAutomaticMessage,
  normalizeGroupData,
} from "../src/storage/file.js";
import type { AutomaticMessageConfig } from "../src/storage/types.js";

const FILE_ID = "AgADBAADbKcxG-QOEUcAAQE";

const SCHEDULING = {
  intervalMinutes: 120,
  nextRunAt: "2026-11-04T13:00:00.000Z",
  lastSentAt: "2026-11-03T13:00:00.000Z",
  lastMessageId: 99,
  status: "sent" as const,
  lastAttemptAt: "2026-11-03T13:00:00.000Z",
  attemptCount: 4,
  lastError: "error previo",
  consecutiveFailures: 2,
  history: [
    { at: "2026-11-03T12:00:00.000Z", status: "sent" as const, messageId: 98 },
    {
      at: "2026-11-03T11:00:00.000Z",
      status: "error" as const,
      error: "fallo temporal",
    },
  ],
};

function assertSchedulingPreserved(config: AutomaticMessageConfig): void {
  assert.equal(config.intervalMinutes, 120);
  assert.equal(config.nextRunAt, SCHEDULING.nextRunAt);
  assert.equal(config.lastSentAt, SCHEDULING.lastSentAt);
  assert.equal(config.lastMessageId, 99);
  assert.equal(config.status, "sent");
  assert.equal(config.lastAttemptAt, SCHEDULING.lastAttemptAt);
  assert.equal(config.attemptCount, 4);
  assert.equal(config.lastError, "error previo");
  assert.equal(config.consecutiveFailures, 2);
  assert.deepEqual(config.history, SCHEDULING.history);
}

test("registro de texto antiguo (sin discriminador) se normaliza como text y conserva programación", () => {
  const result = normalizeAutomaticMessage({
    enabled: true,
    message: "Aviso recurrente",
    ...SCHEDULING,
  });
  assert.ok(result);
  assert.equal(result.type, "text");
  assert.equal(result.message, "Aviso recurrente");
  assert.equal(result.fileId, undefined);
  assert.equal(result.caption, undefined);
  assertSchedulingPreserved(result);
});

test("registro de texto nuevo con discriminador conserva entidades", () => {
  const entities = [
    { type: "bold", offset: 0, length: 4 },
    { type: "url", offset: 5, length: 5, url: "https://t.me/x" },
  ];
  const result = normalizeAutomaticMessage({
    enabled: true,
    type: "text",
    message: "Hola*t.me/x",
    entities,
  });
  assert.ok(result);
  assert.equal(result.type, "text");
  assert.equal(result.message, "Hola*t.me/x");
  assert.deepEqual(result.entities, entities);
});

test("foto con caption y caption_entities", () => {
  const caption = "Una foto";
  const captionEntities = [{ type: "bold", offset: 0, length: 8 }];
  const result = normalizeAutomaticMessage({
    enabled: true,
    type: "photo",
    fileId: FILE_ID,
    caption,
    captionEntities,
  });
  assert.ok(result);
  assert.equal(result.type, "photo");
  assert.equal(result.fileId, FILE_ID);
  assert.equal(result.caption, caption);
  assert.deepEqual(result.captionEntities, captionEntities);
});

test("foto sin caption", () => {
  const result = normalizeAutomaticMessage({
    enabled: true,
    type: "photo",
    fileId: FILE_ID,
  });
  assert.ok(result);
  assert.equal(result.type, "photo");
  assert.equal(result.fileId, FILE_ID);
  assert.equal(result.caption, undefined);
  assert.equal(result.captionEntities, undefined);
});

test("vídeo con caption", () => {
  const result = normalizeAutomaticMessage({
    enabled: true,
    type: "video",
    fileId: "BAADBAADbKcxG-QOEUcBAAD",
    caption: "Un vídeo",
  });
  assert.ok(result);
  assert.equal(result.type, "video");
  assert.equal(result.fileId, "BAADBAADbKcxG-QOEUcBAAD");
  assert.equal(result.caption, "Un vídeo");
  assert.equal(result.captionEntities, undefined);
});

test("vídeo sin caption", () => {
  const result = normalizeAutomaticMessage({
    enabled: true,
    type: "video",
    fileId: "BAADBAADbKcxG-QOEUcBAAD",
  });
  assert.ok(result);
  assert.equal(result.type, "video");
  assert.equal(result.fileId, "BAADBAADbKcxG-QOEUcBAAD");
  assert.equal(result.caption, undefined);
});

test("foto sin entidades sigue siendo válida y conserva programación", () => {
  const result = normalizeAutomaticMessage({
    enabled: true,
    type: "photo",
    fileId: FILE_ID,
    caption: "Sin entidades",
    ...SCHEDULING,
  });
  assert.ok(result);
  assert.equal(result.type, "photo");
  assert.equal(result.caption, "Sin entidades");
  assert.equal(result.captionEntities, undefined);
  assertSchedulingPreserved(result);
});

test("registro inválido sin mensaje ni fileId se descarta", () => {
  assert.equal(normalizeAutomaticMessage({ enabled: true }), undefined);
  assert.equal(normalizeAutomaticMessage({ enabled: true, type: "text" }), undefined);
  assert.equal(normalizeAutomaticMessage({ enabled: true, type: "photo" }), undefined);
  assert.equal(normalizeAutomaticMessage({ enabled: true, type: "video" }), undefined);
  assert.equal(normalizeAutomaticMessage({ enabled: true, message: "   " }), undefined);
});

test("discriminador desconocido se descarta", () => {
  assert.equal(
    normalizeAutomaticMessage({ enabled: true, type: "sticker", fileId: FILE_ID }),
    undefined,
  );
  assert.equal(
    normalizeAutomaticMessage({ enabled: true, type: "document", fileId: FILE_ID }),
    undefined,
  );
});

test("conserva historial y programación sin mutar la entrada original", () => {
  const input = {
    enabled: true,
    type: "text" as const,
    message: "Con historial",
    ...SCHEDULING,
  };
  const snapshot = JSON.parse(JSON.stringify(input));
  const result = normalizeAutomaticMessage(input);
  assert.ok(result);
  assert.deepEqual(result.history, SCHEDULING.history);
  assert.equal(result.intervalMinutes, 120);
  assert.equal(result.status, "sent");
  assert.equal(result.consecutiveFailures, 2);
  assert.equal(result.lastMessageId, 99);
  assert.deepEqual(input, snapshot, "la entrada original no debe mutarse");
});

test("grupo antiguo con automaticMessage de solo texto se interpreta como text", () => {
  const group = normalizeGroupData({
    automaticMessage: { enabled: true, message: "Mensaje viejo" },
  });
  assert.ok(group.automaticMessage);
  assert.equal(group.automaticMessage.type, "text");
  assert.equal(group.automaticMessage.message, "Mensaje viejo");
  // El resto del grupo se rellena con valores por defecto.
  assert.equal(group.antiSpam.enabled, true);
  assert.deepEqual(group.warnings, {});
});