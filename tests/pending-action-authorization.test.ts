import assert from "node:assert/strict";
import test from "node:test";
import type { MyContext } from "../src/types.js";

process.env.OWNER_ID = "900000101";
process.env.ALEXIITA_TELEGRAM_ID = "900000102";
process.env.SYSTEM_OWNER_BOOTSTRAP_ID = "900000103";
process.env.SUPABASE_URL = "https://sessions-test.supabase.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

globalThis.fetch = (async () =>
  new Response("[]", {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

const { privateInput } = await import("../src/commands/private-input.js");

test("a restored pending action is rejected when Telegram no longer grants group admin rights", async () => {
  const replies: string[] = [];
  let memberChecks = 0;
  const user = { id: 900000101, is_bot: false, first_name: "Admin" };
  const message = {
    message_id: 1,
    date: 1,
    text: "mensaje de prueba",
    from: user,
    chat: { id: user.id, type: "private" as const },
  };
  const context = {
    update: { update_id: 1, message },
    message,
    chat: message.chat,
    from: user,
    me: { id: 900000999, is_bot: true, first_name: "ZEUS" },
    session: {
      user: {
        pendingAction: { kind: "automaticMessage", groupId: -100900101 },
      },
      group: {},
    },
    api: {
      getChatMember: async () => {
        memberChecks += 1;
        return { status: "member" };
      },
    },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: replies.length };
    },
  } as unknown as MyContext;

  await privateInput.middleware()(context, async () => undefined);

  assert.equal(memberChecks, 1);
  assert.equal(context.session.user.pendingAction, undefined);
  assert.ok(replies.some((reply) => reply.includes("Ya no eres administrador")));
});
