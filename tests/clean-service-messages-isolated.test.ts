import assert from "node:assert/strict";
import test from "node:test";
import { cleanTelegramServiceMessage } from "../src/commands/clean-service-messages.js";

/**
 * Pruebas aisladas del limpiador de mensajes de servicio (sin datos reales,
 * sin red y sin tocar el archivo del módulo, que pertenece a una tarea
 * concurrente). El ctx se inyecta con un api falso que solo registra.
 */

interface FakeCtx {
  chat: { id: number; type: string };
  message: {
    message_id: number;
    new_chat_members?: unknown[];
    user_shared?: unknown;
    users_shared?: unknown;
    connected_website?: string;
    community_chat_joined?: unknown;
    new_chat_title?: string;
    text?: string;
    photo?: unknown[];
  };
  api: { deleteMessage(chatId: number | string, messageId: number): Promise<unknown> };
}

function ctxWith(
  partial: Partial<FakeCtx> & Pick<FakeCtx, "chat" | "message">,
): FakeCtx & { deletions: Array<[number | string, number]> } {
  const deletions: Array<[number | string, number]> = [];
  return {
    ...partial,
    deletions,
    api: {
      async deleteMessage(chatId, messageId) {
        deletions.push([chatId, messageId]);
        return true;
      },
    },
  };
}

test("deletes the join service message in groups and continues the chain", async () => {
  const ctx = ctxWith({
    chat: { id: -1001, type: "supergroup" },
    message: { message_id: 55, new_chat_members: [{ id: 1, is_bot: false }] },
  });
  let nextCalls = 0;
  await cleanTelegramServiceMessage(ctx as never, async () => {
    nextCalls += 1;
  });
  assert.deepEqual(ctx.deletions, [[-1001, 55]]);
  assert.equal(nextCalls, 1);
});

test("deletes community join service messages in groups", async () => {
  const ctx = ctxWith({
    chat: { id: -1001, type: "group" },
    message: { message_id: 56, community_chat_joined: { user_id: 9 } },
  });
  await cleanTelegramServiceMessage(ctx as never, async () => undefined);
  assert.deepEqual(ctx.deletions, [[-1001, 56]]);
});

test("never deletes in private chats and always continues the chain", async () => {
  const ctx = ctxWith({
    chat: { id: 777, type: "private" },
    message: { message_id: 10, new_chat_members: [{ id: 2, is_bot: false }] },
  });
  let nextCalls = 0;
  await cleanTelegramServiceMessage(ctx as never, async () => {
    nextCalls += 1;
  });
  assert.deepEqual(ctx.deletions, []);
  assert.equal(nextCalls, 1);
});

test("does not delete normal messages that only carry text", async () => {
  const ctx = ctxWith({
    chat: { id: -1001, type: "supergroup" },
    message: { message_id: 11, text: "hola a todos" },
  });
  await cleanTelegramServiceMessage(ctx as never, async () => undefined);
  assert.deepEqual(ctx.deletions, []);
});

test("does not delete service messages with an empty member list", async () => {
  const ctx = ctxWith({
    chat: { id: -1001, type: "supergroup" },
    message: { message_id: 12, new_chat_members: [] },
  });
  await cleanTelegramServiceMessage(ctx as never, async () => undefined);
  assert.deepEqual(ctx.deletions, []);
});

test("a failing deleteMessage does not break the chain and reports once without retries", async () => {
  let deleteCalls = 0;
  const reports: Array<{ chatId: number; messageId: number; code: unknown }> = [];
  const ctx: FakeCtx = {
    chat: { id: -1001, type: "supergroup" },
    message: { message_id: 13, new_chat_members: [{ id: 3, is_bot: false }] },
    api: {
      async deleteMessage() {
        deleteCalls += 1;
        const error = new Error("Forbidden: bot was kicked") as Error & Record<string, unknown>;
        error.error_code = 403;
        throw error;
      },
    },
  };
  let nextCalls = 0;
  await cleanTelegramServiceMessage(
    ctx as never,
    async () => {
      nextCalls += 1;
    },
    (chatId, messageId, error) => {
      reports.push({ chatId, messageId, code: (error as { error_code?: number }).error_code });
    },
  );
  assert.equal(deleteCalls, 1);
  assert.equal(nextCalls, 1);
  assert.deepEqual(reports, [{ chatId: -1001, messageId: 13, code: 403 }]);
});

test("a 429 on deleteMessage is retried with backoff", async () => {
  let deleteCalls = 0;
  const reports: unknown[] = [];
  const delays: number[] = [];
  const ctx: FakeCtx = {
    chat: { id: -1001, type: "supergroup" },
    message: { message_id: 14, new_chat_members: [{ id: 4, is_bot: false }] },
    api: {
      async deleteMessage() {
        deleteCalls += 1;
        if (deleteCalls === 1) {
          const error = new Error("Too Many Requests") as Error & Record<string, unknown>;
          error.error_code = 429;
          error.parameters = { retry_after: 17 };
          throw error;
        }
        return true;
      },
    },
  };
  await cleanTelegramServiceMessage(
    ctx as never,
    async () => undefined,
    (chatId, messageId, error) => {
      reports.push([chatId, messageId, (error as { error_code?: number }).error_code]);
    },
    async (delay) => {
      delays.push(delay);
    },
  );
  assert.equal(deleteCalls, 2);
  assert.deepEqual(delays, [17_000]);
  assert.deepEqual(reports, []);
});