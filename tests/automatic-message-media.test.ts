import assert from "node:assert/strict";
import test from "node:test";
import type { Api } from "grammy";
import type { MessageEntity } from "@grammyjs/types";
import { AutomaticMessageScheduler } from "../src/services/automatic-messages.js";
import { initialGroupData } from "../src/storage/initial.js";
import type { AutomaticMessageConfig, GroupData } from "../src/storage/types.js";

const NOW = Date.UTC(2026, 10, 4, 12);

type SentCall =
  | { kind: "sendMessage"; chatId: number; text: string; entities?: unknown }
  | { kind: "sendPhoto"; chatId: number; fileId: string; caption?: string; captionEntities?: unknown }
  | { kind: "sendVideo"; chatId: number; fileId: string; caption?: string; captionEntities?: unknown };

function config(overrides: Partial<AutomaticMessageConfig> = {}): AutomaticMessageConfig {
  return {
    enabled: true,
    intervalMinutes: 60,
    nextRunAt: new Date(NOW - 1).toISOString(),
    ...overrides,
  };
}

function groupData(message: AutomaticMessageConfig): GroupData {
  return { ...initialGroupData(), automaticMessage: message };
}

function createHarness(entries: Map<number, GroupData>, apiOverrides: Partial<Api> = {}) {
  const sent: SentCall[] = [];
  const deleted: Array<{ chatId: number; messageId: number }> = [];
  const errors: string[] = [];
  const api = {
    async sendMessage(chatId: number, text: string, options?: { entities?: unknown }) {
      sent.push({ kind: "sendMessage", chatId, text, entities: options?.entities });
      return { message_id: sent.length } as never;
    },
    async sendPhoto(chatId: number, photo: string, options?: { caption?: string; caption_entities?: unknown }) {
      sent.push({ kind: "sendPhoto", chatId, fileId: photo, caption: options?.caption, captionEntities: options?.caption_entities });
      return { message_id: sent.length } as never;
    },
    async sendVideo(chatId: number, video: string, options?: { caption?: string; caption_entities?: unknown }) {
      sent.push({ kind: "sendVideo", chatId, fileId: video, caption: options?.caption, captionEntities: options?.caption_entities });
      return { message_id: sent.length } as never;
    },
    async deleteMessage(chatId: number, messageId: number) {
      deleted.push({ chatId, messageId });
      return true;
    },
    ...apiOverrides,
  } as unknown as Api;

  const scheduler = new AutomaticMessageScheduler({
    getGroups: () => [...entries.keys()].map((id) => ({ id })),
    async getGroupData(chatId) {
      const data = entries.get(chatId);
      if (!data) throw new Error(`Unknown group ${chatId}`);
      return structuredClone(data);
    },
    async saveGroupData(chatId, data) {
      entries.set(chatId, structuredClone(data));
    },
    now: () => NOW,
    logError(message) {
      errors.push(message);
    },
    logWarning(message) {
      errors.push(message);
    },
  });

  return { scheduler, api, sent, deleted, errors };
}

async function waitForStartup(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Arranca el scheduler (para que `publish` tenga `api`), fuerza un envío
 * inmediato del grupo indicado y detiene el scheduler al terminar.
 */
async function sendOne(
  entries: Map<number, GroupData>,
  chatId: number,
  apiOverrides: Partial<Api> = {},
) {
  const harness = createHarness(entries, apiOverrides);
  harness.scheduler.start(harness.api);
  await waitForStartup();
  const result = await harness.scheduler.sendNow(chatId);
  harness.scheduler.stop();
  return { ...harness, result };
}

test("publica texto con sendMessage conservando las entidades", async () => {
  const entities: MessageEntity[] = [{ type: "bold", offset: 0, length: 4 }];
  const entries = new Map([
    [-2001, groupData(config({ type: "text", message: "Hola mundo", entities }))],
  ]);
  const { result, sent } = await sendOne(entries, -2001);
  assert.ok(result.ok);
  assert.deepEqual(sent[0], {
    kind: "sendMessage",
    chatId: -2001,
    text: "Hola mundo",
    entities,
  });
});

test("publica fotografía con caption y caption_entities", async () => {
  const captionEntities: MessageEntity[] = [{ type: "bold", offset: 0, length: 7 }];
  const entries = new Map([
    [-2002, groupData(config({
      type: "photo",
      fileId: "PHOTO_ID_1",
      caption: "Mi foto",
      captionEntities,
    }))],
  ]);
  const { result, sent } = await sendOne(entries, -2002);
  assert.ok(result.ok);
  assert.deepEqual(sent[0], {
    kind: "sendPhoto",
    chatId: -2002,
    fileId: "PHOTO_ID_1",
    caption: "Mi foto",
    captionEntities,
  });
});

test("publica fotografía sin caption", async () => {
  const entries = new Map([
    [-2003, groupData(config({ type: "photo", fileId: "PHOTO_ID_2" }))],
  ]);
  const { result, sent } = await sendOne(entries, -2003);
  assert.ok(result.ok);
  assert.deepEqual(sent[0], {
    kind: "sendPhoto",
    chatId: -2003,
    fileId: "PHOTO_ID_2",
    caption: undefined,
    captionEntities: undefined,
  });
});

test("publica vídeo con caption", async () => {
  const entries = new Map([
    [-2004, groupData(config({ type: "video", fileId: "VIDEO_ID_1", caption: "Un vídeo" }))],
  ]);
  const { result, sent } = await sendOne(entries, -2004);
  assert.ok(result.ok);
  assert.deepEqual(sent[0], {
    kind: "sendVideo",
    chatId: -2004,
    fileId: "VIDEO_ID_1",
    caption: "Un vídeo",
    captionEntities: undefined,
  });
});

test("publica vídeo sin caption", async () => {
  const entries = new Map([
    [-2005, groupData(config({ type: "video", fileId: "VIDEO_ID_2" }))],
  ]);
  const { result, sent } = await sendOne(entries, -2005);
  assert.ok(result.ok);
  assert.deepEqual(sent[0], {
    kind: "sendVideo",
    chatId: -2005,
    fileId: "VIDEO_ID_2",
    caption: undefined,
    captionEntities: undefined,
  });
});

test("rechaza fileId vacío sin contactar Telegram", async () => {
  const entries = new Map([
    [-2006, groupData(config({ type: "photo", fileId: "   " }))],
  ]);
  const { result, sent } = await sendOne(entries, -2006);
  assert.equal(result.ok, false);
  assert.equal(sent.length, 0);
  const saved = entries.get(-2006)!.automaticMessage!;
  assert.equal(saved.status, "error");
  assert.equal(saved.enabled, false);
  assert.match(saved.lastError ?? "", /file_id/u);
});

test("rechaza tipo de contenido desconocido", async () => {
  const entries = new Map([
    [-2007, groupData(config({
      type: "sticker" as unknown as AutomaticMessageConfig["type"],
      fileId: "STICKER_ID",
    }))],
  ]);
  const { result, sent } = await sendOne(entries, -2007);
  assert.equal(result.ok, false);
  assert.equal(sent.length, 0);
  const saved = entries.get(-2007)!.automaticMessage!;
  assert.equal(saved.status, "error");
  assert.equal(saved.enabled, false);
  assert.match(saved.lastError ?? "", /desconocido/u);
});

test("los registros antiguos sin type se publican como texto", async () => {
  const entries = new Map([
    [-2008, groupData(config({ message: "Mensaje heredado" }))],
  ]);
  const { result, sent } = await sendOne(entries, -2008);
  assert.ok(result.ok);
  assert.deepEqual(sent[0], {
    kind: "sendMessage",
    chatId: -2008,
    text: "Mensaje heredado",
    entities: undefined,
  });
});

test("un error de Telegram al enviar foto desactiva y no se considera publicada", async () => {
  const entries = new Map([
    [-2009, groupData(config({ type: "photo", fileId: "PHOTO_ID_3", lastMessageId: 555 }))],
  ]);
  const { result, sent } = await sendOne(entries, -2009, {
    async sendPhoto() {
      throw Object.assign(new Error("Bad Request"), {
        error_code: 400,
        description: "Bad Request: file_id is invalid",
      });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(sent.length, 0);
  const saved = entries.get(-2009)!.automaticMessage!;
  assert.equal(saved.status, "error");
  assert.equal(saved.enabled, false);
  assert.equal(saved.consecutiveFailures, 1);
  assert.match(saved.lastError ?? "", /400/u);
  assert.equal(saved.history?.[0]?.status, "error");
});

test("no elimina el mensaje anterior cuando falla el envío nuevo", async () => {
  const entries = new Map([
    [-2010, groupData(config({ type: "video", fileId: "VIDEO_ID_3", lastMessageId: 777 }))],
  ]);
  const { result, deleted } = await sendOne(entries, -2010, {
    async sendVideo() {
      throw Object.assign(new Error("Forbidden"), {
        error_code: 403,
        description: "Forbidden: bot was kicked",
      });
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(deleted, []);
  assert.equal(entries.get(-2010)!.automaticMessage!.lastMessageId, 777);
});

test("el scheduler no duplica la publicación programada de un medio", async () => {
  const entries = new Map([
    [-2011, groupData(config({
      type: "photo",
      fileId: "PHOTO_ID_4",
      nextRunAt: new Date(NOW + 60_000).toISOString(),
    }))],
  ]);
  const { scheduler, api, sent } = createHarness(entries);
  scheduler.start(api);
  await waitForStartup();
  entries.get(-2011)!.automaticMessage!.nextRunAt = new Date(NOW - 1).toISOString();
  await scheduler.processDueNow();
  assert.equal(sent.length, 1);
  await scheduler.processDueNow();
  assert.equal(sent.length, 1);
  scheduler.stop();
});

test("conserva historial y programación tras publicar una foto", async () => {
  const entries = new Map([
    [-2012, groupData(config({ type: "photo", fileId: "PHOTO_ID_5", caption: "c" }))],
  ]);
  const { result, sent } = await sendOne(entries, -2012);
  assert.ok(result.ok);
  assert.equal(sent.length, 1);
  const saved = entries.get(-2012)!.automaticMessage!;
  assert.equal(saved.status, "sent");
  assert.equal(saved.attemptCount, 1);
  assert.equal(saved.lastMessageId, 1);
  assert.equal(saved.lastSentAt, new Date(NOW).toISOString());
  assert.equal(saved.nextRunAt, new Date(NOW + 60 * 60_000).toISOString());
  assert.equal(saved.consecutiveFailures, 0);
  assert.deepEqual(saved.history, [
    { at: new Date(NOW).toISOString(), status: "sent", messageId: 1 },
  ]);
});