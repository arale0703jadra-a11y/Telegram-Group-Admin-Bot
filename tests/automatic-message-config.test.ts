import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAutomaticMessageMediaConfig,
  buildAutomaticMessageTextConfig,
} from "../src/services/automatic-message-config.js";
import {
  AutomaticMessageAction,
  buildAutomaticMessagePanel,
  buildAutomaticMessagePreviewPanel,
} from "../src/menus/panels.js";
import type { AutomaticMessageConfig } from "../src/storage/types.js";
import type { AutomaticMessageMediaDraft } from "../src/types.js";

const NOW = Date.UTC(2026, 10, 4, 12);
const now = (): number => NOW;

function panelCallbacks(panel: { keyboard: { inline_keyboard: unknown[] } }): Array<string | undefined> {
  return panel.keyboard.inline_keyboard.flat().map((button) =>
    typeof button === "object" && button !== null && "callback_data" in button
      ? (button as { callback_data: string }).callback_data
      : undefined,
  );
}

test("el texto reemplaza contenido multimedia y conserva la programación", () => {
  const current: AutomaticMessageConfig = {
    enabled: true,
    type: "photo",
    fileId: "PHOTO_OLD",
    caption: "Vieja",
    intervalMinutes: 30,
    status: "sent",
    lastMessageId: 7,
  };
  const result = buildAutomaticMessageTextConfig(current, "Nuevo texto", now);
  assert.equal(result.type, "text");
  assert.equal(result.message, "Nuevo texto");
  assert.equal(result.fileId, undefined);
  assert.equal(result.caption, undefined);
  assert.equal(result.captionEntities, undefined);
  assert.equal(result.entities, undefined);
  assert.equal(result.enabled, true);
  assert.equal(result.intervalMinutes, 30);
  assert.equal(result.status, "sent");
  assert.equal(result.lastMessageId, 7);
  assert.equal(result.nextRunAt, new Date(NOW + 30 * 60_000).toISOString());
});

test("la fotografía reemplaza contenido de texto y guarda caption con entidades", () => {
  const current: AutomaticMessageConfig = {
    enabled: false,
    type: "text",
    message: "Texto viejo",
    intervalMinutes: 45,
  };
  const draft: AutomaticMessageMediaDraft = {
    type: "photo",
    fileId: "PHOTO_NEW",
    caption: "Nueva foto",
    captionEntities: [{ type: "bold", offset: 0, length: 6 }],
  };
  const result = buildAutomaticMessageMediaConfig(current, draft, now);
  assert.equal(result.type, "photo");
  assert.equal(result.fileId, "PHOTO_NEW");
  assert.equal(result.caption, "Nueva foto");
  assert.deepEqual(result.captionEntities, draft.captionEntities);
  assert.equal(result.message, undefined);
  assert.equal(result.entities, undefined);
  assert.equal(result.enabled, false);
  assert.equal(result.nextRunAt, undefined);
});

test("el vídeo sin caption se guarda sin descripción", () => {
  const draft: AutomaticMessageMediaDraft = { type: "video", fileId: "VIDEO_NEW" };
  const result = buildAutomaticMessageMediaConfig(undefined, draft, now);
  assert.equal(result.type, "video");
  assert.equal(result.fileId, "VIDEO_NEW");
  assert.equal(result.caption, undefined);
  assert.equal(result.captionEntities, undefined);
  assert.equal(result.message, undefined);
  assert.equal(result.enabled, false);
  assert.equal(result.intervalMinutes, 60);
});

test("configuración antigua (solo message) se reemplaza por multimedia sin dejar residuos", () => {
  const current: AutomaticMessageConfig = { enabled: true, message: "Heredado", intervalMinutes: 60 };
  const draft: AutomaticMessageMediaDraft = { type: "photo", fileId: "P" };
  const result = buildAutomaticMessageMediaConfig(current, draft, now);
  assert.equal(result.type, "photo");
  assert.equal(result.fileId, "P");
  assert.equal(result.message, undefined);
});

test("la vista previa muestra tipo, caption y botones de guardar/cancelar", () => {
  const groupId = -100999;
  const panel = buildAutomaticMessagePreviewPanel(
    { type: "photo", fileId: "P", caption: "Mi foto" },
    "Grupo",
    groupId,
  );
  assert.match(panel.text, /VISTA PREVIA/u);
  assert.match(panel.text, /📷 Fotografía/u);
  assert.match(panel.text, /Mi foto/u);
  const callbacks = panelCallbacks(panel);
  assert.ok(callbacks.includes(AutomaticMessageAction.save(groupId)));
  assert.ok(callbacks.includes(AutomaticMessageAction.previewCancel(groupId)));
});

test("el panel muestra tipo y caption de una configuración multimedia", () => {
  const panel = buildAutomaticMessagePanel(
    { enabled: false, type: "video", fileId: "V", caption: "Desc" },
    "Grupo",
    undefined,
    -100,
  );
  assert.match(panel.text, /🎬 Vídeo/u);
  assert.match(panel.text, /Desc/u);
  assert.doesNotMatch(panel.text, /No hay mensaje configurado/u);
});