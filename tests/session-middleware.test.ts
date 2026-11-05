import assert from "node:assert/strict";
import test from "node:test";
import type { MyContext } from "../src/types.js";
import { UserSessionPersistenceError } from "../src/services/user-session-storage.js";

process.env.SUPABASE_URL = "https://sessions-middleware.supabase.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

globalThis.fetch = (async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes("zeus_read_user_session")) {
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({
    code: "08006",
    message: "database unavailable",
  }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const { sessionMiddleware } = await import("../src/middleware/session.js");

test("session write failures are notified and propagated instead of being silently accepted", async () => {
  const replies: string[] = [];
  let handlerRan = false;
  const user = { id: 900000201, is_bot: false, first_name: "User" };
  const chat = { id: user.id, type: "private" as const };
  const message = {
    message_id: 1,
    date: 1,
    text: "/menu",
    from: user,
    chat,
  };
  const context = {
    update: { update_id: 1, message },
    message,
    chat,
    from: user,
    me: { id: 900000202, is_bot: true, first_name: "ZEUS" },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: replies.length };
    },
    api: {},
  } as unknown as MyContext;

  await assert.rejects(
    async () => sessionMiddleware(context, async () => {
      handlerRan = true;
      context.session.user.pendingAction = {
        kind: "automaticMessage",
        groupId: -100900201,
      };
    }),
    (error: unknown) =>
      error instanceof UserSessionPersistenceError &&
      error.operation === "write" &&
      error.reason === "unavailable",
  );

  assert.equal(handlerRan, true);
  assert.equal(replies.length, 1);
  assert.match(replies[0] ?? "", /No se pudo guardar o recuperar/u);
  assert.match(replies[0] ?? "", /no se considera persistida/u);
});
