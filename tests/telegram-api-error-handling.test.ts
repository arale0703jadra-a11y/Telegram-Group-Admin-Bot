import assert from "node:assert/strict";
import test from "node:test";
import { deleteMessageById } from "../src/moderation/actions.js";
import { cleanTelegramServiceMessage } from "../src/commands/clean-service-messages.js";
import { notifyAdminsForReview } from "../src/filters/illegal-moderation.js";

function telegramError(code: number, description = "telegram error"): Error {
  return Object.assign(new Error(description), { error_code: code, description });
}

test("deleteMessageById trata telegram_400 (mensaje ya borrado) como éxito", async () => {
  const ctx = {
    api: {
      deleteMessage: async () => {
        throw telegramError(400, "message to delete not found");
      },
    },
  };
  const result = await deleteMessageById(ctx as never, -100123, 5);
  assert.equal(result.ok, true);
});

test("deleteMessageById informa error ante 403 (sin permisos)", async () => {
  const ctx = {
    api: {
      deleteMessage: async () => {
        throw telegramError(403, "Forbidden");
      },
    },
  };
  const result = await deleteMessageById(ctx as never, -100123, 5);
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("cleanTelegramServiceMessage no reporta telegram_400 (mensaje ya borrado)", async () => {
  const failures: unknown[] = [];
  const ctx = {
    chat: { id: -100123, type: "supergroup" },
    message: { message_id: 82, new_chat_members: [{ id: 1, first_name: "A" }] },
    api: {
      deleteMessage: async () => {
        throw telegramError(400, "message to delete not found");
      },
    },
  };
  await cleanTelegramServiceMessage(
    ctx as never,
    async () => {},
    (_chatId, _messageId, error) => failures.push(error),
    async () => {},
  );
  assert.equal(failures.length, 0);
});

test("cleanTelegramServiceMessage reporta fallos distintos de 400", async () => {
  const failures: unknown[] = [];
  const ctx = {
    chat: { id: -100123, type: "supergroup" },
    message: { message_id: 82, new_chat_members: [{ id: 1, first_name: "A" }] },
    api: {
      deleteMessage: async () => {
        throw telegramError(403, "Forbidden");
      },
    },
  };
  await cleanTelegramServiceMessage(
    ctx as never,
    async () => {},
    (_chatId, _messageId, error) => failures.push(error),
    async () => {},
  );
  assert.equal(failures.length, 1);
});

test("notifyAdminsForReview omite administradores que bloquearon el bot (403)", async () => {
  const ctx = {
    api: {
      getChatAdministrators: async () => [{ user: { id: 111, is_bot: false } }],
      sendMessage: async () => {
        throw telegramError(403, "bot was blocked by the user");
      },
    },
  };
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => warns.push(String(message));
  try {
    await notifyAdminsForReview(ctx as never, -100123, 82, "unclassified", "high");
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warns.length, 1);
  assert.match(warns[0], /Alerta omitida/);
});

test("notifyAdminsForReview clasifica chat no encontrado como destinatario no disponible", async () => {
  const ctx = {
    api: {
      getChatAdministrators: async () => [{ user: { id: 111, is_bot: false } }],
      sendMessage: async () => {
        throw telegramError(400, "Bad Request: chat not found");
      },
    },
  };
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => warns.push(String(message));
  try {
    await notifyAdminsForReview(ctx as never, -100, 7, "c", "high");
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warns.length, 1);
  assert.match(warns[0], /destinatario no disponible/);
});

test("notifyAdminsForReview conserva el diagnóstico ante un 400 de formato", async () => {
  const ctx = {
    api: {
      getChatAdministrators: async () => [{ user: { id: 111, is_bot: false } }],
      sendMessage: async () => {
        throw telegramError(400, "Bad Request: message text is empty");
      },
    },
  };
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => warns.push(String(message));
  try {
    await notifyAdminsForReview(ctx as never, -100, 7, "c", "high");
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warns.length, 1);
  assert.match(warns[0], /No se pudo enviar alerta/);
  assert.match(warns[0], /message text is empty/);
});

test("notifyAdminsForReview no bloquea a otros administradores ante un bloqueo", async () => {
  const sentIds: number[] = [];
  const ctx = {
    api: {
      getChatAdministrators: async () => [
        { user: { id: 111, is_bot: false } },
        { user: { id: 222, is_bot: false } },
      ],
      sendMessage: async (userId: number) => {
        sentIds.push(userId);
        if (userId === 111) throw telegramError(403, "bot was blocked by the user");
        return {};
      },
    },
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await notifyAdminsForReview(ctx as never, -100, 7, "c", "high");
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(sentIds, [111, 222]);
});

test("deleteMessageById NO trata como benigno un 400 no relacionado con mensaje inexistente", async () => {
  const ctx = {
    api: {
      deleteMessage: async () => {
        throw telegramError(400, "Bad Request: message can't be deleted");
      },
    },
  };
  const result = await deleteMessageById(ctx as never, -100, 5);
  assert.equal(result.ok, false);
});

test("cleanTelegramServiceMessage reporta un 400 no relacionado con mensaje inexistente", async () => {
  const failures: unknown[] = [];
  const ctx = {
    chat: { id: -100123, type: "supergroup" },
    message: { message_id: 82, new_chat_members: [{ id: 1, first_name: "A" }] },
    api: {
      deleteMessage: async () => {
        throw telegramError(400, "Bad Request: message can't be deleted");
      },
    },
  };
  await cleanTelegramServiceMessage(
    ctx as never,
    async () => {},
    (_chatId, _messageId, error) => failures.push(error),
    async () => {},
  );
  assert.equal(failures.length, 1);
});